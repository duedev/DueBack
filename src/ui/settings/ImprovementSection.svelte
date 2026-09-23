<script lang="ts">
  import { app } from "../state.svelte.ts";
  import { getCorrections, clearCorrections } from "../../train/corrections.ts";
  import type { Receipt } from "../../types.ts";

  let correctionCount = $state(0);
  $effect(() => {
    if (!app.settingsOpen) return;
    void getCorrections().then((r) => (correctionCount = r.length));
  });

  async function downloadCorrections(): Promise<void> {
    const records = await getCorrections();
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dueback_corrections_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    // Deferred like ExportBar's download(): a synchronous revoke can abort
    // the download in Safari.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function resetCorrections(): Promise<void> {
    await clearCorrections();
    correctionCount = 0;
    app.toast("Improvement log cleared.", "ok");
  }

  // One ZIP with everything a tuning session needs (shared with the
  // contact form's attach checkbox) — see src/train/bundle.ts.
  let bundleBusy = $state(false);
  async function downloadTuningBundle(): Promise<void> {
    bundleBusy = true;
    try {
      const { buildTuningBundle, downloadBundle } = await import("../../train/bundle.ts");
      const bundle = await buildTuningBundle($state.snapshot(app.receipts) as Receipt[]);
      downloadBundle(bundle);
      app.toast(
        `Tuning bundle packaged: ${bundle.receiptCount} receipts, ${bundle.correctionCount} corrections.` +
          (bundle.omittedOriginals > 0
            ? ` ${bundle.omittedOriginals} originals were left out to keep it under 200 MB.`
            : ""),
        "ok",
      );
    } catch (err) {
      app.toast(err instanceof Error ? err.message : "Couldn't build the bundle.", "err");
    } finally {
      bundleBusy = false;
    }
  }
</script>

<section>
  <h3>Improvement log</h3>
  <p class="muted small">
    Every correction you make in review is recorded with where the
    right value sits on the receipt and what the reader believed
    beforehand. Download the tuning bundle below — the log plus every
    receipt's extraction and images — to tune extraction against your
    real receipts. Stays on this device.
  </p>
  <div class="row">
    <span class="chip">{correctionCount} corrections</span>
    <button class="btn btn-primary btn-sm" onclick={() => void downloadTuningBundle()} disabled={bundleBusy || app.receipts.length === 0}>
      {bundleBusy ? "Packaging…" : "Download tuning bundle"}
    </button>
    <button class="btn btn-sm" onclick={() => void downloadCorrections()} disabled={correctionCount === 0}>
      Corrections JSON
    </button>
    <button class="btn btn-ghost btn-sm btn-danger" onclick={() => void resetCorrections()} disabled={correctionCount === 0}>
      Clear
    </button>
  </div>
  <p class="muted small">
    The bundle zips the corrections log, every receipt's extraction
    (fields, flags, OCR text and positions), the report CSV, and the
    original + highlighted images: one file to hand over for tuning.
  </p>
</section>
