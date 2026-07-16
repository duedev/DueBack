import { STATE_PREFIX } from "./core.ts";

// The OAuth popup lands back on the app's own URL with ?code=&state=. This
// runs before the app mounts (main.ts): when this page-load IS that popup,
// hand the full callback URL to the opener and stop — booting the whole app
// (OCR workers, IndexedDB, …) inside a throwaway popup would be waste.
//
// The `dueback-od-` state prefix is the discriminator: Supabase magic links
// also return to the app with a `?code=` query param, and they must keep
// booting the app normally.

export const POPUP_MESSAGE_TYPE = "dueback:onedrive:callback";

/** True when this page-load is the OneDrive OAuth popup (app boot skipped). */
export function relayOneDriveAuthPopup(): boolean {
  let state = "";
  try {
    state = new URLSearchParams(location.search).get("state") ?? "";
  } catch {
    return false;
  }
  if (!state.startsWith(STATE_PREFIX)) return false;

  try {
    window.opener?.postMessage(
      { type: POPUP_MESSAGE_TYPE, url: location.href },
      location.origin,
    );
  } catch {
    /* opener gone — the poller in the opener still reads our location */
  }

  const target = document.getElementById("app");
  if (target) {
    target.textContent = "Signing in… you can close this window.";
  }
  // Some browsers refuse script-close for user-opened windows; the text above
  // covers that case. The opener also closes us once it has the code.
  setTimeout(() => window.close(), 400);
  return true;
}
