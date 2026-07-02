<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "./state.svelte.ts";
  import Landing from "./Landing.svelte";
  import Workspace from "./Workspace.svelte";
  import Toasts from "./Toasts.svelte";

  onMount(() => {
    void app.init();
  });
</script>

{#if app.booting}
  <div class="splash" aria-label="Loading">
    <div class="splash-mark">F5</div>
  </div>
{:else if app.showWorkspace}
  <Workspace />
{:else}
  <Landing />
{/if}

<Toasts />

<style>
  .splash {
    min-height: 100dvh;
    display: grid;
    place-items: center;
  }
  .splash-mark {
    font: 600 1.4rem/1 var(--font-display);
    color: var(--accent-ink);
    background: var(--accent);
    border-radius: var(--radius-m);
    padding: 0.7rem 0.9rem;
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.55;
    }
  }
</style>
