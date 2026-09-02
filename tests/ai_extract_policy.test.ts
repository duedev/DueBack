import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedModels,
  capMaxTokens,
  dailyLimit,
  DEFAULT_ALLOWED_MODEL,
  DEFAULT_DAILY_LIMIT,
  MAX_TOKENS_CEILING,
  CORS_ALLOWED_REQUEST_HEADERS,
  MAX_TEXT_CHARS,
  messagesProblem,
} from "../supabase/functions/ai-extract/policy.ts";
import { openRouterHeaders } from "../src/pipeline/vision/providers/openrouter.ts";

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

test("every header the client sends through the proxy is on the preflight allow-list", () => {
  const allowed = new Set(CORS_ALLOWED_REQUEST_HEADERS.split(",").map((h) => h.trim().toLowerCase()));
  const proxied = openRouterHeaders({
    apiKey: "session-token",
    model: "openrouter/free",
    baseUrl: "https://x.supabase.co/functions/v1/ai-extract",
  });
  for (const name of Object.keys(proxied)) {
    assert.ok(allowed.has(name.toLowerCase()), `${name} would fail the preflight`);
  }
  // Attribution is omitted through the proxy (the function stamps its own)…
  assert.equal("X-Title" in proxied, false);
  assert.equal("HTTP-Referer" in proxied, false);
  // …and kept on a direct call so OpenRouter attribution isn't lost.
  const direct = openRouterHeaders({ apiKey: "k", model: "openrouter/free" });
  assert.equal(direct["X-Title"], "DueBack");
  assert.ok(direct["HTTP-Referer"]);
});

test("messagesProblem accepts the receipt request and refuses everything else", () => {
  const image = { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } };
  const ok = [
    { role: "system", content: "You read receipts." },
    { role: "user", content: [{ type: "text", text: "Extract the fields." }, image] },
  ];
  assert.equal(messagesProblem(ok), null);
  assert.equal(messagesProblem([{ role: "user", content: "just text" }]), null);
  // A remote image would have the server key fetch arbitrary hosts.
  assert.match(
    messagesProblem([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://evil/x.jpg" } }] }])!,
    /inline data:image/,
  );
  assert.match(messagesProblem([{ role: "user", content: [image, image] }])!, /one image/);
  assert.match(messagesProblem([...ok, { role: "user", content: "again" }])!, /1–2 entries/);
  assert.match(messagesProblem([{ role: "assistant", content: "x" }])!, /role/);
  assert.match(messagesProblem([{ role: "user", content: "x".repeat(MAX_TEXT_CHARS + 1) }])!, /too long/);
  assert.match(messagesProblem([{ role: "user", content: [{ type: "tool", text: "x" }] }])!, /not allowed/);
  assert.match(messagesProblem("hello")!, /1–2 entries/);
});

test("the remaining knobs are bounded, never passed through", () => {
  const out = policeBody({
    model: "openrouter/free",
    messages: [],
    temperature: 5,
    usage: { include: false, other: true },
    response_format: { type: "text" },
  });
  assert.equal("temperature" in out, false);
  assert.equal("usage" in out, false);
  assert.equal("response_format" in out, false);
  const kept = policeBody({ model: "m", temperature: 0.2, usage: { include: true }, response_format: { type: "json_object" } });
  assert.equal(kept.temperature, 0.2);
  assert.deepEqual(kept.usage, { include: true });
  assert.deepEqual(kept.response_format, { type: "json_object" });
});
