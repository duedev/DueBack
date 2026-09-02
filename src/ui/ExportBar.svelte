<script lang="ts">
  import { app } from "./state.svelte.ts";
  import { repo } from "../store/repo.ts";
  import { displayCategory, exportableReceipts, reportOrder } from "../export/order.ts";
  import { employeeFilePart } from "../util/rename.ts";
  import { formatMoney, safeAmount } from "../util/money.ts";
  import { perDiemAmount, safePerDiemDays } from "../util/perdiem.ts";
  import {
    formatMonthList,
    normalizeMonths,
    phoneServiceAmount,
    phoneServiceRate,
  } from "../util/phone.ts";
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
  // Phone service: a monthly rate (adjustable, defaults to the constant) ×
  // the months picked below.
  let phEnabled = $state(false);
  let phMonths = $state<string[]>([]);
  let phRate = $state<number | undefined>(undefined);
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
    // A batch saved before the rate was adjustable has none — show the
    // default it has been reimbursing at all along.
    phRate = phoneServiceRate(b.phoneService);
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

  /** Same rule: fresh array of primitives, nothing reactive leaks through.
   *  An emptied rate field falls back to the default rather than to $0. */
  function currentPhoneService(): PhoneService {
    return {
      enabled: phEnabled,
      months: normalizeMonths(phMonths),
      rate: phoneServiceRate({
        enabled: phEnabled,
        months: [],
        rate: phRate === undefined || phRate === null ? undefined : Number(phRate),
      }),
    };
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

  // ---- Insights sheet (on by default, remembered across batches) -----------
  const INSIGHTS_KEY = "report.insights";
  let includeInsights = $state(true);
  void repo.getSetting<boolean>(INSIGHTS_KEY).then((v) => (includeInsights = v !== false));
  function saveInsightsPref(): void {
    void repo.setSetting(INSIGHTS_KEY, includeInsights);
  }

  // ---- Images ZIP (HIDDEN for now — the option card is commented out and
  //      the toggle is forced off; exportImagesZip and kv "report.imagesZip"
  //      stay wired for when it returns, with a saveZipPref like the rest) --
  const includeZip = false;

  // ---- Bundle: zip whatever Generate produces into ONE download ------------
  const BUNDLE_KEY = "report.bundleZip";
  let bundleZip = $state(false);
  void repo.getSetting<boolean>(BUNDLE_KEY).then((v) => (bundleZip = v === true));
  function saveBundlePref(): void {
    void repo.setSetting(BUNDLE_KEY, bundleZip);
  }

  // ---- Print packet (on by default: offices staple paper copies) -----------
  const PRINT_KEY = "report.printPacket";
  let includePrint = $state(true);
  void repo.getSetting<boolean>(PRINT_KEY).then((v) => (includePrint = v !== false));
  function savePrintPref(): void {
    void repo.setSetting(PRINT_KEY, includePrint);
  }

  /** Letter-size PDF of the receipt images — what actually goes to the
   *  office printer. Receipts whose vendor/date/total boxes are all known
   *  (including hand-drawn ones) are cropped to that strip, so several fit
   *  a page; each image carries the batch's job caption (stamped per image,
   *  so a batch may span jobs later without a layout change). */
  async function buildPrintPacket(): Promise<Blob | null> {
    const { buildPrintPdf, receiptStrip } = await import("../export/printPdf.ts");
    const { thumbnail, stripThumbnail } = await import("../export/images.ts");
    const jobLabel = [jobName.trim(), jobNumber.trim() ? `#${jobNumber.trim()}` : ""]
      .filter(Boolean)
      .join(" ");
    const imgs: import("../export/printPdf.ts").PrintImage[] = [];
    // The workbook's own order and numbering (export/order.ts: category
    // sections in taxonomy order, receipts by date then intake, "#n" within
    // the section), so the paper packet reads alongside the Summary.
    let skipped = 0;
    for (const g of reportOrder(app.receipts)) {
      for (const [i, r] of g.rows.entries()) {
        // Per receipt, like the workbook's image loop: one receipt whose
        // image is missing (a failed sync download) or won't decode must
        // not sink the whole packet — or vanish from it silently.
        try {
          const blob = await repo.getBlob(r.annotatedKey ?? r.cleanedKey ?? r.fileKey);
          if (!blob) {
            skipped++;
            continue;
          }
          const strip = receiptStrip([r.vendor.bbox, r.date.bbox, r.amount.bbox]);
          const t = strip
            ? await stripThumbnail(blob, strip.y0, strip.y1, 1400, 0.8)
            : await thumbnail(blob, 1400, 0.8);
          imgs.push({
            jpeg: new Uint8Array(t.buffer),
            width: t.width,
            height: t.height,
            label: `${displayCategory(g.cat)} #${i + 1}`,
            name: r.fileName,
            amount: formatMoney(safeAmount(r.amount.value)),
            ...(jobLabel ? { job: jobLabel } : {}),
          });
        } catch {
          skipped++;
        }
      }
    }
    if (skipped > 0) {
      app.toast(
        `Print packet skipped ${skipped} receipt${skipped === 1 ? "" : "s"} without a readable image.`,
        "warn",
      );
    }
    if (imgs.length === 0) return null;
    const bytes = buildPrintPdf(imgs, { employee });
    return new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" });
  }

  const exportable = $derived(exportableReceipts(app.receipts));
  const flagged = $derived(
    app.receipts.filter((r) => r.reviewRequired && !r.approved),
  );
  const totalAmount = $derived(
    exportable.reduce((s, r) => s + safeAmount(r.amount.value), 0),
  );
  const pdAmount = $derived(perDiemAmount(currentPerDiem()));
  const phAmount = $derived(phoneServiceAmount(currentPhoneService()));
  const phRateValue = $derived(phoneServiceRate(currentPhoneService()));
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
      const employee = employeeFilePart(app.batch.employee);
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

  async function doGenerate(): Promise<void> {
    if (!app.batch || building) return;
    building = true;
    try {
      const result = await buildReport();
      let packet: Blob | null = null;
      if (includePrint) {
        try {
          packet = await buildPrintPacket();
        } catch {
          app.toast("Couldn't build the print packet; the workbook is fine.", "warn");
        }
      }
      const { printPdfFileName } = await import("../export/printPdf.ts");
      if (bundleZip) {
        // One archive holding everything Generate produced.
        const { buildZip } = await import("../export/zip.ts");
        const entries = [
          { name: result.fileName, data: new Uint8Array(await result.blob.arrayBuffer()) },
        ];
        if (packet) {
          entries.push({
            name: printPdfFileName(employee),
            data: new Uint8Array(await packet.arrayBuffer()),
          });
        }
        const zip = await buildZip(entries);
        const who = employeeFilePart(employee);
        const now = new Date();
        const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
        download(zip, `Report_${who}_${stamp}.zip`);
      } else {
        download(result.blob, result.fileName);
        if (packet) download(packet, printPdfFileName(employee));
      }
      if (includeZip) await exportImagesZip();
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

  // A workbook without a name on it is usually an oversight: ask once before
  // building when any header field is blank, with a way to proceed anyway.
  let blankConfirmOpen = $state(false);
  const blankFields = $derived(
    [
      !employee.trim() && "Employee",
      !jobName.trim() && "Job name",
      !jobNumber.trim() && "Job number",
    ].filter((f): f is string => typeof f === "string"),
  );

  function generate(): void {
    if (blankFields.length > 0) blankConfirmOpen = true;
    else void doGenerate();
  }

  function confirmBlank(proceed: boolean): void {
    blankConfirmOpen = false;
    if (proceed) void doGenerate();
  }

  // Focus management for the confirm (role=dialog + aria-modal promise it):
  // focus moves into the dialog on open, Escape cancels, Tab cycles its two
  // buttons instead of walking the page behind the scrim, and focus returns
  // to the Generate button on close.
  let confirmEl = $state<HTMLElement | null>(null);
  $effect(() => {
    const el = confirmEl;
    if (!el) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.focus();
    return () => prev?.focus();
  });
  function onConfirmKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      confirmBlank(false);
      return;
    }
    if (e.key !== "Tab" || !confirmEl) return;
    const buttons = Array.from(confirmEl.querySelectorAll<HTMLElement>("button:not([disabled])"));
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === confirmEl)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
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
      // The print packet goes up beside the workbook (two browsable files,
      // never a ZIP) — the download path ships both, so the cloud path
      // should not silently leave the paper half behind. Seconds after
      // ensureConnected, so the second upload reuses the stored token and
      // can never need a popup outside the click.
      let packetNote = "";
      if (includePrint) {
        try {
          const packet = await buildPrintPacket();
          if (packet) {
            const { printPdfFileName } = await import("../export/printPdf.ts");
            await uploadReport(printPdfFileName(employee), packet);
            packetNote = " (+ print packet)";
          }
        } catch {
          app.toast("Workbook saved; the print packet couldn't be built or uploaded.", "warn");
        }
      }
      app.toast(`Saved to OneDrive: ${saved.path}${packetNote}`, "ok");
    } catch (err) {
      app.toast(
        err instanceof Error ? err.message : "Couldn't save to OneDrive.",
        "err",
      );
    } finally {
      odSaving = false;
    }
  }

  // ---- Preview: the print packet, in the browser, before any download ----
  let previewing = $state(false);
  async function previewPacket(): Promise<void> {
    if (previewing || exportable.length === 0) return;
    // The tab must open synchronously inside the click or popup blockers
    // eat it (the OneDrive lesson); the PDF navigates it when ready.
    const win = window.open("", "_blank");
    previewing = true;
    try {
      await saveMeta();
      const packet = await buildPrintPacket();
      if (!packet) {
        win?.close();
        app.toast("No receipt images to preview yet.", "warn");
        return;
      }
      const url = URL.createObjectURL(packet);
      if (win) win.location.href = url;
      else window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      win?.close();
      app.toast(err instanceof Error ? err.message : "Couldn't build the preview.", "err");
    } finally {
      previewing = false;
    }
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
    <fieldset class="opt-group">
      <legend>Adds to the total</legend>
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
        <div class="f ph-rate">
          <label for="xb-ph-rate">$ per month</label>
          <input
            id="xb-ph-rate"
            type="number"
            min="0"
            step="0.01"
            inputmode="decimal"
            placeholder={String(PHONE_SERVICE_MONTHLY_USD)}
            bind:value={phRate}
            onchange={saveMeta}
          />
        </div>
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
            Pick any months, any year ({formatMoney(phRateValue)} each).
          {/if}
        </span>
      {:else}
        <span class="muted small">
          {formatMoney(phRateValue)}/month (editable), for the months you pick.
        </span>
      {/if}
    </div>
    </fieldset>

    <fieldset class="opt-group">
      <legend>With your download</legend>
    <div class="opt" class:open={includeInsights}>
      <label class="check">
        <input type="checkbox" bind:checked={includeInsights} onchange={saveInsightsPref} />
        <span>Insights sheet</span>
      </label>
      <span class="muted small">
        Adds a KPI + charts dashboard tab to the workbook.
      </span>
    </div>

    <div class="opt" class:open={includePrint}>
      <label class="check">
        <input type="checkbox" bind:checked={includePrint} onchange={savePrintPref} />
        <span>Print packet (PDF)</span>
      </label>
      <span class="muted small">
        Downloads with the workbook: receipts cropped to their key lines and
        packed onto letter pages, labeled per receipt, sized for legible
        printing.
      </span>
    </div>

    <!-- Receipt images (ZIP) is HIDDEN for now (product call) — the wiring
         stays (exportImagesZip + kv report.imagesZip) for when it returns.
    <div class="opt" class:open={includeZip}>
      <label class="check">
        <input type="checkbox" bind:checked={includeZip} onchange={saveZipPref} />
        <span>Receipt images (ZIP)</span>
      </label>
      <span class="muted small">
        Also downloads every receipt image, compressed, in one archive.
      </span>
    </div>
    -->

    <div class="opt" class:open={bundleZip}>
      <label class="check">
        <input type="checkbox" bind:checked={bundleZip} onchange={saveBundlePref} />
        <span>Bundle into one ZIP</span>
      </label>
      <span class="muted small">
        One download instead of several: everything above zipped together.
      </span>
    </div>
    </fieldset>
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
      <button
        class="btn breathe breathe-warn"
        onclick={reviewAll}
        title="Step through every flagged receipt and approve or fix each one"
      >
        Review flagged ({flagged.length})
      </button>
    {/if}
    <button
      class="btn btn-ghost"
      onclick={() => void previewPacket()}
      disabled={previewing || exportable.length === 0}
      title="Open the print packet PDF in a new tab to check it before downloading"
    >
      {previewing ? "Building…" : "Preview packet"}
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
      class:breathe={flagged.length === 0 && !nothingToExport && !building}
      onclick={generate}
      disabled={building || odSaving || nothingToExport}
      title="Build the themed Excel workbook and download it"
    >
      {building ? "Building…" : "Generate workbook"}
    </button>
  </div>

  {#if blankConfirmOpen}
    <div
      class="confirm-scrim"
      role="presentation"
      onclick={(e) => {
        if (e.target === e.currentTarget) confirmBlank(false);
      }}
    >
      <div
        class="confirm card"
        role="dialog"
        aria-modal="true"
        aria-label="Missing report details"
        tabindex="-1"
        bind:this={confirmEl}
        onkeydown={onConfirmKey}
      >
        <h4>Some report details are blank</h4>
        <p class="muted">
          {blankFields.join(", ")} will show empty in the workbook header.
        </p>
        <div class="confirm-actions">
          <button class="btn" onclick={() => confirmBlank(false)}>Go back and fill in</button>
          <button class="btn btn-primary" onclick={() => confirmBlank(true)}>Generate anyway</button>
        </div>
      </div>
    </div>
  {/if}
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

  /* ---- report options: two labeled groups ----
     Allowances CHANGE the reimbursed total; the second group only shapes
     what the download contains. The fieldset border draws that line. */
  .opts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 0.9rem;
    align-items: stretch;
  }
  .opt-group {
    margin: 0;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 0.7rem 0.8rem 0.8rem;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 0.7rem;
    align-content: start;
    min-width: 0;
  }
  .opt-group legend {
    font: 700 0.7rem/1 var(--font-ui);
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--ink-faint);
    padding: 0 0.4rem;
  }
  .opt {
    border: 1px dashed var(--line);
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
    text-transform: none;
    letter-spacing: 0;
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

  /* ---- phone-service rate + month picker: ‹ year › + 12 chips ---- */
  .ph-rate {
    max-width: 10rem;
  }
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

  /* ---- next-action breathing ring ----
     One button at a time invites the next step: Review flagged while any
     receipt is queued for a human, Generate workbook once the board is
     clear. The pulse rests at its 0% frame, so the reduced-motion
     kill-switch (theme.css) freezes it as a plain button. */
  .breathe {
    animation: xb-breathe 2.6s ease-out infinite;
  }
  .breathe-warn {
    animation-name: xb-breathe-warn;
    border-color: var(--gold);
    color: var(--gold-text);
  }
  @keyframes xb-breathe {
    0%,
    100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent);
    }
    55% {
      box-shadow: 0 0 0 9px color-mix(in srgb, var(--accent) 0%, transparent);
    }
  }
  @keyframes xb-breathe-warn {
    0%,
    100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--gold) 50%, transparent);
    }
    55% {
      box-shadow: 0 0 0 9px color-mix(in srgb, var(--gold) 0%, transparent);
    }
  }

  /* ---- blank-details confirm (must fit a phone in any orientation) ---- */
  .confirm-scrim {
    position: fixed;
    inset: 0;
    background: rgb(10 8 6 / 0.55);
    backdrop-filter: blur(3px);
    display: grid;
    place-items: center;
    padding: 1rem;
    z-index: 60;
  }
  .confirm {
    width: min(26rem, 100%);
    max-height: 100%;
    overflow: auto;
    display: grid;
    gap: 0.6rem;
    padding: 1.1rem 1.2rem;
  }
  .confirm h4 {
    margin: 0;
  }
  .confirm p {
    margin: 0;
    font-size: 0.92rem;
  }
  .confirm-actions {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    justify-content: flex-end;
    margin-top: 0.3rem;
  }
</style>
