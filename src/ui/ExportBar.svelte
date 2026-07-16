<script lang="ts">
  import { app } from "./state.svelte.ts";
  import { repo } from "../store/repo.ts";
  import { formatMoney, safeAmount } from "../util/money.ts";
  import { perDiemAmount, safePerDiemDays } from "../util/perdiem.ts";
  import { formatMonthList, normalizeMonths, phoneServiceAmount } from "../util/phone.ts";
  import { PHONE_SERVICE_MONTHLY_USD } from "../config/constants.ts";
  import {
    findByName,
    findByNumber,
    listSavedJobs,
    pairSaved,
    saveJobPair,
    type SavedJob,
  } from "../store/jobs.ts";
  import { oneDriveConfigured } from "../onedrive/store.ts";
  import { ensureConnected, uploadReport } from "../onedrive/index.ts";
  import type { PerDiem, PhoneService } from "../types.ts";

  // The output is the point: batch meta + one-click themed workbook / CSV.

  let employee = $state("");
  let jobName = $state("");
  let jobNumber = $state("");
  // Allowance options: flat amounts added to the report on top of the
  // receipts. Values persist on the batch even while toggled off.
  let pdEnabled = $state(false);
  let pdRate = $state<number | undefined>(undefined);
  let pdDays = $state<number | undefined>(undefined);
  // Phone service: fixed monthly rate × the months picked below.
  let phEnabled = $state(false);
  let phMonths = $state<string[]>([]);
  /** Year shown by the month picker — step freely, any year works. */
  let phYear = $state(new Date().getFullYear());
  let seededBatch: string | null = null;
  let building = $state(false);

  $effect(() => {
    const b = app.batch;
    if (!b || b.id === seededBatch) return;
    seededBatch = b.id;
    employee = b.employee;
    jobName = b.jobName;
    jobNumber = b.jobNumber;
    pdEnabled = b.perDiem?.enabled ?? false;
    pdRate = b.perDiem?.rate || undefined;
    pdDays = b.perDiem?.days || undefined;
    phEnabled = b.phoneService?.enabled ?? false;
    phMonths = normalizeMonths(b.phoneService?.months);
    if (phMonths.length) phYear = Number(phMonths[phMonths.length - 1]!.slice(0, 4));
  });

  /** Plain object (no $state proxies) — safe for the IndexedDB write. */
  function currentPerDiem(): PerDiem {
    return {
      enabled: pdEnabled,
      rate: safeAmount(Number(pdRate) || 0),
      days: safePerDiemDays(Number(pdDays) || 0),
    };
  }

  /** Same rule: fresh array of primitives, nothing reactive leaks through. */
  function currentPhoneService(): PhoneService {
    return { enabled: phEnabled, months: normalizeMonths(phMonths) };
  }

  async function saveMeta(): Promise<void> {
    if (!app.batch) return;
    await repo.updateBatch(app.batch.id, {
      employee,
      jobName,
      jobNumber,
      perDiem: currentPerDiem(),
      phoneService: currentPhoneService(),
    });
  }

  // ---- Saved jobs: name ⇄ number always travel as a pair ------------------
  let jobs = $state<SavedJob[]>([]);
  void listSavedJobs().then((j) => (jobs = j));

  /** Typing/picking a saved job name fills its number, and vice versa. */
  function onJobName(): void {
    const hit = findByName(jobs, jobName);
    if (hit) jobNumber = hit.number;
  }
  function onJobNumber(): void {
    const hit = findByNumber(jobs, jobNumber);
    if (hit) jobName = hit.name;
  }

  const jobPairSaved = $derived(pairSaved(jobs, jobName, jobNumber));
  const canSaveJob = $derived(
    jobName.trim().length > 0 && jobNumber.trim().length > 0 && !jobPairSaved,
  );

  async function saveCurrentJob(): Promise<void> {
    jobs = await saveJobPair(jobName, jobNumber);
    app.toast(`Saved job "${jobName.trim()}" — it will autofill from now on.`, "ok");
  }

  // ---- Month picker (phone service) ----------------------------------------
  const MONTH_ABBR = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  function onPhoneToggle(): void {
    // Reopen the picker where the user left off.
    if (phEnabled && phMonths.length) {
      phYear = Number(phMonths[phMonths.length - 1]!.slice(0, 4));
    }
    void saveMeta();
  }

  function toggleMonth(m: string): void {
    phMonths = phMonths.includes(m)
      ? phMonths.filter((x) => x !== m)
      : [...phMonths, m].sort();
    void saveMeta();
  }

  // ---- Insights sheet (opt-in, remembered across batches) ------------------
  const INSIGHTS_KEY = "report.insights";
  let includeInsights = $state(false);
  void repo.getSetting<boolean>(INSIGHTS_KEY).then((v) => (includeInsights = v === true));
  function saveInsightsPref(): void {
    void repo.setSetting(INSIGHTS_KEY, includeInsights);
  }

  const exportable = $derived(
    app.receipts.filter(
      (r) => r.status !== "failed" && safeAmount(r.amount.value) > 0,
    ),
  );
  const flagged = $derived(
    app.receipts.filter((r) => r.reviewRequired && !r.approved),
  );
  const totalAmount = $derived(
    exportable.reduce((s, r) => s + safeAmount(r.amount.value), 0),
  );
  const pdAmount = $derived(perDiemAmount(currentPerDiem()));
  const phAmount = $derived(phoneServiceAmount(currentPhoneService()));
  /** An allowances-only report (no receipts) is still a real reimbursement. */
  const nothingToExport = $derived(
    exportable.length === 0 && pdAmount === 0 && phAmount === 0,
  );

  let zipping = $state(false);

  async function exportImagesZip(): Promise<void> {
    if (!app.batch || zipping) return;
    zipping = true;
    try {
      const { buildZip } = await import("../export/zip.ts");
      const { thumbnail } = await import("../export/images.ts");
      const entries: { name: string; data: Uint8Array }[] = [];
      const used = new Set<string>();
      for (const r of exportable) {
        const blob = await repo.getBlob(r.annotatedKey ?? r.cleanedKey ?? r.fileKey);
        if (!blob) continue;
        // Recompress for the archive; originals stay untouched in the app.
        const t = await thumbnail(blob, 1400, 0.72);
        const base = r.fileName.replace(/\.[a-z0-9]{2,5}$/i, "") || "receipt";
        let name = `${base}.jpg`;
        for (let i = 2; used.has(name); i++) name = `${base}_${i}.jpg`;
        used.add(name);
        entries.push({ name, data: new Uint8Array(t.buffer) });
      }
      if (entries.length === 0) {
        app.toast("No receipt images to package.", "warn");
        return;
      }
      const zip = await buildZip(entries);
      const employee = (app.batch.employee || "Employee").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_");
      const now = new Date();
      // Local date, matching the workbook's filename stamp (UTC drifted a day).
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
      download(zip, `Receipts_${employee}_${stamp}.zip`);
      app.toast(`Packaged ${entries.length} receipt images.`, "ok");
    } catch (err) {
      app.toast(err instanceof Error ? err.message : "Couldn't build the archive.", "err");
    } finally {
      zipping = false;
    }
  }

  function download(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  /** Build the workbook from the saved batch — shared by the download
   *  button and the OneDrive save. Lazy: ExcelJS + Chart.js only load when
   *  a report is actually built. */
  async function buildReport(): Promise<
    import("../export/workbook.ts").ExportResult
  > {
    await saveMeta();
    const { buildWorkbook } = await import("../export/workbook.ts");
    const batch = (await repo.getBatch(app.batch!.id)) ?? app.batch!;
    return buildWorkbook(batch, app.receipts, (k) => repo.getBlob(k), {
      insights: includeInsights,
    });
  }

  async function generate(): Promise<void> {
    if (!app.batch || building) return;
    building = true;
    try {
      const result = await buildReport();
      download(result.blob, result.fileName);
      app.toast(`Workbook ready: ${result.count} receipts.`, "ok");
    } catch (err) {
      app.toast(
        `Export failed: ${err instanceof Error ? err.message : String(err)}`,
        "err",
      );
    } finally {
      building = false;
    }
  }

  // ---- Save to OneDrive (only rendered when the build is configured) ------
  const oneDriveOn = oneDriveConfigured();
  let odSaving = $state(false);

  async function saveToOneDrive(): Promise<void> {
    if (!app.batch || odSaving || building) return;
    odSaving = true;
    try {
      // Connect FIRST — the sign-in popup must open inside this click's
      // user gesture; building the workbook takes seconds.
      await ensureConnected();
      const result = await buildReport();
      const saved = await uploadReport(result.fileName, result.blob);
      app.toast(`Saved to OneDrive: ${saved.path}`, "ok");
    } catch (err) {
      app.toast(
        err instanceof Error ? err.message : "Couldn't save to OneDrive.",
        "err",
      );
    } finally {
      odSaving = false;
    }
  }

  async function exportCsvFile(): Promise<void> {
    const { toCsv, csvFileName } = await import("../export/csv.ts");
    const csv = toCsv(app.receipts);
    // UTF-8 BOM so Excel opens it cleanly.
    const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
    download(blob, csvFileName({ jobName, employee }));
  }

  function reviewAll(): void {
    const first = flagged[0] ?? app.receipts[0];
    if (first) app.reviewId = first.id;
  }
</script>

<section class="bar card" aria-label="Report">
  <div class="meta">
    <div class="f">
      <label for="xb-emp">Employee</label>
      <input id="xb-emp" type="text" bind:value={employee} onchange={saveMeta} placeholder="Your name" />
    </div>
    <div class="f">
      <label for="xb-job">Job name</label>
      <input
        id="xb-job"
        type="text"
        list="xb-job-names"
        bind:value={jobName}
        oninput={onJobName}
        onchange={saveMeta}
        placeholder="Project / trip"
      />
    </div>
    <div class="f">
      <label for="xb-num">Job number</label>
      <input
        id="xb-num"
        type="text"
        list="xb-job-numbers"
        bind:value={jobNumber}
        oninput={onJobNumber}
        onchange={saveMeta}
        placeholder="Optional"
      />
    </div>
    <div class="jobsave">
      {#if canSaveJob}
        <button
          class="btn btn-ghost btn-sm"
          onclick={() => void saveCurrentJob()}
          title="Remember this job name + number pair; either one autofills the other"
        >
          ☆ Save job
        </button>
      {:else if jobPairSaved}
        <span class="chip" title="This pair autofills — either field completes the other">★ saved job</span>
      {/if}
    </div>
    <datalist id="xb-job-names">
      {#each jobs as j (j.name)}<option value={j.name}></option>{/each}
    </datalist>
    <datalist id="xb-job-numbers">
      {#each jobs as j (j.name)}<option value={j.number}>{j.name}</option>{/each}
    </datalist>
  </div>

  <div class="opts">
    <div class="opt" class:open={pdEnabled}>
      <label class="check">
        <input type="checkbox" bind:checked={pdEnabled} onchange={saveMeta} />
        <span>Per diem</span>
      </label>
      {#if pdEnabled}
        <div class="pd-grid">
          <div class="f">
            <label for="xb-pd-rate">$ per day</label>
            <input
              id="xb-pd-rate"
              type="number"
              min="0"
              step="0.01"
              inputmode="decimal"
              placeholder="75.00"
              bind:value={pdRate}
              onchange={saveMeta}
            />
          </div>
          <div class="f">
            <label for="xb-pd-days">Days</label>
            <input
              id="xb-pd-days"
              type="number"
              min="0"
              step="1"
              inputmode="decimal"
              placeholder="5"
              bind:value={pdDays}
              onchange={saveMeta}
            />
          </div>
        </div>
        <span class="opt-total muted small" aria-live="polite">
          = {formatMoney(pdAmount)} added to the report
        </span>
      {:else}
        <span class="muted small">A flat daily allowance on top of the receipts.</span>
      {/if}
    </div>

    <div class="opt" class:open={phEnabled}>
      <label class="check">
        <input type="checkbox" bind:checked={phEnabled} onchange={onPhoneToggle} />
        <span>Phone service</span>
      </label>
      {#if phEnabled}
        <div class="ph-year">
          <button
            type="button"
            class="yr-btn"
            onclick={() => (phYear = phYear - 1)}
            aria-label="Previous year"
          >‹</button>
          <strong class="yr-label">{phYear}</strong>
          <button
            type="button"
            class="yr-btn"
            onclick={() => (phYear = phYear + 1)}
            aria-label="Next year"
          >›</button>
        </div>
        <div class="ph-months" role="group" aria-label="Months to reimburse">
          {#each MONTH_ABBR as name, i (name)}
            {@const key = `${phYear}-${String(i + 1).padStart(2, "0")}`}
            <button
              type="button"
              class="month-chip"
              class:on={phMonths.includes(key)}
              aria-pressed={phMonths.includes(key)}
              aria-label={`${name} ${phYear}`}
              onclick={() => toggleMonth(key)}
            >
              {name}
            </button>
          {/each}
        </div>
        <span class="opt-total muted small" aria-live="polite">
          {#if phMonths.length}
            {formatMonthList(phMonths)} — <strong>{formatMoney(phAmount)}</strong>
          {:else}
            Pick any months, any year ({formatMoney(PHONE_SERVICE_MONTHLY_USD)} each).
          {/if}
        </span>
      {:else}
        <span class="muted small">
          Fixed {formatMoney(PHONE_SERVICE_MONTHLY_USD)}/month, for the months you pick.
        </span>
      {/if}
    </div>

    <div class="opt" class:open={includeInsights}>
      <label class="check">
        <input type="checkbox" bind:checked={includeInsights} onchange={saveInsightsPref} />
        <span>Insights sheet</span>
      </label>
      <span class="muted small">
        Adds a KPI + charts dashboard tab to the workbook.
      </span>
    </div>
  </div>

  <div class="actions">
    <div class="sum">
      <strong class="sum-total">{formatMoney(totalAmount + pdAmount + phAmount)}</strong>
      <span class="muted">
        {exportable.length} of {app.receipts.length} receipts{pdAmount > 0
          ? " + per diem"
          : ""}{phAmount > 0 ? " + phone" : ""}
      </span>
    </div>
    {#if flagged.length > 0}
      <button class="btn" onclick={reviewAll}>
        Review flagged ({flagged.length})
      </button>
    {/if}
    <button class="btn btn-ghost" onclick={exportCsvFile} disabled={exportable.length === 0}>
      CSV
    </button>
    <button
      class="btn btn-ghost"
      onclick={() => void exportImagesZip()}
      disabled={zipping || exportable.length === 0}
      title="Download every receipt image, compressed, in one archive"
    >
      {zipping ? "Packaging…" : "Images (.zip)"}
    </button>
    {#if oneDriveOn}
      <button
        class="btn btn-ghost"
        onclick={() => void saveToOneDrive()}
        disabled={odSaving || building || nothingToExport}
        title="Upload the workbook to OneDrive → Apps/DueBack"
      >
        {odSaving ? "Saving…" : "Save to OneDrive"}
      </button>
    {/if}
    <button
      class="btn btn-primary btn-lg"
      onclick={generate}
      disabled={building || odSaving || nothingToExport}
    >
      {building ? "Building…" : "Generate workbook"}
    </button>
  </div>
</section>

<style>
  .bar {
    display: grid;
    gap: 1rem;
    padding: 1.1rem 1.2rem;
  }
  .meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0.8rem;
    align-items: end;
  }
  .jobsave {
    display: flex;
    align-items: center;
    min-height: 2.2rem;
  }

  /* ---- report options: three self-contained cards ---- */
  .opts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 0.8rem;
    align-items: stretch;
  }
  .opt {
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 0.7rem 0.8rem;
    display: grid;
    gap: 0.55rem;
    align-content: start;
  }
  .opt.open {
    border-color: var(--line-strong);
    background: color-mix(in srgb, var(--bg-raised) 60%, transparent);
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font: 550 0.95rem/1.3 var(--font-ui);
    color: var(--ink);
    cursor: pointer;
  }
  .check input {
    width: auto;
    accent-color: var(--accent);
  }
  .pd-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }
  .opt-total {
    font-variant-numeric: tabular-nums;
  }

  /* ---- phone-service month picker: ‹ year › + 12 chips ---- */
  .ph-year {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .yr-btn {
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    background: var(--bg-raised);
    color: var(--ink);
    font: 700 0.95rem/1 var(--font-ui);
    width: 1.7rem;
    height: 1.7rem;
    cursor: pointer;
  }
  .yr-label {
    font: 650 0.95rem/1 var(--font-display);
    font-variant-numeric: tabular-nums;
  }
  .ph-months {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.35rem;
  }
  .month-chip {
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    background: var(--bg-raised);
    color: var(--ink-soft);
    font: 600 0.78rem/1 var(--font-ui);
    padding: 0.4rem 0;
    cursor: pointer;
  }
  .month-chip.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-ink);
  }

  .small {
    font-size: 0.84rem;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    flex-wrap: wrap;
  }
  .sum {
    display: grid;
    line-height: 1.25;
    margin-right: auto;
  }
  .sum-total {
    font: 600 1.25rem/1.2 var(--font-display);
    font-variant-numeric: tabular-nums;
  }
  .sum .muted {
    font-size: 0.84rem;
  }
</style>
