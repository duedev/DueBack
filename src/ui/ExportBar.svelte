<script lang="ts">
  import { app } from "./state.svelte.ts";
  import { repo } from "../store/repo.ts";
  import { formatMoney, safeAmount } from "../util/money.ts";
  import { perDiemAmount, safePerDiemDays } from "../util/perdiem.ts";
  import { monthLabel, normalizeMonths, phoneServiceAmount } from "../util/phone.ts";
  import { PHONE_SERVICE_MONTHLY_USD } from "../config/constants.ts";
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

  /** Month chips on offer: a rolling last-12-months window, plus any month a
   *  receipt falls in (reports often trail the expenses), plus anything
   *  already selected — so a saved pick never disappears from the row. */
  const monthChoices = $derived.by(() => {
    const set = new Set<string>(phMonths);
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      set.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    for (const r of app.receipts) {
      const m = r.date.value.slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(m)) set.add(m);
    }
    return [...set].sort();
  });

  function toggleMonth(m: string): void {
    phMonths = phMonths.includes(m)
      ? phMonths.filter((x) => x !== m)
      : [...phMonths, m].sort();
    void saveMeta();
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
    return buildWorkbook(batch, app.receipts, (k) => repo.getBlob(k));
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
      <input id="xb-job" type="text" bind:value={jobName} onchange={saveMeta} placeholder="Project / trip" />
    </div>
    <div class="f">
      <label for="xb-num">Job number</label>
      <input id="xb-num" type="text" bind:value={jobNumber} onchange={saveMeta} placeholder="Optional" />
    </div>
  </div>

  <div class="perdiem">
    <label class="check">
      <input type="checkbox" bind:checked={pdEnabled} onchange={saveMeta} />
      <span>Per diem</span>
    </label>
    {#if pdEnabled}
      <div class="f pd-f">
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
      <div class="f pd-f">
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
      <span class="pd-total muted" aria-live="polite">
        = {formatMoney(pdAmount)} added to the report
      </span>
    {:else}
      <span class="muted small">Add a flat daily allowance to the report.</span>
    {/if}
  </div>

  <div class="perdiem">
    <label class="check">
      <input type="checkbox" bind:checked={phEnabled} onchange={saveMeta} />
      <span>Phone service</span>
    </label>
    {#if phEnabled}
      <div class="ph-months" role="group" aria-label="Months to reimburse">
        {#each monthChoices as m (m)}
          <button
            type="button"
            class="month-chip"
            class:on={phMonths.includes(m)}
            aria-pressed={phMonths.includes(m)}
            onclick={() => toggleMonth(m)}
          >
            {monthLabel(m)}
          </button>
        {/each}
      </div>
      <span class="pd-total muted" aria-live="polite">
        {phMonths.length === 0
          ? `Pick the months to reimburse (${formatMoney(PHONE_SERVICE_MONTHLY_USD)}/month).`
          : `= ${formatMoney(phAmount)} added to the report`}
      </span>
    {:else}
      <span class="muted small">
        Add the fixed {formatMoney(PHONE_SERVICE_MONTHLY_USD)}/month phone
        reimbursement.
      </span>
    {/if}
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
  }
  .perdiem {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    flex-wrap: wrap;
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
  .pd-f {
    display: grid;
    gap: 0.25rem;
  }
  .pd-f input {
    max-width: 8.5rem;
  }
  .pd-total {
    font-variant-numeric: tabular-nums;
  }
  .ph-months {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .month-chip {
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    background: var(--bg-raised);
    color: var(--ink-soft);
    font: 600 0.78rem/1 var(--font-ui);
    padding: 0.35rem 0.65rem;
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
