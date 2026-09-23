import { syncConfigured, functionsUrl } from "./client.ts";
import { accessToken } from "./auth.ts";
import type { Endpoint } from "../pipeline/vision/endpoint.ts";

// Signed-in AI assist: instead of a key in the browser, route the cloud
// OpenRouter call through the project's `ai-extract` Edge Function (an
// OpenAI-compatible passthrough holding the real key in function secrets).
// The user's Supabase access token is the bearer credential; the function
// verifies it. Local and self-hosted backends never touch the proxy.

/**
 * When the user is signed in (and hasn't supplied their own key), return the
 * endpoint retargeted at the server proxy. Null = no override (use the
 * endpoint as-is).
 */
export async function serverProxyOverride(
  ep: Endpoint,
  ownKey: string,
): Promise<Endpoint | null> {
  if (!syncConfigured()) return null;
  if (ep.backend !== "cloud" || !ep.openRouter) return null;
  if (ownKey.trim()) return null; // an explicit user key always wins
  const token = await accessToken();
  if (!token) return null;
  return {
    ...ep,
    baseUrl: `${functionsUrl()}/ai-extract`,
    apiKey: token,
    viaProxy: true,
  };
}
