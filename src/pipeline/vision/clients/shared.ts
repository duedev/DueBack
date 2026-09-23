// Shared plumbing for the chat clients: image encoding and small fetch
// helpers. The clients are deliberately raw `fetch` calls (not vendor SDKs):
// this is a tiny, opt-in tier in a zero-dependency client PWA, and keeping all
// three dialects on one uniform shape avoids bundling multiple SDKs.

import { APP_URL } from "../../../config/constants.ts";
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

/** What to try when a server on this machine or network can't be reached:
 *  a browser reports a CORS refusal, a stopped server and a blocked
 *  local-network request all as the same bare "Failed to fetch". */
export function unreachableHint(ep: Pick<Endpoint, "backend" | "label" | "baseUrl">): string {
  const where = `${ep.label} at ${ep.baseUrl}`;
  if (ep.backend === "cloud") return `couldn't reach ${where}.`;
  const allow =
    ep.label === "Ollama"
      ? `start it with OLLAMA_ORIGINS=${appOrigin()}`
      : "allow cross-origin requests (CORS) from this page";
  return (
    `couldn't reach ${where}. Is it running? It must also ${allow}` +
    `, and the browser may ask to allow local-network access.`
  );
}

/**
 * fetch with the endpoint's deadline attached and its failures made
 * readable: a TimeoutError/AbortError used to surface as "signal timed out"
 * in the Settings test and the training log, and a local server that refused
 * CORS as a bare "Failed to fetch". The signal also aborts a trickling body
 * read, so callers need not wrap res.json().
 */
export async function visionFetch(
  ep: Pick<Endpoint, "backend" | "label" | "baseUrl" | "timeoutMs">,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ep.timeoutMs) });
  } catch (err) {
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
