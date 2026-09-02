<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "./state.svelte.ts";
  import Landing from "./Landing.svelte";
  import Workspace from "./Workspace.svelte";
  import Toasts from "./Toasts.svelte";

  const hashName = (): string => location.hash.replace(/^#\/?/, "");

  onMount(() => {
    // A Supabase auth callback (magic link, Google — the implicit flow)
    // lands as `#access_token=…`. auth-js consumed it synchronously inside
    // createClient and clears the hash once the user is fetched — a
    // hashchange to "" that the listener below must NOT read as "the user
    // left #process": it bounced every returning sign-in on a device with
    // receipts back to the landing page.
    let authCallback = /(^|[#&])access_token=/.test(location.hash);
    // #process deep-links straight into the workspace (handy for walking
    // someone through the app remotely: "what does your #process page show?").
    if (hashName() === "process") app.enter();
    void app.init();
    // Back/forward across surfaces: leaving #process returns to the landing,
    // arriving at it enters the workspace. Landing handles its own hashes.
    const onHash = (): void => {
      if (authCallback && location.hash === "") {
        authCallback = false;
        // replaceState fires no hashchange, so this cannot loop.
        history.replaceState(
          null,
          "",
          location.pathname + location.search + (app.showWorkspace ? "#process" : ""),
        );
        return;
      }
      if (hashName() === "process") app.enter();
      else if (app.showWorkspace) app.goHome();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });

  // Keep the URL honest about which surface is showing: the workspace is
  // #process, the landing owns every other hash. replaceState fires no
  // hashchange and adds no history entry, so this cannot loop with the
  // listener above or with the landing's own router — it runs BEFORE the
  // surface swap renders, and the landing then mounts reading the already
  // corrected hash.
  // index.html stamps aria-busy on #app; it comes off when boot has actually
  // finished (main.ts used to strip it synchronously before mount, so the
  // busy flag never covered the real boot window).
  $effect(() => {
    if (!app.booting) document.getElementById("app")?.removeAttribute("aria-busy");
  });

  $effect(() => {
    if (app.booting) return;
    if (app.showWorkspace) {
      if (hashName() !== "process") history.replaceState(null, "", "#process");
    } else if (hashName() === "process") {
      history.replaceState(null, "", location.pathname + location.search + "#home");
    }
  });
</script>

{#if app.booting}
  <!-- role=status: aria-label is name-prohibited on a plain div, so screen
       readers announced only "DB". -->
  <div class="splash" role="status" aria-live="polite">
    <div class="splash-mark" aria-hidden="true">DB</div>
    <span class="sr-only">Loading DueBack…</span>
  </div>
{:else if app.showWorkspace}
  <Workspace />
{:else}
  <Landing />
{/if}

{#if app.updateReady}
  <!-- Persistent, never auto-dismissed (a toast would vanish in 4 s). The
       reload waits while receipts are being read: the job lock heartbeats
       every 20 s and a reload mid-job parks it until the lock goes stale. -->
  <div class="update-bar" role="status">
    <span>A new version of DueBack is ready.</span>
    <button
      class="btn btn-sm btn-primary"
      onclick={() => app.updateReady?.()}
      disabled={app.pendingJobs > 0}
      title={app.pendingJobs > 0 ? "Reload once the receipts being read finish" : "Reload into the new version"}
    >
      {app.pendingJobs > 0 ? `Reload after ${app.pendingJobs} finish` : "Reload"}
    </button>
  </div>
{/if}

<Toasts />

<style>
  .update-bar {
    position: fixed;
    left: 50%;
    bottom: 1rem;
    transform: translateX(-50%);
    z-index: 60;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    max-width: calc(100vw - 2rem);
    padding: 0.6rem 0.9rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-pill);
    background: var(--bg-raised);
    color: var(--ink);
    box-shadow: var(--shadow-2);
    font-size: 0.9rem;
  }
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
