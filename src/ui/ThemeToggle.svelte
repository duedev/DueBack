<script lang="ts">
  import { app } from "./state.svelte.ts";

  const isDark = (): boolean =>
    app.theme === "dark" ||
    (app.theme === "auto" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
</script>

<button
  class="btn btn-ghost theme-btn"
  onclick={() => app.toggleTheme()}
  aria-label="Toggle light/dark theme"
  title="Toggle theme"
>
  {#if app.theme === "dark" || (app.theme === "auto" && isDark())}
    <!-- sun -->
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7" />
    </svg>
  {:else}
    <!-- moon -->
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />
    </svg>
  {/if}
</button>

<style>
  .theme-btn {
    padding: 0.55rem;
    border-radius: var(--radius-pill);
  }
</style>
