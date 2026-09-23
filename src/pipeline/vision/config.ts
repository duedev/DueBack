import type { Backend, LocalServerId, ProviderId, Strategy } from "./types.ts";

// A built-in OpenRouter key for the FREE Models Router, injected at BUILD time
// (never committed to source). Vite replaces `__OPENROUTER_FREE_KEY__` with the
// value of OPENROUTER_API_KEY / VITE_OPENROUTER_FREE_KEY from the build env (see
// vite.config.ts); it is "" when the build provides no key. The `typeof` guard
// keeps this safe in non-Vite contexts (the Node test runner), where the global
// is undefined. A user's own key (Settings) always wins, and this fallback is
// only ever used for OpenRouter free routing — never paid models.
declare const __OPENROUTER_FREE_KEY__: string;
export const BUILTIN_OPENROUTER_KEY: string =
  typeof __OPENROUTER_FREE_KEY__ === "string" ? __OPENROUTER_FREE_KEY__ : "";

/** Whether a built-in OpenRouter free key was baked in at build time. */
export function hasBuiltInOpenRouterKey(): boolean {
  return BUILTIN_OPENROUTER_KEY.length > 0;
}

// Tier 3 configuration: WHERE the model runs (backend) and HOW it reads
// (strategy) are independent choices, and each backend keeps its own settings
// so flipping the toggle never loses what was typed for another. The tier is
// OFF by default UNLESS a build-time key is present, in which case the first
// run auto-enables the cloud OpenRouter free router (zero-click).

export interface CloudSettings {
  provider: ProviderId;
  model: string;
  apiKey: string;
}

export interface LocalSettings {
  server: LocalServerId;
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1. */
  url: string;
  model: string;
}

export interface SelfHostedSettings {
  /** OpenAI-compatible base URL of your own server (vLLM, LiteLLM, …). */
  url: string;
  model: string;
  /** Optional bearer token; many private servers need none. */
  apiKey: string;
}

export interface VisionConfig {
  enabled: boolean;
  backend: Backend;
  strategy: Strategy;
  cloud: CloudSettings;
  local: LocalSettings;
  selfhosted: SelfHostedSettings;
  /** Cumulative spend cap in USD for CLOUD calls; 0 = uncapped. Local and
   *  self-hosted calls cost nothing we can measure and are never capped. */
  spendCapUsd: number;
  /** Running total spent on paid calls (the "this cost you $X" line, honestly). */
  spentUsd: number;
}

/** A save: top-level fields replace, the per-backend groups merge. */
export type VisionConfigPatch = Partial<
  Omit<VisionConfig, "cloud" | "local" | "selfhosted">
> & {
  cloud?: Partial<CloudSettings>;
  local?: Partial<LocalSettings>;
  selfhosted?: Partial<SelfHostedSettings>;
};

// ── UI metadata ──────────────────────────────────────────────────────────────

export interface ChoiceMeta<T extends string> {
  id: T;
  label: string;
  /** One line under the toggle explaining the choice. */
  note: string;
}

export const BACKENDS: Record<Backend, ChoiceMeta<Backend>> = {
  local: {
    id: "local",
    label: "Local",
    note: "A model server on this computer (Ollama, LM Studio). Receipts never leave the machine, and it costs nothing.",
  },
  selfhosted: {
    id: "selfhosted",
    label: "Self-hosted",
    note: "Your own OpenAI-compatible server (vLLM, LiteLLM, llama.cpp, a remote Ollama). Receipts go only to that server.",
  },
  cloud: {
    id: "cloud",
    label: "Cloud",
    note: "A hosted API provider. The most capable models; receipts are sent to that provider.",
  },
};

export const STRATEGIES: Record<Strategy, ChoiceMeta<Strategy>> = {
  oneshot: {
    id: "oneshot",
    label: "One-shot",
    note: "One call: the model looks at the image and returns the fields. Fast and cheap; works with any vision model.",
  },
  agentic: {
    id: "agentic",
    label: "Agentic",
    note: "A short tool loop: the model also sees the on-device text read and can check the arithmetic, look the brand up and search the text before it answers. Up to 5 calls; needs a model with tool support.",
  },
};

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  defaultModel: string;
  /** Whether the default model/tier is free of marginal cost. */
  free: boolean;
  keyUrl: string;
  note: string;
  /** Suggested model ids (the field is free-text — any id works). */
  models: string[];
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter (free router)",
    defaultModel: "openrouter/free",
    free: true,
    keyUrl: "https://openrouter.ai/keys",
    note: "Free Models Router: auto-picks a quick, reliable free model that supports vision. $0 (≈50 requests/day free, 1000/day with ≥10 credits). The same key also reaches paid Claude/Gemini if you type their model id.",
    models: [
      "openrouter/free",
      "qwen/qwen2.5-vl-72b-instruct:free",
      "meta-llama/llama-3.2-11b-vision-instruct:free",
      "anthropic/claude-haiku-4.5",
      "google/gemini-2.5-flash",
    ],
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    defaultModel: "gemini-2.5-flash",
    free: true,
    keyUrl: "https://aistudio.google.com/apikey",
    note: "Generous no-card free tier with native vision. Free-tier prompts may be used by Google to improve their products.",
    models: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"],
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    defaultModel: "claude-haiku-4-5",
    free: false,
    keyUrl: "https://console.anthropic.com/settings/keys",
    note: "Highest accuracy on hard/degraded receipts. ~a fraction of a cent per receipt on Haiku 4.5.",
    models: ["claude-haiku-4-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-opus-5", "claude-opus-4-8"],
  },
};

export interface LocalServerMeta {
  id: LocalServerId;
  label: string;
  url: string;
  defaultModel: string;
  models: string[];
  /** Setup hint: what the server needs before a browser tab may call it. */
  note: string;
}

export const LOCAL_SERVERS: Record<LocalServerId, LocalServerMeta> = {
  ollama: {
    id: "ollama",
    label: "Ollama",
    url: "http://localhost:11434/v1",
    defaultModel: "qwen2.5vl:7b",
    models: ["qwen2.5vl:7b", "qwen2.5vl:3b", "qwen3-vl:8b", "gemma3:12b", "llama3.2-vision:11b", "mistral-small3.2"],
    note: "Pull a vision model (ollama pull qwen2.5vl:7b) and let this site call it: start Ollama with OLLAMA_ORIGINS set to this page's origin. Agentic needs a model with tool support (qwen3-vl, mistral-small3.2).",
  },
  lmstudio: {
    id: "lmstudio",
    label: "LM Studio",
    url: "http://localhost:1234/v1",
    defaultModel: "qwen2.5-vl-7b-instruct",
    models: ["qwen2.5-vl-7b-instruct", "gemma-3-12b-it", "mistral-small-3.2-24b-instruct"],
    note: "Load a vision model, start the local server and switch on \"Enable CORS\" in its settings. Use the model id LM Studio shows.",
  },
  custom: {
    id: "custom",
    label: "Other (OpenAI-compatible)",
    url: "http://localhost:8080/v1",
    defaultModel: "",
    models: [],
    note: "Any OpenAI-compatible server on this machine (llama.cpp server, LocalAI, Jan…). It must allow cross-origin requests from this page.",
  },
};

// ── Storage ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = "ro.vision.config.v2";
/** The single-provider config shape before backends existed; read once and
 *  migrated (see `normalizeVisionConfig`), never written again. */
const LEGACY_STORAGE_KEY = "ro.vision.config.v1";

export function defaultVisionConfig(builtIn: string = BUILTIN_OPENROUTER_KEY): VisionConfig {
  return {
    // Zero-click: a build that bakes in a free key opts into the tier by
    // default (low-confidence receipts use the OpenRouter free router). A
    // keyless build stays off, preserving the on-device-only promise until
    // a user turns it on.
    enabled: builtIn.length > 0,
    backend: "cloud",
    strategy: "oneshot",
    cloud: { provider: "openrouter", model: PROVIDERS.openrouter.defaultModel, apiKey: "" },
    local: {
      server: "ollama",
      url: LOCAL_SERVERS.ollama.url,
      model: LOCAL_SERVERS.ollama.defaultModel,
    },
    selfhosted: { url: "", model: "", apiKey: "" },
    spendCapUsd: 1,
    spentUsd: 0,
  };
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}
function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Turn whatever storage holds into a well-formed config: fields of the wrong
 * type fall back to defaults, and a v1 record (flat `provider`/`model`/
 * `apiKey`/`baseUrl`) is migrated — its provider becomes the cloud backend,
 * and a v1 `baseUrl` on OpenRouter (an OpenAI-compatible proxy) becomes the
 * self-hosted server it effectively was. Pure; Node-tested.
 */
export function normalizeVisionConfig(
  raw: unknown,
  builtIn: string = BUILTIN_OPENROUTER_KEY,
): VisionConfig {
  const d = defaultVisionConfig(builtIn);
  const r = obj(raw);
  const legacy = !("backend" in r) && ("provider" in r || "apiKey" in r || "model" in r);
  if (legacy) {
    const provider = pick<ProviderId>(r.provider, ["openrouter", "gemini", "anthropic"], "openrouter");
    const model = str(r.model, PROVIDERS[provider].defaultModel);
    const apiKey = str(r.apiKey, "");
    const baseUrl = str(r.baseUrl, "").trim();
    const asProxy = baseUrl !== "" && provider === "openrouter";
    return {
      ...d,
      enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
      backend: asProxy ? "selfhosted" : "cloud",
      cloud: { provider, model, apiKey },
      selfhosted: asProxy ? { url: baseUrl, model, apiKey } : d.selfhosted,
      spendCapUsd: Math.max(0, num(r.spendCapUsd, d.spendCapUsd)),
      spentUsd: Math.max(0, num(r.spentUsd, d.spentUsd)),
    };
  }
  const c = obj(r.cloud);
  const l = obj(r.local);
  const s = obj(r.selfhosted);
  const provider = pick<ProviderId>(c.provider, ["openrouter", "gemini", "anthropic"], d.cloud.provider);
  const server = pick<LocalServerId>(l.server, ["ollama", "lmstudio", "custom"], d.local.server);
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    backend: pick<Backend>(r.backend, ["local", "selfhosted", "cloud"], d.backend),
    strategy: pick<Strategy>(r.strategy, ["oneshot", "agentic"], d.strategy),
    cloud: {
      provider,
      model: str(c.model, PROVIDERS[provider].defaultModel),
      apiKey: str(c.apiKey, ""),
    },
    local: {
      server,
      url: str(l.url, LOCAL_SERVERS[server].url),
      model: str(l.model, LOCAL_SERVERS[server].defaultModel),
    },
    selfhosted: {
      url: str(s.url, ""),
      model: str(s.model, ""),
      apiKey: str(s.apiKey, ""),
    },
    spendCapUsd: Math.max(0, num(r.spendCapUsd, d.spendCapUsd)),
    spentUsd: Math.max(0, num(r.spentUsd, d.spentUsd)),
  };
}

/** Apply a patch: top-level fields replace, backend groups merge. Pure. */
export function mergeVisionConfig(base: VisionConfig, patch: VisionConfigPatch): VisionConfig {
  const { cloud, local, selfhosted, ...top } = patch;
  return {
    ...base,
    ...top,
    cloud: { ...base.cloud, ...cloud },
    local: { ...base.local, ...local },
    selfhosted: { ...base.selfhosted, ...selfhosted },
  };
}

function readStored(): unknown {
  const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

export function getVisionConfig(): VisionConfig {
  // The typeof test sits INSIDE the try: in a storage-blocked iframe the
  // global exists but its getter throws, and `typeof` still runs the getter
  // — Settings (now one tap from the landing) failed to mount there.
  try {
    if (typeof localStorage === "undefined") return defaultVisionConfig();
    return normalizeVisionConfig(readStored());
  } catch {
    return defaultVisionConfig();
  }
}

export function saveVisionConfig(patch: VisionConfigPatch): VisionConfig {
  const next = mergeVisionConfig(getVisionConfig(), patch);
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage may be unavailable (private mode); config just won't persist */
    }
  }
  return next;
}

// ── Spend ────────────────────────────────────────────────────────────────────

export function withinBudget(cfg: VisionConfig = getVisionConfig(), projected = 0): boolean {
  if (cfg.spendCapUsd <= 0) return true; // 0 means uncapped
  return cfg.spentUsd + projected <= cfg.spendCapUsd + 1e-9;
}

export function recordSpend(cost: number): void {
  if (!(cost > 0)) return;
  const cfg = getVisionConfig();
  saveVisionConfig({ spentUsd: Math.round((cfg.spentUsd + cost) * 1e6) / 1e6 });
}
