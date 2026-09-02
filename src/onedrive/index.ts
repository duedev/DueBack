import {
  buildAuthUrl,
  isExpired,
  ensureFolders,
  GraphError,
  TokenEndpointError,
  ONEDRIVE_FOLDER,
  pkceChallenge,
  randomToken,
  STATE_PREFIX,
  tokenUrl,
  tokensFromResponse,
  uploadToFolder,
  type OneDriveAccount,
  type OneDriveTokens,
} from "./core.ts";
import { POPUP_MESSAGE_TYPE } from "./popup.ts";
import {
  clearTokens,
  loadTokens,
  ONEDRIVE_TENANT,
  oneDriveClientId,
  oneDriveConfigured,
  redirectUri,
  saveTokens,
} from "./store.ts";

// The interactive half of the OneDrive layer: the PKCE popup dance, token
// refresh, and the save-a-report entry point. No SDK, no server — the token
// endpoint allows browser calls when the redirect URI is registered as a
// Single-page application (see ONEDRIVE_SETUP.md).
//
// Popup rule: window.open only succeeds inside a user gesture, so
// connectOneDrive opens the (blank) popup FIRST, synchronously, and navigates
// it once the auth URL (async: SHA-256 challenge) is ready. Callers must
// connect BEFORE slow work like building the workbook, not after.

export { oneDriveConfigured, oneDriveAccount, disconnectOneDrive } from "./store.ts";

const AUTH_TIMEOUT_MS = 5 * 60_000;

async function postTokenForm(params: Record<string, string>): Promise<OneDriveTokens> {
  const prev = loadTokens() ?? undefined;
  let res: Response;
  try {
    res = await fetch(tokenUrl(ONEDRIVE_TENANT), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: oneDriveClientId(), ...params }).toString(),
    });
  } catch {
    throw new Error("Couldn't reach Microsoft — check the connection and try again.");
  }
  // Only a 4xx JSON error is a verdict on the grant (TokenEndpointError,
  // via tokensFromResponse); an outage says nothing about it.
  if (res.status >= 500 || res.status === 429) {
    throw new Error(
      `Microsoft sign-in is unavailable right now (${res.status}) — try again in a moment.`,
    );
  }
  const json = (await res.json().catch(() => ({}))) as Parameters<
    typeof tokensFromResponse
  >[0];
  return tokensFromResponse(json, Date.now(), prev);
}

/** Refresh the stored grant. True when fresh tokens were saved; false when
 *  the endpoint REFUSED the grant (expired/revoked — tokens cleared, the
 *  session is dead); throws on a transport failure or an outage, which
 *  must not be mistaken for a dead session. */
async function tryRefresh(refreshToken: string): Promise<boolean> {
  try {
    const fresh = await postTokenForm({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "offline_access Files.ReadWrite",
    });
    saveTokens(fresh);
    return true;
  } catch (err) {
    if (!(err instanceof TokenEndpointError)) throw err;
    clearTokens();
    return false;
  }
}

const RECONNECT_MESSAGE =
  "OneDrive no longer accepts this sign-in — click Save to OneDrive again to reconnect.";

/** Wait for the popup to land back on the app with our state: the popup
 *  relays its URL via postMessage (popup.ts), and a same-origin location
 *  poll backs that up. Rejects on close/timeout. */
function waitForCallback(popup: Window, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const settle = (fn: () => void): void => {
      window.removeEventListener("message", onMessage);
      clearInterval(poll);
      clearTimeout(timer);
      try {
        popup.close();
      } catch {
        /* already closed */
      }
      fn();
    };
    const onMessage = (e: MessageEvent): void => {
      if (e.origin !== location.origin) return;
      const data = e.data as { type?: string; url?: string } | null;
      if (data?.type !== POPUP_MESSAGE_TYPE || typeof data.url !== "string") return;
      if (new URL(data.url).searchParams.get("state") !== state) return;
      const url = data.url;
      settle(() => resolve(url));
    };
    const poll = setInterval(() => {
      if (popup.closed) {
        settle(() => reject(new Error("Sign-in window was closed.")));
        return;
      }
      try {
        // Cross-origin while on login.microsoftonline.com — throws until the
        // redirect brings the popup back to our origin.
        if (popup.location.origin === location.origin) {
          const href = popup.location.href;
          if (new URL(href).searchParams.get("state") === state) {
            settle(() => resolve(href));
          }
        }
      } catch {
        /* still on the Microsoft page */
      }
    }, 250);
    const timer = setTimeout(() => {
      settle(() => reject(new Error("Sign-in timed out.")));
    }, AUTH_TIMEOUT_MS);
    window.addEventListener("message", onMessage);
  });
}

/** Interactive sign-in. Must be called from a user gesture (click). */
export async function connectOneDrive(): Promise<OneDriveAccount> {
  if (!oneDriveConfigured()) {
    throw new Error("OneDrive isn't configured for this deployment.");
  }
  // Synchronously, before any await — popup blockers allow it here.
  const popup = window.open(
    "about:blank",
    "dueback-onedrive",
    "width=480,height=640,popup=yes",
  );
  if (!popup) {
    throw new Error("Popup blocked — allow popups for this site and try again.");
  }
  try {
    const verifier = randomToken(48);
    const state = STATE_PREFIX + randomToken(12);
    const url = buildAuthUrl({
      tenant: ONEDRIVE_TENANT,
      clientId: oneDriveClientId(),
      redirectUri: redirectUri(),
      state,
      challenge: await pkceChallenge(verifier),
    });
    popup.location.href = url;

    const callback = new URL(await waitForCallback(popup, state));
    const err = callback.searchParams.get("error");
    if (err) {
      const detail = callback.searchParams.get("error_description") ?? "";
      throw new Error(
        err === "access_denied"
          ? "Sign-in was cancelled."
          : `Microsoft sign-in failed: ${detail || err}`,
      );
    }
    const code = callback.searchParams.get("code");
    if (!code) throw new Error("Microsoft sign-in failed (no code returned).");

    const tokens = await postTokenForm({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    });
    saveTokens(tokens);
    foldersReady = false; // a new grant may be a different drive
    return tokens.account;
  } finally {
    try {
      popup.close();
    } catch {
      /* already closed */
    }
  }
}

/** A usable access token: stored → refreshed → interactive, in that order.
 *  (SPA refresh tokens live 24 h, so the popup does reappear occasionally.) */
export async function ensureConnected(): Promise<string> {
  const stored = loadTokens();
  if (stored && !isExpired(stored.expiresAt, Date.now())) return stored.accessToken;
  // A refused refresh (invalid_grant: expired or revoked) is a dead session
  // — fall through to interactive. A network failure or an outage is not:
  // tryRefresh rethrows those, keeping the refresh token for next time,
  // instead of throwing away a good session and forcing a re-consent popup
  // over a blip.
  if (stored?.refreshToken && (await tryRefresh(stored.refreshToken))) {
    return loadTokens()!.accessToken;
  }
  await connectOneDrive();
  const tokens = loadTokens();
  if (!tokens) throw new Error("OneDrive sign-in failed.");
  return tokens.accessToken;
}

let foldersReady = false;

/** Upload a generated report into OneDrive → Apps/DueBack. Call
 *  {@link ensureConnected} first (inside the user gesture); this half is
 *  popup-free. */
export async function uploadReport(
  fileName: string,
  blob: Blob,
): Promise<{ path: string; webUrl: string }> {
  try {
    return await uploadOnce(fileName, blob);
  } catch (err) {
    // Graph answered 401: the cached access token is dead before its clock
    // says so (revoked consent, invalidated token). Refresh silently and
    // go once more; when the grant itself is dead, clear it and ask for a
    // second click — the popup must open inside a user gesture, and this
    // code runs seconds after the click, past the gesture window.
    if (!(err instanceof GraphError && err.status === 401)) throw err;
    foldersReady = false;
    const stored = loadTokens();
    if (!stored?.refreshToken || !(await tryRefresh(stored.refreshToken))) {
      clearTokens();
      throw new Error(RECONNECT_MESSAGE);
    }
    return uploadOnce(fileName, blob);
  }
}

async function uploadOnce(
  fileName: string,
  blob: Blob,
): Promise<{ path: string; webUrl: string }> {
  const token = await ensureConnected();
  if (!foldersReady) {
    await ensureFolders(fetch, token);
    foldersReady = true;
  }
  const item = await uploadToFolder(fetch, token, fileName, blob);
  return { path: [...ONEDRIVE_FOLDER, fileName].join("/"), webUrl: item.webUrl };
}
