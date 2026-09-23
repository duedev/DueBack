<script lang="ts">
  import { app } from "../state.svelte.ts";
  import { signInWithGoogle, signInWithEmail, signOut } from "../../supabase/auth.ts";

  let email = $state("");
  let emailSent = $state(false);

  async function magicLink(): Promise<void> {
    const res = await signInWithEmail(email.trim());
    if (res.error) app.toast(res.error, "err");
    else emailSent = true;
  }

  /** The way out of the foreign-owner sync block: another account's data
   *  is on this device. Wipes the local stores WITHOUT queuing tombstones
   *  (those rows were never this account's) and starts sync over. */
  async function resetLocalCopy(): Promise<void> {
    const ok = confirm(
      "Remove every receipt, batch and taught brand stored on this device? Your own cloud workspace is not touched — this device will sync it afresh.",
    );
    if (!ok) return;
    await app.resetLocalCopy();
  }
</script>

<section>
  <h3>Account &amp; sync</h3>
  {#if !app.syncConfigured}
    <p class="muted small">
      Sign-in (Google or email) needs a cloud workspace configured at
      build time (<code>VITE_SUPABASE_URL</code> +
      <code>VITE_SUPABASE_ANON_KEY</code>). This deployment doesn't
      have one, so everything stays on this device. Add the keys and
      redeploy to enable accounts, settings sync and cross-device
      batches.
    </p>
  {:else if app.userEmail}
    <p class="muted">
      Signed in as <strong>{app.userEmail}</strong> · sync
      <span
        class="chip {app.syncStatus === 'error'
          ? 'chip-err'
          : app.syncStatus === 'idle'
            ? 'chip-ok'
            : ''}">{app.syncStatus}</span
      >
    </p>
    {#if app.syncStatus === "error" && app.syncError}
      <p class="sync-error small" role="alert">{app.syncError}</p>
      {#if app.syncForeign}
        <p>
          <button class="btn btn-sm btn-danger" onclick={() => void resetLocalCopy()}>
            Remove this device's local copy
          </button>
        </p>
      {/if}
    {/if}
    <p class="muted small">
      Batches, receipts and taught brands are mirrored to your own
      private cloud workspace (row-level security, only you). The cloud
      AI assist runs through a secure server proxy, so no API key lives
      in your browser.
    </p>
    <button class="btn btn-sm" onclick={() => void signOut()}>Sign out</button>
  {:else}
    <p class="muted small">
      Optional: the app is fully functional without an account. Sign
      in to keep batches across devices and to use the cloud AI assist
      without handling API keys.
    </p>
    <div class="row">
      <button class="btn" onclick={() => void signInWithGoogle()}>
        Continue with Google
      </button>
    </div>
    <div class="row">
      <input
        type="email"
        placeholder="you@example.com"
        bind:value={email}
        aria-label="Email for magic link"
      />
      <button class="btn btn-sm" onclick={magicLink} disabled={!email.includes("@")}>
        Email me a link
      </button>
    </div>
    {#if emailSent}
      <p class="ok small">Check your inbox; the link signs you in here.</p>
    {/if}
  {/if}
</section>

<style>
  .sync-error {
    color: var(--err);
    margin: 0.25rem 0 0.5rem;
  }
  .row input {
    max-width: 260px;
  }
</style>
