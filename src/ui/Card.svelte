<script lang="ts">
  import { app } from "./state.svelte.ts";
  import { formatMoney } from "../util/money.ts";
  import { formatDate } from "../util/format.ts";
  import type { Receipt } from "../types.ts";

  let { receipt }: { receipt: Receipt } = $props();

  const statusMeta: Record<
    Receipt["status"],
    { label: string; cls: string }
  > = {
    queued: { label: "Queued", cls: "" },
    processing: { label: "Reading…", cls: "" },
    done: { label: "Done", cls: "chip-ok" },
    needs_review: { label: "Review", cls: "chip-warn" },
    failed: { label: "Failed", cls: "chip-err" },
  };

  const meta = $derived(statusMeta[receipt.status]);
  const busy = $derived(
    receipt.status === "queued" || receipt.status === "processing",
  );

  /** What a screen reader hears on focus: status first, then the card's facts. */
  const ariaLabel = $derived.by(() => {
    const status =
      receipt.status === "needs_review" ? "Review needed" : meta.label;
    if (receipt.status === "done" || receipt.status === "needs_review") {
      const amount =
        receipt.amount.value > 0
          ? formatMoney(receipt.amount.value)
          : "no amount";
      const vendor = receipt.vendor.value || "Unknown vendor";
      return `${status} — ${vendor}, ${amount}, ${receipt.fileName}`;
    }
    return `${status} — ${receipt.fileName}`;
  });
</script>

<button
  class="rc card"
  onclick={() => (app.reviewId = receipt.id)}
  aria-label={ariaLabel}
>
  <div class="thumb" class:skeleton={busy}>
    {#await app.blobUrl(receipt.annotatedKey ?? receipt.cleanedKey ?? receipt.fileKey) then url}
      {#if url}
        <img src={url} alt="" loading="lazy" />
      {/if}
    {/await}
  </div>
  <div class="body">
    <div class="top">
      <span class="chip {meta.cls}">{meta.label}</span>
      {#if receipt.logoMatch?.source === "logo"}
        <span class="chip chip-ok" title="Brand identified visually">logo ✓</span>
      {/if}
      <span class="fname" title={receipt.fileName}>{receipt.fileName}</span>
    </div>
    {#if receipt.status === "done" || receipt.status === "needs_review"}
      <div class="facts">
        <strong class="vendor">{receipt.vendor.value || "Unknown vendor"}</strong>
        <span class="muted">
          {receipt.date.value ? formatDate(receipt.date.value) : "no date"}
        </span>
        <strong class="amount">
          {receipt.amount.value > 0
            ? formatMoney(receipt.amount.value)
            : "—"}
        </strong>
      </div>
      {#if receipt.flags.length}
        {#if receipt.status === "needs_review"}
          <!-- The review reason is the card's headline fact: it tells the
               user what to check before they even open the modal. -->
          <div class="why">
            <span aria-hidden="true">⚠</span>
            <span class="why-msg">{receipt.flags[0]?.message}</span>
            {#if receipt.flags.length > 1}
              <span class="why-more">+{receipt.flags.length - 1} more</span>
            {/if}
          </div>
        {:else}
          <div class="flags muted">
            {receipt.flags[0]?.message}
            {#if receipt.flags.length > 1}
              <span>+{receipt.flags.length - 1} more</span>
            {/if}
          </div>
        {/if}
      {/if}
    {:else if receipt.status === "failed"}
      <div class="flags err">{receipt.error ?? "Processing failed."}</div>
    {:else}
      <div class="facts muted">Reading on your device…</div>
    {/if}
  </div>
</button>

<style>
  .rc {
    display: grid;
    grid-template-columns: 84px 1fr;
    gap: 0.9rem;
    padding: 0.8rem;
    text-align: left;
    cursor: pointer;
    border-width: 1px;
    font: inherit;
    color: inherit;
    transition:
      box-shadow 120ms ease,
      border-color 120ms ease,
      transform 120ms ease;
  }
  .rc:hover {
    box-shadow: var(--shadow-2);
    border-color: var(--line-strong);
    transform: translateY(-1px);
  }
  .thumb {
    width: 84px;
    height: 84px;
    border-radius: var(--radius-s);
    overflow: hidden;
    background: var(--bg-sunken);
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .body {
    min-width: 0;
    display: grid;
    gap: 0.35rem;
    align-content: start;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .fname {
    font-size: 0.8rem;
    color: var(--ink-soft);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .facts {
    display: flex;
    align-items: baseline;
    gap: 0.7rem;
    flex-wrap: wrap;
  }
  .vendor {
    font-size: 0.98rem;
  }
  .amount {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    color: var(--accent);
  }
  .flags {
    font-size: 0.82rem;
  }
  .why {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    font: 600 0.84rem/1.35 var(--font-ui);
    color: var(--gold-text);
    background: var(--gold-soft);
    border-left: 3px solid var(--gold);
    border-radius: 6px;
    padding: 0.4rem 0.55rem;
  }
  .why-msg {
    min-width: 0;
  }
  .why-more {
    margin-left: auto;
    font-weight: 500;
    white-space: nowrap;
  }
  .err {
    color: var(--err);
    font-size: 0.82rem;
  }
</style>
