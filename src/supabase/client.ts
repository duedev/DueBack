import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Optional cloud sync — config-less by design. The app is local-first and fully
// functional with no backend; when a build provides VITE_SUPABASE_URL +
// VITE_SUPABASE_ANON_KEY (see SUPABASE_SETUP.md), signing in unlocks cloud
// persistence, multi-device sync, and the server-keyed AI booster. Without
// them, `supabase()` returns null and every sync surface stays hidden.

const URL_ = (import.meta.env?.VITE_SUPABASE_URL as string | undefined) ?? "";
const KEY = (import.meta.env?.VITE_SUPABASE_ANON_KEY as string | undefined) ?? "";

let client: SupabaseClient | null = null;

/** True when this build was configured with a Supabase project. */
export function syncConfigured(): boolean {
  return URL_.length > 0 && KEY.length > 0;
}

export function supabase(): SupabaseClient | null {
  if (!syncConfigured()) return null;
  if (!client) {
    client = createClient(URL_, KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return client;
}

/** Base URL for the project's Edge Functions ("" when unconfigured). */
export function functionsUrl(): string {
  return URL_ ? `${URL_.replace(/\/$/, "")}/functions/v1` : "";
}
