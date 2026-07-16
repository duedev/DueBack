import type { OneDriveAccount, OneDriveTokens } from "./core.ts";

// Build-time config + local token persistence. Config-less by design, like
// the Supabase layer: without VITE_ONEDRIVE_CLIENT_ID every OneDrive surface
// stays hidden. Tokens live in localStorage only — they never touch any
// server of ours (there isn't one).

const CLIENT_ID =
  (import.meta.env?.VITE_ONEDRIVE_CLIENT_ID as string | undefined) ?? "";

/** "common" signs in both personal and work/school Microsoft accounts;
 *  deployments can pin a tenant id to lock it to one organization. */
export const ONEDRIVE_TENANT =
  (import.meta.env?.VITE_ONEDRIVE_TENANT as string | undefined) || "common";

const REDIRECT_OVERRIDE =
  (import.meta.env?.VITE_ONEDRIVE_REDIRECT_URI as string | undefined) ?? "";

const LS_KEY = "onedrive.auth.v1";

/** True when this build was configured with an Azure app registration. */
export function oneDriveConfigured(): boolean {
  return CLIENT_ID.length > 0;
}

export function oneDriveClientId(): string {
  return CLIENT_ID;
}

/** The exact URL Microsoft redirects back to — must be registered (as a
 *  Single-page application) on the Azure app. Defaults to the app's own
 *  address with any trailing index.html stripped, so "/" and "/index.html"
 *  resolve to the same registered value. */
export function redirectUri(): string {
  if (REDIRECT_OVERRIDE) return REDIRECT_OVERRIDE;
  const path = location.pathname.replace(/index\.html?$/i, "");
  return location.origin + path;
}

export function loadTokens(): OneDriveTokens | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as OneDriveTokens;
    return t.accessToken ? t : null;
  } catch {
    return null;
  }
}

export function saveTokens(t: OneDriveTokens): void {
  localStorage.setItem(LS_KEY, JSON.stringify(t));
}

export function clearTokens(): void {
  localStorage.removeItem(LS_KEY);
}

/** The connected account (null when signed out) — for the Settings panel. */
export function oneDriveAccount(): OneDriveAccount | null {
  return loadTokens()?.account ?? null;
}

/** Sign out: forget the stored tokens. (Nothing server-side to revoke —
 *  there is no server; the grant itself is managed at microsoft.com.) */
export function disconnectOneDrive(): void {
  clearTokens();
}
