// Shared plumbing for the chat clients: image encoding and small fetch
// helpers. The clients are deliberately raw `fetch` calls (not vendor SDKs):
// this is a tiny, opt-in tier in a zero-dependency client PWA, and keeping all
// three dialects on one uniform shape avoids bundling multiple SDKs.

import { APP_URL } from "../../../config/constants.ts";
import { abortError, anySignal } from "../../../util/abort.ts";
import type { Endpoint } from "../endpoint.ts";

/** Encode a Blob as base64 (no data: prefix) plus its media type. */
export async function blobToBase64(
  blob: Blob,
): Promise<{ base64: string; mediaType: string }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const chunk = 0x8000; // chunk to avoid arg-count limits on fromCharCode
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return { base64: btoa(bin), mediaType: blob.type || "image/jpeg" };
}

export function dataUrl(base64: string, mediaType: string): string {
  return `data:${mediaType};base64,${base64}`;
}

/** This page's origin — OpenRouter's attribution referer, and the origin a
 *  local server must allow (OLLAMA_ORIGINS). */
export function appOrigin(): string {
  return typeof location !== "undefined" ? location.origin : APP_URL;
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "[::1]" || /^127\./.test(host);
  } catch {
    return false;
  }
}

/** What to try when a server on this machine or network can't be reached.
 *  fetch() rejects with the SAME bare TypeError whether the server is down,
 *  refused CORS, an extension blocked the request (ERR_BLOCKED_BY_CLIENT —
 *  e.g. uBlock Origin's "Block Outsider Intrusion into LAN" list, which
 *  stops public sites calling 10.x / 192.168.x addresses), local-network
 *  permission was denied, or mixed content was blocked: browsers hide which
 *  on purpose, so a page can't map the network. Only the console says, so
 *  the hint names the causes and points there. `pageProtocol` is injectable
 *  for tests. */
export function unreachableHint(
  ep: Pick<Endpoint, "backend" | "label" | "baseUrl">,
  pageProtocol: string = typeof location !== "undefined" ? location.protocol : "https:",
): string {
  if (ep.backend === "cloud") return `couldn't reach ${ep.baseUrl}.`;
  const allow =
    ep.label === "Ollama"
      ? `was started with OLLAMA_ORIGINS=${appOrigin()}`
      : "allows cross-origin requests (CORS) from this page";
  // An https page calling http:// beyond this machine: Chrome lets private
  // IPs and .local names through once local-network access is allowed;
  // Safari and Firefox block it outright.
  const mixed =
    pageProtocol === "https:" && /^http:\/\//i.test(ep.baseUrl) && !isLoopback(ep.baseUrl);
  return (
    `couldn't reach ${ep.baseUrl}. Check that it's running and ${allow}. ` +
    `If it is, the browser stopped the request, and its console (F12) says why: ` +
    `ERR_BLOCKED_BY_CLIENT is an extension such as an ad blocker (allow this site in it); ` +
    `a local-network permission error needs local network access allowed for this site` +
    (mixed
      ? `; blocked "Mixed Content" means this https page can't call an http address in ` +
        `this browser (Chrome allows private IPs; otherwise serve it over https or reach it via http://localhost).`
      : ".")
  );
}

/**
 * fetch with the endpoint's deadline attached and its failures made
 * readable: a TimeoutError/AbortError used to surface as "signal timed out"
 * in the Settings test and the training log, and a local server that refused
 * CORS as a bare "Failed to fetch". The signal also aborts a trickling body
 * read, so callers need not wrap res.json().
 *
 * `pause` is the reading pause (pipeline/queue.ts). It is combined with the
 * deadline ONLY for an unmetered endpoint (local / self-hosted — free, and
 * up to LOCAL_TIMEOUT_MS long, so a pause shouldn't wait it out); a metered
 * request is billed once sent, so it never listens and finishes instead of
 * being paid for again on resume. A paused call rejects with an AbortError.
 */
export async function visionFetch(
  ep: Pick<Endpoint, "backend" | "label" | "baseUrl" | "timeoutMs" | "metered">,
  url: string,
  init: RequestInit,
  pause?: AbortSignal,
): Promise<Response> {
  const listen = pause && !ep.metered ? pause : undefined;
  const deadline = AbortSignal.timeout(ep.timeoutMs);
  try {
    return await fetch(url, { ...init, signal: listen ? anySignal([listen, deadline]) : deadline });
  } catch (err) {
    if (listen?.aborted) throw abortError();
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`${ep.label} timed out after ${Math.round(ep.timeoutMs / 1000)} s.`);
    }
    if (err instanceof TypeError) throw new Error(`${ep.label}: ${unreachableHint(ep)}`);
    throw new Error(`${ep.label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Read a response body for an error message without throwing. */
export async function errorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return res.statusText;
  }
}

/** Parse a tool call's argument payload: OpenAI-style servers send a JSON
 *  string, others an object. Junk becomes {} (the tool then reports what's
 *  missing) rather than failing the whole run. */
export function toolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
