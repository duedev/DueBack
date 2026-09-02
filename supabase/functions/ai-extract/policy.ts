// Pure request-policy helpers for ai-extract, split from index.ts so the Node
// test suite can exercise them (index.ts needs the Deno runtime).

// The client's default free-router model id (src/pipeline/vision/config.ts,
// PROVIDERS.openrouter.defaultModel) — the only model the server key pays for
// unless the deployer widens the list via AI_ALLOWED_MODELS.
export const DEFAULT_ALLOWED_MODEL = "openrouter/free";

export const MAX_TOKENS_CEILING = 4096;

export const DEFAULT_DAILY_LIMIT = 200;

/** Request headers the browser may send (CORS preflight). The client's
 *  OpenRouter attribution pair stays listed so a direct-style call passes;
 *  through the proxy the client omits them (providers/openrouter.ts
 *  openRouterHeaders) because the function stamps its own. apikey and
 *  x-client-info are Supabase's template entries (functions.invoke). */
export const CORS_ALLOWED_REQUEST_HEADERS =
  "authorization, content-type, http-referer, x-title, apikey, x-client-info";

/** Bounds on what a message may carry to the model on the server key. */
export const MAX_TEXT_CHARS = 8_000;
/** A 1600 px JPEG data URL is well under 1 MB; 4 MB leaves headroom. */
export const MAX_IMAGE_DATA_URL_CHARS = 4 * 1024 * 1024;

/** Why the chat messages must be refused, or null when they are the receipt
 *  request shape: 1–2 entries with system/user roles, text bounded, at most
 *  one image and only an inline data:image/ URL — a remote URL would have
 *  the deployer's key fetch arbitrary hosts; a bare string body is fine.
 *  Malformed input is rejected, never trimmed into something else. */
export function messagesProblem(messages: unknown): string | null {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 2) {
    return "messages must hold 1–2 entries";
  }
  let images = 0;
  for (const m of messages) {
    if (typeof m !== "object" || m === null || Array.isArray(m)) return "message must be an object";
    const { role, content } = m as Record<string, unknown>;
    if (role !== "system" && role !== "user") return `message role "${String(role)}" is not allowed`;
    if (typeof content === "string") {
      if (content.length > MAX_TEXT_CHARS) return "message text too long";
      continue;
    }
    if (!Array.isArray(content) || content.length < 1 || content.length > 2) {
      return "message content must be text or 1–2 parts";
    }
    for (const part of content) {
      if (typeof part !== "object" || part === null) return "message part must be an object";
      const p = part as Record<string, unknown>;
      if (p.type === "text") {
        if (typeof p.text !== "string" || p.text.length > MAX_TEXT_CHARS) return "message text too long";
      } else if (p.type === "image_url") {
        const url = (p.image_url as Record<string, unknown> | undefined)?.url;
        if (typeof url !== "string" || !url.startsWith("data:image/")) {
          return "image must be an inline data:image/ URL";
        }
        if (url.length > MAX_IMAGE_DATA_URL_CHARS) return "image too large";
        if (++images > 1) return "at most one image per request";
      } else {
        return `message part type "${String(p.type)}" is not allowed`;
      }
    }
  }
  return null;
}

/** Parse AI_ALLOWED_MODELS (comma-separated); unset/blank → the client default. */
export function allowedModels(env: string | undefined): string[] {
  const list = (env ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return list.length ? list : [DEFAULT_ALLOWED_MODEL];
}

/** The max_tokens to forward: the caller's value bounded to the ceiling.
 *  Missing/junk values become the ceiling itself, so a bound always exists. */
export function capMaxTokens(value: unknown, ceiling = MAX_TOKENS_CEILING): number {
  const n =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : ceiling;
  return Math.min(Math.max(1, n), ceiling);
}

/** Parse AI_DAILY_LIMIT; unset/junk/non-positive → the default. */
export function dailyLimit(env: string | undefined): number {
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DAILY_LIMIT;
}

/** The request fields the proxy forwards. Everything else the client sends —
 *  OpenRouter's `models` list, `route`, `plugins`, `transforms`, `tools`… — is
 *  dropped, so the model allowlist can't be bypassed by naming other models
 *  in a sibling field, and only vetted knobs reach the server key. */
export const FORWARDED_FIELDS = [
  "model",
  "messages",
  "max_tokens",
  "temperature",
  "usage",
  "provider",
  "response_format",
] as const;

/** Rebuild the upstream body from the allowlisted fields only. The `provider`
 *  routing preferences keep just the three knobs the client uses. */
export function policeBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of FORWARDED_FIELDS) if (k in body) out[k] = body[k];
  const p = out.provider;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const src = p as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    if (typeof src.sort === "string") kept.sort = src.sort;
    if (typeof src.allow_fallbacks === "boolean") kept.allow_fallbacks = src.allow_fallbacks;
    if (typeof src.require_parameters === "boolean") {
      kept.require_parameters = src.require_parameters;
    }
    out.provider = kept;
  } else {
    delete out.provider;
  }
  // The remaining knobs are bounded, not passed through: temperature within
  // [0, 2] or dropped, usage only as {include: true}, response_format only
  // the two JSON modes the client uses.
  const t = out.temperature;
  if (!(typeof t === "number" && Number.isFinite(t) && t >= 0 && t <= 2)) delete out.temperature;
  const u = out.usage as Record<string, unknown> | undefined;
  if (u && typeof u === "object" && !Array.isArray(u) && u.include === true) out.usage = { include: true };
  else delete out.usage;
  const rf = out.response_format as Record<string, unknown> | undefined;
  if (!(rf && typeof rf === "object" && (rf.type === "json_schema" || rf.type === "json_object"))) {
    delete out.response_format;
  }
  return out;
}
