// Pure request-policy helpers for ai-extract, split from index.ts so the Node
// test suite can exercise them (index.ts needs the Deno runtime).

// The client's default free-router model id (src/pipeline/vision/config.ts,
// PROVIDERS.openrouter.defaultModel) — the only model the server key pays for
// unless the deployer widens the list via AI_ALLOWED_MODELS.
export const DEFAULT_ALLOWED_MODEL = "openrouter/free";

export const MAX_TOKENS_CEILING = 4096;

export const DEFAULT_DAILY_LIMIT = 200;

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
