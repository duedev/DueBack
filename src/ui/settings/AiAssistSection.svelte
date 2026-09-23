<script lang="ts">
  import { app } from "../state.svelte.ts";
  import Segmented from "../Segmented.svelte";
  import {
    BACKENDS,
    LOCAL_SERVERS,
    PROVIDERS,
    STRATEGIES,
    getVisionConfig,
    hasBuiltInOpenRouterKey,
    saveVisionConfig,
    type VisionConfig,
  } from "../../pipeline/vision/config.ts";
  import { testVisionConnection } from "../../pipeline/vision/index.ts";
  import { appOrigin } from "../../pipeline/vision/clients/shared.ts";
  import { formatMoney } from "../../util/money.ts";
  import type { Backend, LocalServerId, ProviderId, Strategy } from "../../pipeline/vision/types.ts";

  // One editable copy of the stored config. Every control writes into it and
  // save() persists it — except `spentUsd`, which assisted receipts bump
  // behind the panel's back and so is only ever read, never written, here.
  // (The section mounts on each open, so the read is always fresh: sign-in
  // flips `enabled` on while the panel is closed.)
  let cfg = $state<VisionConfig>(getVisionConfig());
  let spendCap = $state<number | null>(cfg.spendCapUsd);
  let testMsg = $state("");
  let testing = $state(false);

  const backendOptions = Object.values(BACKENDS).map((b) => ({ value: b.id, label: b.label }));
  const strategyOptions = Object.values(STRATEGIES).map((s) => ({ value: s.id, label: s.label }));

  /** Signed in with no own OpenRouter key: the cloud call goes through the
   *  account's server proxy, which relays one-shot reads only. */
  const viaAccount = $derived(
    cfg.backend === "cloud" &&
      cfg.cloud.provider === "openrouter" &&
      !cfg.cloud.apiKey.trim() &&
      !!app.userEmail,
  );

  function save(): void {
    // An emptied cap field is "unchanged", not "$0 — never assist"; a
    // negative is clamped; the persisted value is echoed back so an uncap
    // is visible.
    const cap =
      spendCap === null || (spendCap as unknown) === ""
        ? getVisionConfig().spendCapUsd
        : Math.max(0, Number(spendCap) || 0);
    const { spentUsd: _ignored, ...edits } = $state.snapshot(cfg);
    const next = saveVisionConfig({
      ...edits,
      cloud: { ...edits.cloud, apiKey: edits.cloud.apiKey.trim() },
      selfhosted: { ...edits.selfhosted, apiKey: edits.selfhosted.apiKey.trim() },
      spendCapUsd: cap,
    });
    spendCap = next.spendCapUsd;
    cfg.spentUsd = next.spentUsd;
    testMsg = "";
  }

  function onBackend(b: Backend): void {
    cfg.backend = b;
    save();
  }

  function onStrategy(s: Strategy): void {
    cfg.strategy = s;
    save();
  }

  function onProviderChange(): void {
    cfg.cloud.model = PROVIDERS[cfg.cloud.provider as ProviderId].defaultModel;
    save();
  }

  function onServerChange(): void {
    const meta = LOCAL_SERVERS[cfg.local.server as LocalServerId];
    cfg.local.url = meta.url;
    cfg.local.model = meta.defaultModel;
    save();
  }

  async function testConnection(): Promise<void> {
    testing = true;
    save();
    const res = await testVisionConnection(getVisionConfig());
    testMsg = res.message;
    testing = false;
  }
</script>

<section>
  <h3>AI assist (for hard receipts)</h3>
  <p class="muted small">
    Off = everything stays on this device. On = receipts the on-device
    reader isn't confident about get a second opinion from the model you
    pick below.
    {#if hasBuiltInOpenRouterKey()}
      This build includes a free OpenRouter tier on Cloud, no key needed.
    {/if}
  </p>
  <label class="check">
    <input type="checkbox" bind:checked={cfg.enabled} onchange={save} />
    <span>Use AI for low-confidence receipts</span>
  </label>

  {#if cfg.enabled}
    <div class="choice">
      <span class="field-label" aria-hidden="true">Where the model runs</span>
      <Segmented label="Where the model runs" options={backendOptions} value={cfg.backend} onchange={onBackend} />
      <p class="muted small">{BACKENDS[cfg.backend].note}</p>
    </div>

    {#if cfg.backend === "local"}
      <div class="grid3">
        <div>
          <label for="st-server">Server</label>
          <select id="st-server" bind:value={cfg.local.server} onchange={onServerChange}>
            {#each Object.values(LOCAL_SERVERS) as s (s.id)}
              <option value={s.id}>{s.label}</option>
            {/each}
          </select>
        </div>
        <div>
          <label for="st-local-url">Server URL</label>
          <input id="st-local-url" type="url" spellcheck="false" bind:value={cfg.local.url} onchange={save} />
        </div>
        <div>
          <label for="st-local-model">Model</label>
          <input id="st-local-model" type="text" list="st-local-models" bind:value={cfg.local.model} onchange={save} />
          <datalist id="st-local-models">
            {#each LOCAL_SERVERS[cfg.local.server].models as m (m)}
              <option value={m}></option>
            {/each}
          </datalist>
        </div>
      </div>
      <p class="muted small">
        {LOCAL_SERVERS[cfg.local.server].note}
        {#if cfg.local.server === "ollama"}
          For example: <code>OLLAMA_ORIGINS={appOrigin()} ollama serve</code>
        {/if}
      </p>
    {:else if cfg.backend === "selfhosted"}
      <div class="grid3">
        <div>
          <label for="st-sh-url">Server URL</label>
          <input id="st-sh-url" type="url" spellcheck="false" placeholder="https://llm.example.com/v1" bind:value={cfg.selfhosted.url} onchange={save} />
        </div>
        <div>
          <label for="st-sh-model">Model</label>
          <input id="st-sh-model" type="text" placeholder="e.g. Qwen/Qwen2.5-VL-7B-Instruct" bind:value={cfg.selfhosted.model} onchange={save} />
        </div>
        <div>
          <label for="st-sh-key">API key (optional)</label>
          <input id="st-sh-key" type="password" placeholder="Bearer token, if required" bind:value={cfg.selfhosted.apiKey} onchange={save} />
        </div>
      </div>
      <p class="muted small">
        Any server that speaks the OpenAI chat-completions API with image
        input: vLLM, LiteLLM, llama.cpp, TGI, or Ollama on another machine.
        Point the URL at its <code>/v1</code> root and allow CORS from this page.
      </p>
    {:else}
      <div class="grid2">
        <div>
          <label for="st-provider">Provider</label>
          <select id="st-provider" bind:value={cfg.cloud.provider} onchange={onProviderChange}>
            {#each Object.values(PROVIDERS) as p (p.id)}
              <option value={p.id}>{p.label}{p.free ? " · free" : ""}</option>
            {/each}
          </select>
        </div>
        <div>
          <label for="st-model">Model</label>
          <input id="st-model" type="text" list="st-models" bind:value={cfg.cloud.model} onchange={save} />
          <datalist id="st-models">
            {#each PROVIDERS[cfg.cloud.provider].models as m (m)}
              <option value={m}></option>
            {/each}
          </datalist>
        </div>
      </div>
      <p class="muted small">{PROVIDERS[cfg.cloud.provider].note}</p>
      <div class="grid2">
        <div>
          <label for="st-key">API key {app.userEmail && cfg.cloud.provider === "openrouter" ? "(optional, server proxy is used)" : ""}</label>
          <input
            id="st-key"
            type="password"
            placeholder={app.userEmail && cfg.cloud.provider === "openrouter" ? "handled by your account" : "sk-…"}
            bind:value={cfg.cloud.apiKey}
            onchange={save}
          />
          <a class="small" href={PROVIDERS[cfg.cloud.provider].keyUrl} target="_blank" rel="noopener">
            Get a key ↗
          </a>
        </div>
        <div>
          <label for="st-cap">Spend cap (USD, 0 = uncapped)</label>
          <input id="st-cap" type="number" min="0" step="0.5" bind:value={spendCap} onchange={save} />
          <span class="muted small">Spent so far: {formatMoney(cfg.spentUsd)}</span>
        </div>
      </div>
    {/if}

    <div class="choice">
      <span class="field-label" aria-hidden="true">How it reads</span>
      <Segmented label="How it reads" options={strategyOptions} value={cfg.strategy} onchange={onStrategy} />
      <p class="muted small">{STRATEGIES[cfg.strategy].note}</p>
      {#if cfg.strategy === "agentic" && viaAccount}
        <p class="warn small">
          Through your account the assist runs one-shot: the server proxy
          relays a single read. Add your own key above to run it agentic.
        </p>
      {/if}
    </div>

    <div class="row">
      <button class="btn btn-sm" onclick={testConnection} disabled={testing}>
        {testing ? "Testing…" : "Test connection"}
      </button>
      <!-- Always present so its insertion is announced. -->
      <span class="muted small" role="status" aria-live="polite">{testMsg}</span>
    </div>
  {/if}
</section>

<style>
  .choice {
    display: grid;
    gap: 0.45rem;
  }
  .choice p {
    margin: 0;
  }
  .field-label {
    font: 600 0.8rem/1.2 var(--font-ui);
    color: var(--ink-soft);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .warn {
    color: var(--gold-text);
    margin: 0;
  }
</style>
