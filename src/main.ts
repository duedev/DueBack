import "@fontsource-variable/inter";
// Lora: warm bookish serif for headings. Replaced Fraunces, whose display
// letterforms (the flamboyant lowercase f in particular) kept reading as a
// rendering glitch in product feedback.
import "@fontsource-variable/lora";
import "./ui/theme.css";
import { mount } from "svelte";
import App from "./ui/App.svelte";
import { relayOneDriveAuthPopup } from "./onedrive/popup.ts";

const target = document.getElementById("app");
if (!target) throw new Error("#app root element missing");
target.removeAttribute("aria-busy");

// A deploy purges the previous build's hashed chunks (autoUpdate service
// worker), so a tab left open across it 404s on its next lazy import —
// Generate, the PDF renderer, the ZIP reader. Vite reports that as
// `vite:preloadError`; reload once to pick up the new build (in-flight jobs
// resume from IndexedDB). The timestamp guard stops a reload loop when the
// chunk is missing for a real reason (network down).
window.addEventListener("vite:preloadError", (event) => {
  const KEY = "dueback.preloadReloadedAt";
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(KEY)) || 0;
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return; // storage blocked — no guard, so no automatic reload
  }
  event.preventDefault();
  location.reload();
});

// When this page-load is the OneDrive OAuth popup returning with ?code=,
// relay it to the opener and stop — don't boot the app inside the popup.
if (!relayOneDriveAuthPopup()) {
  mount(App, { target });

  // Optional, cookieless visit counting (Cloudflare Web Analytics). Loads only
  // when a token is baked in at build time — page views only; receipts and
  // their data never leave the device. Builds without the token make zero
  // third-party requests.
  const cfToken = import.meta.env?.VITE_CF_ANALYTICS_TOKEN as string | undefined;
  if (cfToken) {
    const s = document.createElement("script");
    s.defer = true;
    s.src = "https://static.cloudflareinsights.com/beacon.min.js";
    s.setAttribute("data-cf-beacon", JSON.stringify({ token: cfToken }));
    document.head.appendChild(s);
  }
}
