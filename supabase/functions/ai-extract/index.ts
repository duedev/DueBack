// ai-extract — OpenAI-compatible chat-completions proxy for the vision assist.
//
// Why: the client-side AI booster needs an API key. Anonymous users bring
// their own (stored locally); signed-in users call THIS function instead, so
// the real OpenRouter key lives only in Supabase function secrets and never
// reaches a browser.
//
// The endpoint mirrors POST /chat/completions, so the app's existing
// OpenRouter provider works unchanged by pointing its baseUrl at
//   {SUPABASE_URL}/functions/v1/ai-extract
// and sending the user's Supabase access token as the bearer key.
//
// The payload is policed, not passed through verbatim: only allowlisted models
// (the server key would otherwise pay for ANY model a curl-wielding user
// names), a capped max_tokens, and a per-user daily request limit counted in
// the ai_usage table (migration 0003) — the client's spendCapUsd is advisory.
//
// Secrets (supabase secrets set):
//   OPENROUTER_API_KEY — the server-held key
//   AI_ALLOWED_MODELS  — optional comma-separated model allowlist
//                        (default: the client's free router, "openrouter/free")
//   AI_DAILY_LIMIT     — optional per-user daily request cap (default 200)
// Built-ins provided by the platform: SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  allowedModels,
  capMaxTokens,
  CORS_ALLOWED_REQUEST_HEADERS,
  dailyLimit,
  messagesProblem,
  policeBody,
} from "./policy.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_BODY_BYTES = 8 * 1024 * 1024; // images are downscaled client-side

const CORS = {
  "Access-Control-Allow-Origin": "*",
  // The client also sends OpenRouter's attribution pair (HTTP-Referer, X-Title);
  // a preflight that omits them blocks the whole signed-in path.
  "Access-Control-Allow-Headers": CORS_ALLOWED_REQUEST_HEADERS,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  // 1. The caller must be a signed-in user of this project.
  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  if (!jwt) return json(401, { error: "missing bearer token" });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${jwt}` } } },
  );
  const { data: userRes, error: userErr } = await supa.auth.getUser(jwt);
  if (userErr || !userRes?.user) return json(401, { error: "invalid session" });

  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) return json(503, { error: "OPENROUTER_API_KEY secret not set" });

  // 2. Bounded, policed chat-completions payload. The declared length is
  //    checked BEFORE buffering — the byte check below only ran after the
  //    whole body had been read into memory.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json(413, { error: "body too large" });
  }
  const raw = await req.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) return json(413, { error: "body too large" });
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    body = parsed;
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  const allowed = allowedModels(Deno.env.get("AI_ALLOWED_MODELS"));
  const model = typeof body.model === "string" ? body.model : "";
  if (!allowed.includes(model)) {
    return json(403, { error: `model "${model}" is not allowed by this deployment` });
  }
  // Only allowlisted fields go upstream: a sibling `models`/`route`/`plugins`
  // field would otherwise route around the model check on the server key.
  body = policeBody(body);
  body.max_tokens = capMaxTokens(body.max_tokens);
  // The messages themselves: the receipt request shape only (one inline
  // image, bounded text) — the server key must not fetch remote URLs or
  // relay arbitrary prompts.
  const problem = messagesProblem(body.messages);
  if (problem) return json(400, { error: problem });

  // 3. Per-user daily cap, counted server-side in ai_usage (service role —
  // the table's RLS denies clients so counts can't be forged or read).
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: used, error: usageErr } = await admin.rpc("ai_increment_usage", {
    p_user: userRes.user.id,
  });
  if (usageErr) {
    // The deployer's cue goes to the function log, not to the browser
    // (PostgREST text named schema internals).
    console.error("[ai-extract] ai_increment_usage failed", usageErr);
    return json(503, { error: "usage tracking unavailable (is migration 0003 applied?)" });
  }
  if ((used ?? 0) > dailyLimit(Deno.env.get("AI_DAILY_LIMIT"))) {
    return json(429, { error: "daily AI request limit reached" });
  }

  // Answer BEFORE the client's own 90 s deadline (vision/providers/shared.ts)
  // with a clean JSON 504, instead of the browser seeing a network error —
  // and never hold the function open on a stalled upstream.
  const UPSTREAM_TIMEOUT_MS = 85_000;
  let upstream: Response;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "http-referer": "https://dueback.duanehamilton.net",
        "x-title": "DueBack",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return json(timedOut ? 504 : 502, {
      error: timedOut
        ? `upstream timed out after ${UPSTREAM_TIMEOUT_MS / 1000} s`
        : `upstream unreachable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const resBody = await upstream.text();
  return new Response(resBody, {
    status: upstream.status,
    headers: { "content-type": "application/json", ...CORS },
  });
});
