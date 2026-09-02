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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  // A JSON `null` or array body used to throw on property access and come
  // back as a CORS-less 500.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json(400, { error: "body must be a JSON object" });
  }
  const { embedding, count } = body as Record<string, unknown>;
  // Every element must be a finite number — pgvector rejects NaN/Infinity,
  // and a string element would reach the RPC as SQL text.
  if (
    !Array.isArray(embedding) ||
    embedding.length !== 512 ||
    !embedding.every((x) => typeof x === "number" && Number.isFinite(x))
  ) {
    return json(400, { error: "embedding must be number[512]" });
  }
  // Clamped and floored to a valid int; junk falls back to the documented 3.
  const matchCount =
    typeof count === "number" && Number.isFinite(count)
      ? Math.min(10, Math.max(1, Math.floor(count)))
      : 3;

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${jwt}` } } },
  );
  const { data, error } = await supa.rpc("match_brand_logos", {
    query: `[${embedding.join(",")}]`,
    match_count: matchCount,
  });
  if (error) return json(500, { error: error.message });
  return json(200, { hits: data ?? [] });
});
