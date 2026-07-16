<script lang="ts">
  import { app } from "./state.svelte.ts";
  import { repo } from "../store/repo.ts";
  import { CATEGORIES } from "../config/categories.ts";
  import {
    getVisionConfig,
    saveVisionConfig,
    PROVIDERS,
    hasBuiltInOpenRouterKey,
  } from "../pipeline/vision/config.ts";
  import { testVisionConnection } from "../pipeline/vision/index.ts";
  import { addBrandFromImage } from "../pipeline/logo/index.ts";
  import { signInWithGoogle, signInWithEmail, signOut } from "../supabase/auth.ts";
  import {
    connectOneDrive,
    disconnectOneDrive,
    oneDriveAccount,
    oneDriveConfigured,
  } from "../onedrive/index.ts";
  import { listSavedJobs, forgetJob, type SavedJob } from "../store/jobs.ts";
  import { formatMoney } from "../util/money.ts";
  import { getCorrections, clearCorrections } from "../train/corrections.ts";
  import type { Receipt } from "../types.ts";
  import type { ProviderId } from "../pipeline/vision/types.ts";
  import type { Category, StoredBrand } from "../types.ts";

  // ---- AI assist (vision booster) ----------------------------------------
  const cfg0 = getVisionConfig();
  let aiEnabled = $state(cfg0.enabled);
  let provider = $state<ProviderId>(cfg0.provider);
  let model = $state(cfg0.model);
  let apiKey = $state(cfg0.apiKey);
  let spendCap = $state(cfg0.spendCapUsd);
  let spent = $state(cfg0.spentUsd);
  let testMsg = $state("");
  let testing = $state(false);

  function saveAi(): void {
    const next = saveVisionConfig({
      enabled: aiEnabled,
      provider,
      model,
      apiKey: apiKey.trim(),
      spendCapUsd: Number(spendCap) || 0,
    });
    spent = next.spentUsd;
  }

  function onProviderChange(): void {
    model = PROVIDERS[provider].defaultModel;
    saveAi();
  }

  async function testConnection(): Promise<void> {
    testing = true;
    testMsg = "";
    saveAi();
    const res = await testVisionConnection(getVisionConfig());
    testMsg = res.message;
    testing = false;
  }

  // ---- Teach a brand (visual logo index) ----------------------------------
  let brands = $state<StoredBrand[]>([]);
  let brandName = $state("");
  let brandCategory = $state<Category>("Other");
  let brandBusy = $state(false);
  let brandFile = $state<HTMLInputElement | null>(null);

  async function loadBrands(): Promise<void> {
    brands = await repo.listBrands();
  }
  void loadBrands();

  // ---- Improvement log (review corrections) -------------------------------
  let correctionCount = $state(0);
  $effect(() => {
    if (!app.settingsOpen) return;
    void getCorrections().then((r) => (correctionCount = r.length));
  });

  async function downloadCorrections(): Promise<void> {
    const records = await getCorrections();
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dueback_corrections_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function resetCorrections(): Promise<void> {
    await clearCorrections();
    correctionCount = 0;
    app.toast("Improvement log cleared.", "ok");
  }

  // One ZIP with everything a tuning session needs (shared with the
  // contact form's attach checkbox) — see src/train/bundle.ts.
  let bundleBusy = $state(false);
  async function downloadTuningBundle(): Promise<void> {
    bundleBusy = true;
    try {
      const { buildTuningBundle, downloadBundle } = await import("../train/bundle.ts");
      const bundle = await buildTuningBundle($state.snapshot(app.receipts) as Receipt[]);
      downloadBundle(bundle);
      app.toast(
        `Tuning bundle packaged: ${bundle.receiptCount} receipts, ${bundle.correctionCount} corrections.`,
        "ok",
      );
    } catch (err) {
      app.toast(err instanceof Error ? err.message : "Couldn't build the bundle.", "err");
    } finally {
      bundleBusy = false;
    }
  }

  async function addBrand(): Promise<void> {
    const file = brandFile?.files?.[0];
    if (!brandName.trim() || !file) {
      app.toast("Give the brand a name and pick a logo image.", "warn");
      return;
    }
    brandBusy = true;
    try {
      await addBrandFromImage(brandName.trim(), brandCategory, file);
      app.toast(
        `Learned "${brandName.trim()}". Receipts showing this logo will now be recognized.`,
        "ok",
      );
      brandName = "";
      if (brandFile) brandFile.value = "";
      await loadBrands();
    } catch (err) {
      app.toast(
        `Couldn't learn the brand: ${err instanceof Error ? err.message : String(err)}`,
        "err",
      );
    } finally {
      brandBusy = false;
    }
  }

  async function removeBrand(id: string): Promise<void> {
    await repo.deleteBrand(id);
    await loadBrands();
  }

  // ---- OneDrive (save reports to Microsoft OneDrive) ----------------------
  const odConfigured = oneDriveConfigured();
  let odAccount = $state(oneDriveAccount());
  let odBusy = $state(false);

  // Re-read on every open: the report bar's "Save to OneDrive" can connect
  // an account while this panel isn't looking.
  $effect(() => {
    if (app.settingsOpen) odAccount = oneDriveAccount();
  });

  async function connectOd(): Promise<void> {
    odBusy = true;
    try {
      odAccount = await connectOneDrive();
      app.toast("OneDrive connected.", "ok");
    } catch (err) {
      app.toast(
        err instanceof Error ? err.message : "OneDrive sign-in failed.",
        "err",
      );
    } finally {
      odBusy = false;
    }
  }

  function disconnectOd(): void {
    disconnectOneDrive();
    odAccount = null;
    app.toast("OneDrive disconnected.", "info");
  }

  // ---- Saved jobs (name ⇄ number pairs for the report bar) -----------------
  let savedJobs = $state<SavedJob[]>([]);
  $effect(() => {
    // Re-read on every open: the report bar's "Save job" adds pairs while
    // this panel isn't looking.
    if (app.settingsOpen) void listSavedJobs().then((j) => (savedJobs = j));
  });

  async function removeSavedJob(name: string): Promise<void> {
    savedJobs = await forgetJob(name);
  }

  // ---- Account & sync ------------------------------------------------------
  let email = $state("");
  let emailSent = $state(false);

  async function magicLink(): Promise<void> {
    const res = await signInWithEmail(email.trim());
    if (res.error) app.toast(res.error, "err");
    else emailSent = true;
  }

  function close(): void {
    app.settingsOpen = false;
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
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
    <div class="panel card" role="dialog" aria-modal="true" aria-label="Settings">
      <header class="p-head">
        <strong>Settings</strong>
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" onclick={close}>Close ✕</button>
      </header>

      <div class="p-body">
        <!-- ============== account & sync ============== -->
        <section>
          <h4>Account &amp; sync</h4>
          {#if !app.syncConfigured}
            <p class="muted small">
              Sign-in (Google or email) needs a cloud workspace configured at
              build time (<code>VITE_SUPABASE_URL</code> +
              <code>VITE_SUPABASE_ANON_KEY</code>). This deployment doesn't
              have one, so everything stays on this device. Add the keys and
              redeploy to enable accounts, settings sync and cross-device
              batches.
            </p>
          {:else}
            {#if app.userEmail}
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
              <p class="muted small">
                Batches, receipts and taught brands are mirrored to your own
                private cloud workspace (row-level security, only you). The AI
                assist runs through a secure server proxy, so no API key lives
                in your browser.
              </p>
              <button class="btn btn-sm" onclick={() => void signOut()}>Sign out</button>
            {:else}
              <p class="muted small">
                Optional: the app is fully functional without an account. Sign
                in to keep batches across devices and to use the AI assist
                without handling API keys.
              </p>
              <div class="auth-row">
                <button class="btn" onclick={() => void signInWithGoogle()}>
                  Continue with Google
                </button>
              </div>
              <div class="auth-row">
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
          {/if}
        </section>

        <!-- ============== OneDrive ============== -->
        <section>
          <h4>OneDrive</h4>
          {#if !odConfigured}
            <p class="muted small">
              Saving workbooks straight to OneDrive needs a (free) Microsoft
              app registration configured at build time
              (<code>VITE_ONEDRIVE_CLIENT_ID</code> — see
              <code>ONEDRIVE_SETUP.md</code>). This deployment doesn't have
              one, so the option stays hidden.
            </p>
          {:else if odAccount}
            <p class="muted">
              Connected as
              <strong>{odAccount.name || odAccount.email || "Microsoft account"}</strong>
              {#if odAccount.name && odAccount.email}
                <span class="small">· {odAccount.email}</span>
              {/if}
            </p>
            <p class="muted small">
              "Save to OneDrive" in the report bar uploads the generated
              workbook to <code>OneDrive / Apps / DueBack</code>. Sign-in
              tokens stay in this browser; disconnecting forgets them.
            </p>
            <button class="btn btn-sm" onclick={disconnectOd}>Disconnect</button>
          {:else}
            <p class="muted small">
              Connect a Microsoft account to save generated workbooks straight
              to <code>OneDrive / Apps / DueBack</code>. Receipts are still
              read on this device — only the reports you explicitly save are
              uploaded.
            </p>
            <button class="btn" onclick={() => void connectOd()} disabled={odBusy}>
              {odBusy ? "Connecting…" : "Connect OneDrive"}
            </button>
          {/if}
        </section>

        <!-- ============== saved jobs ============== -->
        <section>
          <h4>Saved jobs</h4>
          <p class="muted small">
            Job names and numbers travel as a pair: in the report bar, typing
            (or picking) a saved one autofills the other. Save a pair with the
            "☆ Save job" button next to the fields; forget pairs here.
          </p>
          {#if savedJobs.length}
            <ul class="brand-list">
              {#each savedJobs as j (j.name)}
                <li>
                  <span class="chip">{j.name}</span>
                  <span class="muted small">#{j.number}</span>
                  <button
                    class="btn btn-ghost btn-sm btn-danger"
                    onclick={() => void removeSavedJob(j.name)}
                    aria-label={`Forget job ${j.name}`}
                  >
                    forget
                  </button>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="muted small">No saved jobs yet.</p>
          {/if}
        </section>

        <!-- ============== AI assist ============== -->
        <section>
          <h4>AI assist (for hard receipts)</h4>
          <p class="muted small">
            Off = everything stays on this device. On = receipts the on-device
            reader isn't confident about are sent to the model below for a
            second opinion.
            {#if hasBuiltInOpenRouterKey()}
              This build includes a free OpenRouter tier, no key needed.
            {/if}
          </p>
          <label class="check">
            <input type="checkbox" bind:checked={aiEnabled} onchange={saveAi} />
            <span>Use AI for low-confidence receipts</span>
          </label>

          {#if aiEnabled}
            <div class="grid2">
              <div>
                <label for="st-provider">Provider</label>
                <select id="st-provider" bind:value={provider} onchange={onProviderChange}>
                  {#each Object.values(PROVIDERS) as p (p.id)}
                    <option value={p.id}>{p.label}{p.free ? " · free" : ""}</option>
                  {/each}
                </select>
              </div>
              <div>
                <label for="st-model">Model</label>
                <input id="st-model" type="text" list="st-models" bind:value={model} onchange={saveAi} />
                <datalist id="st-models">
                  {#each PROVIDERS[provider].models as m (m)}
                    <option value={m}></option>
                  {/each}
                </datalist>
              </div>
            </div>
            <p class="muted small">{PROVIDERS[provider].note}</p>
            <div class="grid2">
              <div>
                <label for="st-key">API key {app.userEmail && provider === "openrouter" ? "(optional, server proxy is used)" : ""}</label>
                <input
                  id="st-key"
                  type="password"
                  placeholder={app.userEmail && provider === "openrouter" ? "handled by your account" : "sk-…"}
                  bind:value={apiKey}
                  onchange={saveAi}
                />
                <a class="small" href={PROVIDERS[provider].keyUrl} target="_blank" rel="noopener">
                  Get a key ↗
                </a>
              </div>
              <div>
                <label for="st-cap">Spend cap (USD, 0 = uncapped)</label>
                <input id="st-cap" type="number" min="0" step="0.5" bind:value={spendCap} onchange={saveAi} />
                <span class="muted small">Spent so far: {formatMoney(spent)}</span>
              </div>
            </div>
            <div class="test-row">
              <button class="btn btn-sm" onclick={testConnection} disabled={testing}>
                {testing ? "Testing…" : "Test connection"}
              </button>
              {#if testMsg}<span class="muted small">{testMsg}</span>{/if}
            </div>
          {/if}
        </section>

        <!-- ============== teach a brand ============== -->
        <section>
          <h4>Teach a brand (logo recognition)</h4>
          <p class="muted small">
            When a merchant prints its name only as a logo, the text reader
            can't spell it. Upload one clear image of the logo and the app will
            recognize it visually on future receipts. No retraining, works
            offline after the first model download (~40&nbsp;MB, cached).
          </p>
          <div class="grid3">
            <div>
              <label for="st-bname">Brand name</label>
              <input id="st-bname" type="text" placeholder="e.g. Maple St. Hardware" bind:value={brandName} />
            </div>
            <div>
              <label for="st-bcat">Category</label>
              <select id="st-bcat" bind:value={brandCategory}>
                {#each CATEGORIES as c (c)}
                  <option value={c}>{c}</option>
                {/each}
              </select>
            </div>
            <div>
              <label for="st-bfile">Logo image</label>
              <input id="st-bfile" type="file" accept="image/*" bind:this={brandFile} />
            </div>
          </div>
          <button class="btn btn-primary btn-sm" onclick={addBrand} disabled={brandBusy}>
            {brandBusy ? "Learning…" : "Add brand"}
          </button>

          {#if brands.length}
            <ul class="brand-list">
              {#each brands as b (b.id)}
                <li>
                  <span class="chip">{b.name}</span>
                  <span class="muted small">{b.category}</span>
                  <button
                    class="btn btn-ghost btn-sm btn-danger"
                    onclick={() => void removeBrand(b.id)}
                    aria-label={`Forget ${b.name}`}
                  >
                    forget
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <!-- ============== improvement log ============== -->
        <section>
          <h4>Improvement log</h4>
          <p class="muted small">
            Every correction you make in review is recorded with where the
            right value sits on the receipt and what the reader believed
            beforehand. Download it (and the images ZIP) to tune extraction
            against your real receipts. Stays on this device.
          </p>
          <div class="test-row">
            <span class="chip">{correctionCount} corrections</span>
            <button class="btn btn-primary btn-sm" onclick={() => void downloadTuningBundle()} disabled={bundleBusy || app.receipts.length === 0}>
              {bundleBusy ? "Packaging…" : "Download tuning bundle"}
            </button>
            <button class="btn btn-sm" onclick={() => void downloadCorrections()} disabled={correctionCount === 0}>
              Corrections JSON
            </button>
            <button class="btn btn-ghost btn-sm btn-danger" onclick={() => void resetCorrections()} disabled={correctionCount === 0}>
              Clear
            </button>
          </div>
          <p class="muted small">
            The bundle zips the corrections log, every receipt's extraction
            (fields, flags, OCR text and positions), the report CSV, and the
            original + highlighted images: one file to hand over for tuning.
          </p>
        </section>
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
  section {
    display: grid;
    gap: 0.6rem;
    align-content: start;
  }
  section h4 {
    margin: 0;
    padding-bottom: 0.35rem;
    border-bottom: 1px solid var(--line);
  }
  .small {
    font-size: 0.84rem;
  }
  .ok {
    color: var(--ok);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-transform: none;
    letter-spacing: 0;
    font: 550 0.95rem/1.3 var(--font-ui);
    color: var(--ink);
  }
  .check input {
    width: auto;
    accent-color: var(--accent);
  }
  .grid2 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.8rem;
  }
  .grid3 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 0.8rem;
  }
  .test-row,
  .auth-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .auth-row input {
    max-width: 260px;
  }
  .brand-list {
    list-style: none;
    padding: 0;
    margin: 0.4rem 0 0;
    display: grid;
    gap: 0.4rem;
  }
  .brand-list li {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
</style>
