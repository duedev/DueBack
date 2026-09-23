<script lang="ts">
  import { app } from "../state.svelte.ts";
  import {
    connectOneDrive,
    disconnectOneDrive,
    oneDriveAccount,
    oneDriveConfigured,
  } from "../../onedrive/index.ts";

  const configured = oneDriveConfigured();
  let account = $state(oneDriveAccount());
  let busy = $state(false);

  // Re-read on every open: the report bar's "Save to OneDrive" can connect
  // an account while this panel isn't looking.
  $effect(() => {
    if (app.settingsOpen) account = oneDriveAccount();
  });

  async function connect(): Promise<void> {
    busy = true;
    try {
      account = await connectOneDrive();
      app.toast("OneDrive connected.", "ok");
    } catch (err) {
      app.toast(err instanceof Error ? err.message : "OneDrive sign-in failed.", "err");
    } finally {
      busy = false;
    }
  }

  function disconnect(): void {
    disconnectOneDrive();
    account = null;
    app.toast("OneDrive disconnected.", "info");
  }
</script>

<section>
  <h3>OneDrive</h3>
  {#if !configured}
    <p class="muted small">
      Saving workbooks straight to OneDrive needs a (free) Microsoft
      app registration configured at build time
      (<code>VITE_ONEDRIVE_CLIENT_ID</code> — see
      <code>ONEDRIVE_SETUP.md</code>). This deployment doesn't have
      one, so the option stays hidden.
    </p>
  {:else if account}
    <p class="muted">
      Connected as
      <strong>{account.name || account.email || "Microsoft account"}</strong>
      {#if account.name && account.email}
        <span class="small">· {account.email}</span>
      {/if}
    </p>
    <p class="muted small">
      "Save to OneDrive" in the report bar uploads the generated
      workbook — and, when the print packet is enabled, the packet
      PDF beside it — to <code>OneDrive / Apps / DueBack</code>.
      Sign-in tokens stay in this browser; disconnecting forgets them.
    </p>
    <button class="btn btn-sm" onclick={disconnect}>Disconnect</button>
  {:else}
    <p class="muted small">
      Connect a Microsoft account to save generated reports (the
      workbook and its print packet) straight to
      <code>OneDrive / Apps / DueBack</code>. Receipts are still read
      on this device — only the reports you explicitly save are
      uploaded.
    </p>
    <button class="btn" onclick={() => void connect()} disabled={busy}>
      {busy ? "Connecting…" : "Connect OneDrive"}
    </button>
  {/if}
</section>
