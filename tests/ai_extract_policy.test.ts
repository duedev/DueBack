import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedModels,
  capMaxTokens,
  dailyLimit,
  DEFAULT_ALLOWED_MODEL,
  DEFAULT_DAILY_LIMIT,
  MAX_TOKENS_CEILING,
} from "../supabase/functions/ai-extract/policy.ts";

test("model allowlist defaults to the client's free router", () => {
  assert.deepEqual(allowedModels(undefined), [DEFAULT_ALLOWED_MODEL]);
  assert.deepEqual(allowedModels(""), ["openrouter/free"]);
  assert.deepEqual(allowedModels("  ,  "), ["openrouter/free"], "blank entries don't allow-all");
});

test("model allowlist parses AI_ALLOWED_MODELS with trimming", () => {
  const allowed = allowedModels(" openrouter/free , google/gemini-2.5-flash ");
  assert.deepEqual(allowed, ["openrouter/free", "google/gemini-2.5-flash"]);
  assert.ok(allowed.includes("google/gemini-2.5-flash"));
  assert.ok(!allowed.includes("anthropic/claude-opus-4-8"), "unlisted paid models stay out");
});

test("max_tokens is always overwritten to a bounded value", () => {
  assert.equal(capMaxTokens(undefined), MAX_TOKENS_CEILING, "missing → the ceiling itself");
  assert.equal(capMaxTokens(1024), 1024, "a sane value passes through");
  assert.equal(capMaxTokens(1_000_000), MAX_TOKENS_CEILING, "huge asks are capped");
  assert.equal(capMaxTokens("999999"), MAX_TOKENS_CEILING, "non-numbers are replaced");
  assert.equal(capMaxTokens(-5), 1, "nonsense lows clamp to 1, not 0/negative");
  assert.equal(capMaxTokens(Infinity), MAX_TOKENS_CEILING);
});

test("daily limit parses AI_DAILY_LIMIT and defaults to 200", () => {
  assert.equal(dailyLimit(undefined), DEFAULT_DAILY_LIMIT);
  assert.equal(DEFAULT_DAILY_LIMIT, 200);
  assert.equal(dailyLimit("50"), 50);
  assert.equal(dailyLimit("50.9"), 50);
  assert.equal(dailyLimit("0"), DEFAULT_DAILY_LIMIT, "0/junk can't disable the cap");
  assert.equal(dailyLimit("-1"), DEFAULT_DAILY_LIMIT);
  assert.equal(dailyLimit("lots"), DEFAULT_DAILY_LIMIT);
});

// ── Audit round (2026-09) ─────────────────────────────────────────────────────
import { policeBody, FORWARDED_FIELDS } from "../supabase/functions/ai-extract/policy.ts";
import { PROVIDERS } from "../src/pipeline/vision/config.ts";

test("the proxy forwards only allowlisted fields; sibling model routes are dropped", () => {
  const out = policeBody({
    model: "openrouter/free",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 700,
    temperature: 0,
    usage: { include: true },
    provider: { sort: "throughput", allow_fallbacks: true, order: ["anthropic"], only: ["x"] },
    response_format: { type: "json_schema" },
    models: ["anthropic/claude-opus-4"], // a fallback list that bypasses `model`
    route: "fallback",
    plugins: [{ id: "web" }],
    transforms: ["middle-out"],
    tools: [{ type: "function" }],
  });
  assert.deepEqual(Object.keys(out).sort(), [...FORWARDED_FIELDS].sort());
  assert.deepEqual(out.provider, { sort: "throughput", allow_fallbacks: true });
  assert.equal("models" in out, false);
  assert.equal("route" in out, false);
  // A non-object provider is dropped rather than forwarded.
  assert.equal("provider" in policeBody({ model: "m", provider: ["x"] }), false);
});

test("the proxy's default model stays in sync with the client's OpenRouter default", () => {
  assert.equal(DEFAULT_ALLOWED_MODEL, PROVIDERS.openrouter.defaultModel);
});
