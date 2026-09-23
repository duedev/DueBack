<script lang="ts">
  import { app } from "./state.svelte.ts";
  import AppearanceSection from "./settings/AppearanceSection.svelte";
  import AccountSection from "./settings/AccountSection.svelte";
  import OneDriveSection from "./settings/OneDriveSection.svelte";
  import SavedJobsSection from "./settings/SavedJobsSection.svelte";
  import AiAssistSection from "./settings/AiAssistSection.svelte";
  import BrandsSection from "./settings/BrandsSection.svelte";
  import ImprovementSection from "./settings/ImprovementSection.svelte";

  // The Settings dialog shell: scrim, focus management and the shared
  // section vocabulary (styles below). Each section is its own component
  // under settings/ and mounts with the dialog, so every open reads fresh
  // state (sign-in flips the AI assist on, the report bar saves jobs and
  // connects OneDrive while this panel is closed).

  function close(): void {
    app.settingsOpen = false;
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }

  // ---- Focus management (role=dialog + aria-modal promise it) -------------
  let dialogEl = $state<HTMLElement | null>(null);

  // On open, remember what had focus and move it into the dialog; on close
  // ({#if} unmount → bind:this null) the effect cleanup gives it back. The
  // dialog lives in App.svelte and outlives a surface swap, so the opener
  // may be gone by then — fall back to the gear the visible header shows.
  $effect(() => {
    const el = dialogEl;
    if (!el) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.focus();
    return () => {
      if (prev?.isConnected) prev.focus();
      else document.querySelector<HTMLElement>("[data-settings-btn]")?.focus();
    };
  });

  /** Keep Tab cycling inside the dialog instead of walking the obscured page. */
  function trapTab(e: KeyboardEvent): void {
    if (e.key !== "Tab" || !dialogEl) return;
    const focusables = Array.from(
      dialogEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogEl)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if app.settingsOpen}
  <div
    class="scrim"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) close();
    }}
  >
    <div
      class="panel card"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      tabindex="-1"
      bind:this={dialogEl}
      onkeydown={trapTab}
    >
      <header class="p-head">
        <h2 class="p-title">Settings</h2>
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" onclick={close}>Close ✕</button>
      </header>

      <div class="p-body">
        <AppearanceSection />
        <AccountSection />
        <OneDriveSection />
        <SavedJobsSection />
        <AiAssistSection />
        <BrandsSection />
        <ImprovementSection />
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgb(10 8 6 / 0.55);
    backdrop-filter: blur(3px);
    display: grid;
    place-items: center;
    padding: 1rem;
    z-index: 50;
  }
  .panel {
    width: min(680px, 100%);
    max-height: min(90dvh, 100%);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: var(--shadow-3);
  }
  .p-head {
    display: flex;
    align-items: center;
    padding: 0.85rem 1.1rem;
    border-bottom: 1px solid var(--line);
  }
  .spacer {
    flex: 1;
  }
  .p-body {
    overflow: auto;
    padding: 1.1rem;
    display: grid;
    gap: 1.6rem;
  }
  .p-title {
    margin: 0;
    font: 600 1rem/1.2 var(--font-ui);
    letter-spacing: 0;
    text-wrap: auto;
  }

  /* Shared section vocabulary. The sections are child components, so
     these reach into them with :global — scoped under .p-body, they can't
     leak to the rest of the app. */
  .p-body :global(section) {
    display: grid;
    gap: 0.6rem;
    align-content: start;
  }
  /* h3s (they were h4s under no h2/h3 — a heading list that jumped from
     the page's h1 to level 4); the UI-font look is re-pinned. */
  .p-body :global(section h3) {
    margin: 0;
    padding-bottom: 0.35rem;
    border-bottom: 1px solid var(--line);
    font: 650 1rem/1.3 var(--font-ui);
    letter-spacing: 0;
    text-wrap: auto;
  }
  .p-body :global(.small) {
    font-size: 0.84rem;
  }
  .p-body :global(.ok) {
    color: var(--ok);
  }
  .p-body :global(.check) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-transform: none;
    letter-spacing: 0;
    font: 550 0.95rem/1.3 var(--font-ui);
    color: var(--ink);
  }
  .p-body :global(.check input) {
    width: auto;
    accent-color: var(--accent);
  }
  .p-body :global(.grid2) {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.8rem;
  }
  .p-body :global(.grid3) {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 0.8rem;
  }
  .p-body :global(.row) {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .p-body :global(.item-list) {
    list-style: none;
    padding: 0;
    margin: 0.4rem 0 0;
    display: grid;
    gap: 0.4rem;
  }
  .p-body :global(.item-list li) {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
</style>
