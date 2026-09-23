<script lang="ts">
  import { app } from "../state.svelte.ts";

  // Receipts read before a fix keep their old problems until something
  // re-reads them — and a re-read of a receipt a human already touched is
  // exactly what the pipeline refuses to overwrite. The re-check repairs the
  // two read-time fixes that can be applied from what is already stored
  // (pipeline/recheck.ts): outlines for older AI reads, and duplicate flags
  // the old matching missed. No OCR, no AI call, nothing sent anywhere.

  // Receipts still waiting to be read on this device would be skipped
  // unread (the pipeline owns them until their read lands), so the action
  // waits for the queue to drain.
  const reading = $derived(app.pendingJobs > 0);
  const empty = $derived(app.receipts.length === 0);
  const why = $derived.by(() => {
    if (empty) return "No receipts in this batch yet.";
    if (!reading) return "";
    const n = app.pendingJobs === 1 ? "1 receipt" : `${app.pendingJobs} receipts`;
    return app.paused
      ? `${n} still to read — resume reading, then re-check.`
      : `Waiting for ${n} to finish reading.`;
  });
</script>

<section aria-busy={app.rechecking}>
  <h3>This batch</h3>
  <p class="muted small">
    Receipts added before recent fixes can be brought up to date from what is
    already stored — no re-reading and no AI calls: older AI reads get their
    highlight outlines, and possible duplicates that were missed get
    flagged for review. Values you entered, and receipts you approved, stay
    as they are.
  </p>
  <div class="row">
    <button
      class="btn btn-sm"
      onclick={() => void app.recheckBatch()}
      disabled={app.rechecking || reading || empty}
      aria-describedby={why ? "recheck-why" : undefined}
    >
      {app.rechecking ? "Re-checking…" : "Re-check this batch"}
    </button>
    {#if why}
      <span id="recheck-why" class="muted small">{why}</span>
    {/if}
  </div>
</section>
