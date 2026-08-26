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
