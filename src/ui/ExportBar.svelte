<script lang="ts">
  import { app } from "./state.svelte.ts";
  import { repo } from "../store/repo.ts";
  import { formatMoney, safeAmount } from "../util/money.ts";

  // The output is the point: batch meta + one-click themed workbook / CSV.

  let employee = $state("");
  let jobName = $state("");
  let jobNumber = $state("");
  let seededBatch: string | null = null;
  let building = $state(false);

  $effect(() => {
    const b = app.batch;
    if (!b || b.id === seededBatch) return;
    seededBatch = b.id;
    employee = b.employee;
    jobName = b.jobName;
    jobNumber = b.jobNumber;
  });

  async function saveMeta(): Promise<void> {
    if (!app.batch) return;
    await repo.updateBatch(app.batch.id, { employee, jobName, jobNumber });
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
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
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

  async function generate(): Promise<void> {
    if (!app.batch || building) return;
    building = true;
    try {
      await saveMeta();
      // Lazy: ExcelJS + Chart.js only load when a report is actually built.
      const { buildWorkbook } = await import("../export/workbook.ts");
      const batch = (await repo.getBatch(app.batch.id)) ?? app.batch;
      const result = await buildWorkbook(batch, app.receipts, (k) => repo.getBlob(k));
      download(result.blob, result.fileName);
      app.toast(`Workbook ready — ${result.count} receipts.`, "ok");
    } catch (err) {
      app.toast(
        `Export failed: ${err instanceof Error ? err.message : String(err)}`,
        "err",
      );
    } finally {
      building = false;
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

  <div class="actions">
    <div class="sum">
      <strong class="sum-total">{formatMoney(totalAmount)}</strong>
      <span class="muted">
        {exportable.length} of {app.receipts.length} receipts
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
    <button
      class="btn btn-primary btn-lg"
      onclick={generate}
      disabled={building || exportable.length === 0}
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
