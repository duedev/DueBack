<script lang="ts">
  import { app } from "../state.svelte.ts";
  import { getCorrections, clearCorrections } from "../../train/corrections.ts";
  import type { Receipt } from "../../types.ts";

  let correctionCount = $state(0);
  $effect(() => {
    if (!app.settingsOpen) return;
    void getCorrections().then((r) => (correctionCount = r.length));
  });

  async function resetCorrections(): Promise<void> {
    await clearCorrections();
    correctionCount = 0;
    app.toast("Improvement log cleared.", "ok");
  }

  // One ZIP with everything a tuning session needs (shared with the
  // contact form's attach checkbox) — see src/train/bundle.ts. The
  // corrections log rides inside it as corrections.json — no separate
  // log-only download. The log outlives batches, so the bundle stays
  // available on an empty board while the log has records.
  let bundleBusy = $state(false);
  // Compact (the default) is for SHARING — no originals, highlighted copies
  // re-encoded small — so the ZIP fits an upload or an email. Full keeps
  // every original for an OCR-tuning session that must re-read the inputs.
  let compact = $state(true);
  async function downloadTuningBundle(): Promise<void> {
    bundleBusy = true;
    try {
      const { buildTuningBundle, downloadBundle, formatBytes } = await import("../../train/bundle.ts");
      const bundle = await buildTuningBundle($state.snapshot(app.receipts) as Receipt[], {
        mode: compact ? "compact" : "full",
      });
      downloadBundle(bundle);
      app.toast(
        // The mode that was BUILT (the checkbox can't change mid-build, but
        // the toast still reads the bundle, not the live control).
        `Tuning bundle packaged (${formatBytes(bundle.blob.size)}${bundle.mode === "compact" ? ", compact" : ""}): ` +
          `${bundle.receiptCount} receipts, ${bundle.correctionCount} corrections.` +
          (bundle.mode === "full" && bundle.omittedOriginals > 0
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
    <button
      class="btn btn-primary btn-sm"
      onclick={() => void downloadTuningBundle()}
      disabled={bundleBusy || (app.receipts.length === 0 && correctionCount === 0)}
    >
      {bundleBusy ? "Packaging…" : "Download tuning bundle"}
    </button>
    <button class="btn btn-ghost btn-sm btn-danger" onclick={() => void resetCorrections()} disabled={correctionCount === 0}>
      Clear
    </button>
  </div>
  <label class="check">
    <input type="checkbox" bind:checked={compact} disabled={bundleBusy} />
    <span>Compact (smaller, for sharing)</span>
  </label>
  <p class="muted small">
    The bundle zips the corrections log (corrections.json), every
    receipt's extraction (fields, flags, OCR text and positions), the
    report CSV, and the highlighted images: one file to hand over for
    tuning. Compact leaves out the originals and shrinks the images so it
    fits an upload or an email; untick it to include every original.
  </p>
</section>
