// logo-search — optional pgvector nearest-neighbor lookup for brand logos.
//
// The client bundles its logo index and searches locally; this function is the
// growth path for when the index lives server-side (migration 0002). Body:
//   { "embedding": number[512], "count": 3 }
// Returns: { "hits": [{ name, category, score }] }
// Auth: the caller's Supabase session (RLS scopes rows to that user).

import { createClient } from "jsr:@supabase/supabase-js@2";

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

  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  if (!jwt) return json(401, { error: "missing bearer token" });

  let body: { embedding?: number[]; count?: number };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  const embedding = body.embedding;
  if (!Array.isArray(embedding) || embedding.length !== 512) {
    return json(400, { error: "embedding must be number[512]" });
  }

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${jwt}` } } },
  );
  const { data, error } = await supa.rpc("match_brand_logos", {
    query: `[${embedding.join(",")}]`,
    match_count: Math.min(10, Math.max(1, body.count ?? 3)),
  });
  if (error) return json(500, { error: error.message });
  return json(200, { hits: data ?? [] });
});
