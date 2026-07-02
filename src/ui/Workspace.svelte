<script lang="ts">
  import { app } from "./state.svelte.ts";
  import Dropzone from "./Dropzone.svelte";
  import Card from "./Card.svelte";
  import ThemeToggle from "./ThemeToggle.svelte";
  import ReviewModal from "./ReviewModal.svelte";
  import ExportBar from "./ExportBar.svelte";
  import Settings from "./Settings.svelte";

  const total = $derived(app.receipts.length);
  const finished = $derived(app.counts.done + app.counts.needs_review + app.counts.failed);
</script>

<div class="ws">
  <header class="ws-head">
    <div class="wrap ws-head-in">
      <div class="brand">
        <span class="brand-mark">F5</span>
        <span class="brand-name">Reimbursements&nbsp;F5</span>
      </div>
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
          Add a few receipts above — they'll appear here as they're read, and
          anything uncertain gets flagged for a quick review.
        </p>
      </div>
    {:else}
      <div class="grid">
        {#each app.receipts as r (r.id)}
          <Card receipt={r} />
        {/each}
      </div>
      <ExportBar />
    {/if}
  </main>
</div>

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
</style>
