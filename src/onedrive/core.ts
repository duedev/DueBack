// OneDrive integration — the pure half. Everything here is DOM-free and
// Node-tested (tests/onedrive.test.ts): PKCE math, endpoint/URL building,
// token-response mapping, and the Graph upload calls with an injectable
// fetch. The browser half (popup dance, token persistence) lives in
// index.ts/store.ts. No SDK: the app talks OAuth2 + Microsoft Graph
// directly, in keeping with the repo's dependency-light style.

/** Marks our OAuth `state` so the popup callback can't be confused with any
 *  other `?code=` redirect that lands on the app (Supabase magic links use
 *  the same query param). */
export const STATE_PREFIX = "dueback-od-";

/** Where saved reports land in the user's OneDrive. */
export const ONEDRIVE_FOLDER = ["Apps", "DueBack"] as const;

/** Delegated scopes: file write, refresh tokens, and id_token claims for
 *  showing which account is connected. Consentable by any user — no admin. */
export const ONEDRIVE_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "Files.ReadWrite",
] as const;

export const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

/** Graph's ceiling for the single-request upload; larger files need a session. */
export const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;

/** Upload-session chunk size — must be a multiple of 320 KiB (Graph rule). */
export const UPLOAD_CHUNK = 320 * 1024 * 16; // 5 MiB

export function authorizeUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
}

export function tokenUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** URL-safe random string (PKCE verifier / state nonce). */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

/** S256 code challenge for a PKCE verifier (RFC 7636). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return b64url(new Uint8Array(digest));
}

export function buildAuthUrl(p: {
  tenant: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    response_type: "code",
    redirect_uri: p.redirectUri,
    response_mode: "query",
    scope: ONEDRIVE_SCOPES.join(" "),
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    // Always show the account picker: connecting is rare, and silent SSO into
    // the wrong work account is worse than one extra click.
    prompt: "select_account",
  });
  return `${authorizeUrl(p.tenant)}?${q.toString()}`;
}

// ── Tokens ───────────────────────────────────────────────────────────────────

export interface OneDriveAccount {
  name: string;
  email: string;
}

export interface OneDriveTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  account: OneDriveAccount;
}

/** Decode a JWT's payload (display only — it arrived over TLS straight from
 *  the token endpoint, so no signature check is needed client-side). */
export function parseJwtClaims(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
}

/** Map a token-endpoint response to our stored shape. `prev` keeps the
 *  refresh token / account when a refresh response omits them. */
export function tokensFromResponse(
  json: TokenResponse,
  now: number,
  prev?: OneDriveTokens,
): OneDriveTokens {
  if (!json.access_token) {
    throw new Error(
      json.error_description || json.error || "Microsoft sign-in failed.",
    );
  }
  const claims = json.id_token ? parseJwtClaims(json.id_token) : null;
  const account: OneDriveAccount = claims
    ? {
        name: typeof claims.name === "string" ? claims.name : "",
        email:
          typeof claims.preferred_username === "string"
            ? claims.preferred_username
            : typeof claims.email === "string"
              ? claims.email
              : "",
      }
    : (prev?.account ?? { name: "", email: "" });
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? prev?.refreshToken ?? "",
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
    account,
  };
}

/** Expired (or about to, within the skew) — time to refresh. */
export function isExpired(expiresAt: number, now: number, skewMs = 60_000): boolean {
  return now >= expiresAt - skewMs;
}

// ── Microsoft Graph upload ───────────────────────────────────────────────────

type FetchLike = typeof fetch;

/** `/me/drive/root:/Apps/DueBack/name.xlsx:` — path-addressed drive item. */
export function graphItemPath(segments: readonly string[], name: string): string {
  const path = [...segments, name].map(encodeURIComponent).join("/");
  return `/me/drive/root:/${path}:`;
}

/** Inclusive byte ranges for an upload session ([] for an empty file). */
export function chunkRanges(
  total: number,
  chunk = UPLOAD_CHUNK,
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let start = 0; start < total; start += chunk) {
    out.push({ start, end: Math.min(start + chunk, total) - 1 });
  }
  return out;
}

/** Pull a readable message out of a Graph error body. */
async function graphError(res: Response, fallback: string): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    detail = body.error?.message || body.error?.code || "";
  } catch {
    /* non-JSON body */
  }
  return new Error(`${fallback} (${res.status}${detail ? `: ${detail}` : ""})`);
}

export interface DriveItem {
  name: string;
  webUrl: string;
}

/** Create the target folder chain (idempotent — 409 "already exists" is fine). */
export async function ensureFolders(
  fetchFn: FetchLike,
  token: string,
  segments: readonly string[] = ONEDRIVE_FOLDER,
): Promise<void> {
  for (let i = 0; i < segments.length; i++) {
    const parent =
      i === 0
        ? `${GRAPH_ROOT}/me/drive/root/children`
        : `${GRAPH_ROOT}/me/drive/root:/${segments
            .slice(0, i)
            .map(encodeURIComponent)
            .join("/")}:/children`;
    const res = await fetchFn(parent, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: segments[i], folder: {} }),
    });
    if (!res.ok && res.status !== 409) {
      throw await graphError(res, `Couldn't create the ${segments[i]} folder`);
    }
  }
}

/** One-request upload for files under {@link SIMPLE_UPLOAD_MAX}. */
export async function uploadSmall(
  fetchFn: FetchLike,
  token: string,
  itemPath: string,
  blob: Blob,
): Promise<DriveItem> {
  const res = await fetchFn(`${GRAPH_ROOT}${itemPath}/content`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": blob.type || "application/octet-stream",
    },
    body: blob,
  });
  if (!res.ok) throw await graphError(res, "OneDrive upload failed");
  return (await res.json()) as DriveItem;
}

/** Chunked upload session for larger files (image-heavy workbooks). */
export async function uploadChunked(
  fetchFn: FetchLike,
  token: string,
  itemPath: string,
  blob: Blob,
): Promise<DriveItem> {
  const start = await fetchFn(`${GRAPH_ROOT}${itemPath}/createUploadSession`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    // Match the simple path's semantics: same-named report → replaced.
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
  });
  if (!start.ok) throw await graphError(start, "OneDrive upload failed");
  const { uploadUrl } = (await start.json()) as { uploadUrl?: string };
  if (!uploadUrl) throw new Error("OneDrive upload failed (no session URL).");

  let last: DriveItem | null = null;
  for (const { start: s, end } of chunkRanges(blob.size)) {
    // Session URLs are pre-authorized — no Authorization header here.
    const res = await fetchFn(uploadUrl, {
      method: "PUT",
      headers: { "Content-Range": `bytes ${s}-${end}/${blob.size}` },
      body: blob.slice(s, end + 1),
    });
    if (!res.ok) throw await graphError(res, "OneDrive upload failed");
    if (res.status === 200 || res.status === 201) {
      last = (await res.json()) as DriveItem;
    }
  }
  if (!last) throw new Error("OneDrive upload failed (session never completed).");
  return last;
}

/** Upload a file into the DueBack folder, choosing simple vs. chunked. */
export async function uploadToFolder(
  fetchFn: FetchLike,
  token: string,
  fileName: string,
  blob: Blob,
): Promise<DriveItem> {
  const itemPath = graphItemPath(ONEDRIVE_FOLDER, fileName);
  return blob.size <= SIMPLE_UPLOAD_MAX
    ? uploadSmall(fetchFn, token, itemPath, blob)
    : uploadChunked(fetchFn, token, itemPath, blob);
}
