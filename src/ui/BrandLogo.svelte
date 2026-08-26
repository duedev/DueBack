<script lang="ts">
  // The DueBack mark: a receipt (sawtooth foot) carrying a U-turn arrow —
  // money going out and coming back. One component renders it everywhere
  // (landing nav, workspace header, footer); public/icons/favicon.svg holds
  // the same glyph for the favicon/PWA icons — keep the paths in sync.
  let { size = 30, name = true }: { size?: number; name?: boolean } = $props();
</script>

<span class="bl" style="--s:{size}px">
  <span class="bl-mark" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 20.5 V4 a1.5 1.5 0 0 1 1.5 -1.5 h9 a1.5 1.5 0 0 1 1.5 1.5 v16.5 l-3 -2 -3 2 -3 -2 -3 2 z" />
      <path d="M9.6 8.3 h4.4 a2.7 2.7 0 0 1 0 5.4 H10.3 m2.1 -2.1 L10.2 13.7 l2.2 2.1" />
    </svg>
  </span>
  {#if name}<span class="bl-name">DueBack</span>{/if}
</span>

<style>
  .bl {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
  }
  .bl-mark {
    display: inline-grid;
    place-items: center;
    width: var(--s);
    height: var(--s);
    background: var(--accent);
    color: var(--accent-ink);
    border-radius: 26%;
    flex: none;
  }
  .bl-mark svg {
    width: calc(var(--s) * 0.76);
    height: calc(var(--s) * 0.76);
  }
  .bl-name {
    font: 600 calc(var(--s) * 0.62) / 1 var(--font-display);
    letter-spacing: -0.01em;
    color: var(--ink);
  }
</style>
