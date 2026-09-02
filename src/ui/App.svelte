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
  <div class="splash" aria-label="Loading">
    <div class="splash-mark">DB</div>
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
