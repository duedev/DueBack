// Shared plumbing for the vision providers: image encoding and small fetch
// helpers. The providers are deliberately raw `fetch` calls (not vendor SDKs):
// this is a tiny, opt-in tier in a zero-dependency client PWA, and keeping all
// three providers on one uniform shape avoids bundling multiple SDKs.

import { APP_URL } from "../../../config/constants.ts";

export interface ProviderInit {
  apiKey: string;
  model: string;
  /** Optional override — e.g. a self-hosted proxy that holds the real key. */
  baseUrl?: string;
}

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

/** Every provider call carries this deadline: a stalled model call otherwise
 *  parked the receipt in "processing" for good, because the job heartbeat
 *  kept its lock alive while the fetch never resolved. */
export const VISION_TIMEOUT_MS = 90_000;
export function visionSignal(): AbortSignal {
  return AbortSignal.timeout(VISION_TIMEOUT_MS);
}

/** fetch with the deadline attached and its failures made readable: a
 *  TimeoutError/AbortError used to surface as "signal timed out" in the
 *  Settings test and the training log. The signal also aborts a trickling
 *  body read, so callers need not wrap res.json(). */
export async function visionFetch(provider: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: visionSignal() });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`${provider} timed out after ${Math.round(VISION_TIMEOUT_MS / 1000)} s.`);
    }
    throw new Error(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A referer/title pair OpenRouter likes for attribution; harmless elsewhere. */
export function appOrigin(): string {
  return typeof location !== "undefined" ? location.origin : APP_URL;
}

/** Read a response body for an error message without throwing. */
export async function errorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return res.statusText;
  }
}
