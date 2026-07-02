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
// Secrets (supabase secrets set):
//   OPENROUTER_API_KEY  — the server-held key
// Built-ins provided by the platform: SUPABASE_URL, SUPABASE_ANON_KEY.

import { createClient } from "jsr:@supabase/supabase-js@2";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_BODY_BYTES = 8 * 1024 * 1024; // images are downscaled client-side

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
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

  // 2. Bounded passthrough of the chat-completions payload.
  const raw = await req.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) return json(413, { error: "body too large" });

  const upstream = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      "http-referer": "https://github.com/duedev/ReimbursementsF5",
      "x-title": "Reimbursements F5",
    },
    body: raw,
  });

  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { "content-type": "application/json", ...CORS },
  });
});
