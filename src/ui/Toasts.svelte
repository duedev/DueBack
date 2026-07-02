<script lang="ts">
  import { app } from "./state.svelte.ts";
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each app.toasts as t (t.id)}
    <div class="toast card {t.kind}">{t.message}</div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    inset-inline: 0;
    bottom: max(1rem, env(safe-area-inset-bottom));
    display: grid;
    justify-items: center;
    gap: 0.5rem;
    pointer-events: none;
    z-index: 60;
    padding-inline: 1rem;
  }
  .toast {
    padding: 0.65rem 1.1rem;
    font: 550 0.92rem/1.3 var(--font-ui);
    box-shadow: var(--shadow-2);
    animation: rise 180ms ease-out;
    max-width: 34rem;
  }
  .toast.ok {
    border-color: var(--accent-line);
  }
  .toast.warn {
    border-color: var(--gold);
  }
  .toast.err {
    border-color: var(--err);
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
</style>
