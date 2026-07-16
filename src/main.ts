import "@fontsource-variable/inter";
import "@fontsource-variable/fraunces";
import "./ui/theme.css";
import { mount } from "svelte";
import App from "./ui/App.svelte";
import { relayOneDriveAuthPopup } from "./onedrive/popup.ts";

const target = document.getElementById("app");
if (!target) throw new Error("#app root element missing");
target.removeAttribute("aria-busy");

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
