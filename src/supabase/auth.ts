import { supabase } from "./client.ts";
import type { Session, User } from "@supabase/supabase-js";

// Thin auth wrapper: Google OAuth + email magic links, both handled by
// Supabase Auth. No passwords stored or handled by this app.

export interface AuthState {
  user: User | null;
  session: Session | null;
}

export async function currentUser(): Promise<User | null> {
  const c = supabase();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  return data.session?.user ?? null;
}

export function onAuthChange(
  cb: (state: AuthState) => void,
): () => void {
  const c = supabase();
  if (!c) return () => {};
  const { data } = c.auth.onAuthStateChange((_event, session) => {
    cb({ user: session?.user ?? null, session });
  });
  return () => data.subscription.unsubscribe();
}

export async function signInWithGoogle(): Promise<void> {
  const c = supabase();
  if (!c) return;
  await c.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
}

export async function signInWithEmail(email: string): Promise<{ error?: string }> {
  const c = supabase();
  if (!c) return { error: "Sync is not configured in this build." };
  const { error } = await c.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  return error ? { error: error.message } : {};
}

export async function signOut(): Promise<void> {
  await supabase()?.auth.signOut();
}

/** Access token for calling the project's Edge Functions as this user. */
export async function accessToken(): Promise<string | null> {
  const c = supabase();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  return data.session?.access_token ?? null;
}
