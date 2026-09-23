import type { Backend, Dialect, Strategy } from "./types.ts";
import {
  BUILTIN_OPENROUTER_KEY,
  LOCAL_SERVERS,
  PROVIDERS,
  type VisionConfig,
} from "./config.ts";

// Resolve the config's backend choice into ONE concrete endpoint: which wire
// dialect to speak, where, with which key and model. Everything downstream
// (clients/, strategies/) works from an Endpoint and never re-reads the
// config, so adding a backend means adding a case here and nothing else.

export interface Endpoint {
  backend: Backend;
  dialect: Dialect;
  /** Human label for provenance and messages ("Ollama", "OpenRouter"…). */
  label: string;
  /** No trailing slash; the client appends its path. */
  baseUrl: string;
  /** "" is legal for local/self-hosted servers that take no key. */
  apiKey: string;
  model: string;
  /** OpenRouter-only request extras (provider routing, usage cost,
   *  attribution headers) apply. */
  openRouter: boolean;
  /** Routed through the signed-in ai-extract proxy (supabase/aiProxy.ts). */
  viaProxy: boolean;
  /** Whether calls cost money we can measure — the spend cap applies. */
  metered: boolean;
  timeoutMs: number;
}

/** Every provider call carries a deadline: a stalled model call otherwise
 *  parked the receipt in "processing" for good, because the job heartbeat
 *  kept its lock alive while the fetch never resolved. The ai-extract proxy
 *  answers at 85 s, inside the cloud deadline. */
export const CLOUD_TIMEOUT_MS = 90_000;
/** A 7B vision model on a laptop CPU can take minutes on a receipt photo. */
export const LOCAL_TIMEOUT_MS = 180_000;

/** True when the model uses OpenRouter's free routing (the router, or any
 *  `:free` model), where strict structured outputs are best avoided. */
export function usesFreeRouting(model: string): boolean {
  return model === "openrouter/free" || model.includes(":free");
}

const PROVIDER_BASE: Record<keyof typeof PROVIDERS, { dialect: Dialect; url: string; label: string }> = {
  openrouter: { dialect: "openai", url: "https://openrouter.ai/api/v1", label: "OpenRouter" },
  gemini: {
    dialect: "gemini",
    url: "https://generativelanguage.googleapis.com/v1beta",
    label: "Gemini",
  },
  anthropic: { dialect: "anthropic", url: "https://api.anthropic.com", label: "Anthropic" },
};

function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** The cloud key to send: the user's own key wins; otherwise the built-in
 *  free key, but only for OpenRouter's free routing (never for paid models).
 *  `builtIn` is injectable for tests; production uses the build-time value. */
export function cloudApiKey(
  cloud: VisionConfig["cloud"],
  builtIn: string = BUILTIN_OPENROUTER_KEY,
): string {
  const own = cloud.apiKey.trim();
  if (own) return own;
  if (cloud.provider === "openrouter" && usesFreeRouting(cloud.model)) return builtIn;
  return "";
}

/** The endpoint for the config's selected backend. Pure; Node-tested. */
export function resolveEndpoint(
  cfg: VisionConfig,
  builtIn: string = BUILTIN_OPENROUTER_KEY,
): Endpoint {
  switch (cfg.backend) {
    case "local":
      return {
        backend: "local",
        dialect: "openai",
        label: LOCAL_SERVERS[cfg.local.server].label,
        baseUrl: trimUrl(cfg.local.url),
        apiKey: "",
        model: cfg.local.model.trim(),
        openRouter: false,
        viaProxy: false,
        metered: false,
        timeoutMs: LOCAL_TIMEOUT_MS,
      };
    case "selfhosted":
      return {
        backend: "selfhosted",
        dialect: "openai",
        label: "Self-hosted",
        baseUrl: trimUrl(cfg.selfhosted.url),
        apiKey: cfg.selfhosted.apiKey.trim(),
        model: cfg.selfhosted.model.trim(),
        openRouter: false,
        viaProxy: false,
        metered: false,
        timeoutMs: LOCAL_TIMEOUT_MS,
      };
    case "cloud":
    default: {
      const base = PROVIDER_BASE[cfg.cloud.provider];
      return {
        backend: "cloud",
        dialect: base.dialect,
        label: base.label,
        baseUrl: base.url,
        apiKey: cloudApiKey(cfg.cloud, builtIn),
        model: cfg.cloud.model.trim(),
        openRouter: cfg.cloud.provider === "openrouter",
        viaProxy: false,
        metered: true,
        timeoutMs: CLOUD_TIMEOUT_MS,
      };
    }
  }
}

/** Why this endpoint can't be called yet (shown by "Test connection"), or
 *  null when it is ready. Pure; Node-tested. */
export function endpointProblem(ep: Endpoint): string | null {
  if (ep.backend === "cloud") {
    if (!ep.apiKey) return "Add an API key first.";
  } else if (!ep.baseUrl) {
    return "Set the server URL first.";
  } else if (!/^https?:\/\//i.test(ep.baseUrl)) {
    return "The server URL must start with http:// or https://.";
  }
  if (!ep.model) return "Pick a model first.";
  return null;
}

/** The strategy that will actually run: the ai-extract proxy relays exactly
 *  one image extraction (policy.messagesProblem refuses a tool loop), so a
 *  proxied call is always one-shot. */
export function effectiveStrategy(ep: Endpoint, wanted: Strategy): Strategy {
  return ep.viaProxy ? "oneshot" : wanted;
}
