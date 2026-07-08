<script lang="ts">
  import { app } from "./state.svelte.ts";
  import Dropzone from "./Dropzone.svelte";
  import Card from "./Card.svelte";
  import ThemeToggle from "./ThemeToggle.svelte";
  import ReviewModal from "./ReviewModal.svelte";
  import ExportBar from "./ExportBar.svelte";
  import Settings from "./Settings.svelte";
  import type { Receipt, ReceiptStatus } from "../types.ts";

  const total = $derived(app.receipts.length);
  const finished = $derived(app.counts.done + app.counts.needs_review + app.counts.failed);

  // ---- Board view + sorting -------------------------------------------------
  type BoardView = "grid" | "kanban";
  type SortKey = "added" | "date" | "amount" | "vendor" | "category" | "status";
  let view = $state<BoardView>(
    (localStorage.getItem("board.view") as BoardView) || "grid",
  );
  let sortKey = $state<SortKey>(
    (localStorage.getItem("board.sort") as SortKey) || "added",
  );
  $effect(() => localStorage.setItem("board.view", view));
  $effect(() => localStorage.setItem("board.sort", sortKey));

  const STATUS_RANK: Record<ReceiptStatus, number> = {
    needs_review: 0, failed: 1, processing: 2, queued: 3, done: 4,
  };
  function compare(a: Receipt, b: Receipt): number {
    switch (sortKey) {
      case "date":
        return (b.date.value || "").localeCompare(a.date.value || "");
      case "amount":
        return b.amount.value - a.amount.value;
      case "vendor":
        return (a.vendor.value || "\uffff").localeCompare(b.vendor.value || "\uffff");
      case "category":
        return a.category.value.localeCompare(b.category.value);
      case "status":
        return STATUS_RANK[a.status] - STATUS_RANK[b.status];
      default:
        return b.createdAt - a.createdAt; // newest first
    }
  }
  const sorted = $derived([...app.receipts].sort(compare));

  // Kanban lanes: attention first, then the pipeline, then done.
  const LANES: { key: string; label: string; match: (r: Receipt) => boolean }[] = [
    { key: "review", label: "Needs review", match: (r) => r.status === "needs_review" },
    { key: "working", label: "Processing", match: (r) => r.status === "queued" || r.status === "processing" },
    { key: "done", label: "Done", match: (r) => r.status === "done" },
    { key: "failed", label: "Failed", match: (r) => r.status === "failed" },
  ];
  const lanes = $derived(
    LANES.map((l) => ({ ...l, items: sorted.filter(l.match) })).filter(
      (l) => l.items.length > 0 || l.key === "done" || l.key === "review",
    ),
  );

  let cameraInput = $state<HTMLInputElement | null>(null);

  function onCameraPicked(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    input.value = ""; // ready for the next shot immediately
    if (files.length) void app.addFiles(files);
  }
</script>

<div class="ws">
  <header class="ws-head">
    <div class="wrap ws-head-in">
      <button
        class="brand"
        onclick={() => app.goHome()}
        title="Back to the home page"
        aria-label="Back to the home page"
      >
        <span class="brand-mark">DB</span>
        <span class="brand-name">DueBack</span>
      </button>
      {#if total > 0}
        <div class="progress" aria-label="Processing progress">
          <span class="muted">{finished}/{total} processed</span>
          {#if app.counts.needs_review > 0}
            <span class="chip chip-warn">{app.counts.needs_review} to review</span>
          {/if}
        </div>
      {/if}
      <div class="head-actions">
        {#if app.userEmail}
          <span class="chip chip-ok" title="Synced to your cloud workspace">☁ synced</span>
        {/if}
        {#if total > 0}
          <button
            class="btn btn-ghost clear-all"
            onclick={() => app.clearAll()}
            title="Delete all receipts"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            </svg>
            Delete all
          </button>
        {/if}
        <button
          class="btn btn-ghost"
          onclick={() => (app.settingsOpen = true)}
          aria-label="Settings"
          title="Settings"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3.2" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
          </svg>
        </button>
        <ThemeToggle />
      </div>
    </div>
  </header>

  <main class="wrap ws-main">
    <Dropzone compact={total > 0} />

    {#if total === 0}
      <div class="empty">
        <h3>No receipts yet</h3>
        <p class="muted">
          Add a few receipts above; they'll appear here as they're read, and
          anything uncertain gets flagged for a quick review.
        </p>
      </div>
    {:else}
      <div class="board-bar">
        <div class="seg" role="tablist" aria-label="Board view">
          <button class="seg-btn" class:active={view === "grid"} onclick={() => (view = "grid")}>Grid</button>
          <button class="seg-btn" class:active={view === "kanban"} onclick={() => (view = "kanban")}>Kanban</button>
        </div>
        <label class="sort">
          <span class="muted small">Sort</span>
          <select bind:value={sortKey} aria-label="Sort receipts">
            <option value="added">Newest added</option>
            <option value="status">Needs attention</option>
            <option value="date">Receipt date</option>
            <option value="amount">Amount (high first)</option>
            <option value="vendor">Vendor A–Z</option>
            <option value="category">Category</option>
          </select>
        </label>
      </div>

      {#if view === "grid"}
        <div class="grid">
          {#each sorted as r (r.id)}
            <Card receipt={r} />
          {/each}
        </div>
      {:else}
        <div class="kanban">
          {#each lanes as lane (lane.key)}
            <section class="lane lane-{lane.key}">
              <header class="lane-head">
                <span>{lane.label}</span>
                <span class="lane-count">{lane.items.length}</span>
              </header>
              <div class="lane-cards">
                {#each lane.items as r (r.id)}
                  <Card receipt={r} />
                {/each}
                {#if lane.items.length === 0}
                  <p class="muted small lane-empty">Nothing here.</p>
                {/if}
              </div>
            </section>
          {/each}
        </div>
      {/if}
      <ExportBar />
    {/if}
  </main>
</div>

<!-- Mobile-only floating camera: bottom-right, under the thumb. Each shot is
     queued instantly and the button stays put, so snapping a batch is just
     tap → shoot → tap → shoot. -->
<input
  type="file"
  bind:this={cameraInput}
  onchange={onCameraPicked}
  accept="image/*"
  capture="environment"
  class="sr-only"
  aria-hidden="true"
  tabindex="-1"
/>
<button class="camera-fab" onclick={() => cameraInput?.click()} aria-label="Snap a receipt">
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M14.5 4h-5L7.9 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.9L14.5 4Z" />
    <circle cx="12" cy="13" r="3.6" />
  </svg>
</button>

<ReviewModal />
<Settings />

<style>
  .ws {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
  }
  .ws-head {
    position: sticky;
    top: 0;
    z-index: 40;
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--line);
  }
  .ws-head-in {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.7rem 0;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    margin-right: auto;
    border: 0;
    background: none;
    padding: 0;
    cursor: pointer;
    color: inherit;
    font: inherit;
  }
  .brand:hover .brand-name {
    color: var(--accent);
  }
  .clear-all {
    color: var(--err);
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .brand-mark {
    font: 600 0.85rem/1 var(--font-display);
    color: var(--accent-ink);
    background: var(--accent);
    border-radius: 8px;
    padding: 0.35rem 0.45rem;
  }
  .brand-name {
    font: 650 0.95rem/1 var(--font-ui);
  }
  .progress {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    font-size: 0.9rem;
  }
  .head-actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .ws-main {
    display: grid;
    gap: 1.2rem;
    padding: 1.4rem 0 3rem;
    align-content: start;
    flex: 1;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 0.9rem;
  }
  .empty {
    text-align: center;
    padding: 3.5rem 1rem;
  }
  .empty p {
    max-width: 26rem;
    margin-inline: auto;
  }

  /* Floating camera — touch devices only. Stays UNDER the review/settings
     overlays (z-index 50), which otherwise render behind it on phones. */
  .camera-fab {
    display: none;
    position: fixed;
    right: 1.1rem;
    bottom: 1.3rem;
    z-index: 45;
    width: 3.6rem;
    height: 3.6rem;
    border: 0;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-ink);
    box-shadow: var(--shadow-3);
    cursor: pointer;
  }
  .camera-fab:active {
    transform: scale(0.96);
  }
  @media (pointer: coarse) {
    .camera-fab {
      display: grid;
      place-items: center;
    }
  }

  /* ---- board view bar + kanban lanes ---- */
  .board-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.8rem;
    margin: 1rem 0 0.75rem;
    flex-wrap: wrap;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--line-strong);
    border-radius: 9px;
    overflow: hidden;
  }
  .seg-btn {
    border: 0;
    background: transparent;
    color: var(--ink-soft);
    font: 600 0.85rem/1 var(--font-ui);
    padding: 0.5rem 0.9rem;
    cursor: pointer;
  }
  .seg-btn.active {
    background: var(--accent);
    color: var(--accent-ink);
  }
  .sort {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
  }
  .sort select {
    padding: 0.4rem 0.55rem;
    border-radius: 8px;
    border: 1px solid var(--line-strong);
    background: var(--raised);
    color: var(--ink);
    font: 500 0.85rem/1.2 var(--font-ui);
  }
  .kanban {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(260px, 1fr);
    gap: 0.9rem;
    align-items: start;
    overflow-x: auto;
    padding-bottom: 0.5rem;
  }
  .lane {
    background: color-mix(in srgb, var(--raised) 70%, transparent);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 0.6rem;
    min-height: 8rem;
  }
  .lane-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font: 700 0.8rem/1 var(--font-ui);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--ink-soft);
    padding: 0.25rem 0.3rem 0.6rem;
  }
  .lane-review .lane-head { color: var(--warn); }
  .lane-failed .lane-head { color: var(--err); }
  .lane-count {
    background: var(--line);
    color: var(--ink);
    border-radius: 999px;
    padding: 0.15rem 0.55rem;
    font-size: 0.75rem;
  }
  .lane-cards {
    display: grid;
    gap: 0.6rem;
  }
  .lane-empty {
    text-align: center;
    padding: 1rem 0;
  }
</style>
