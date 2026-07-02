import { syncConfigured, functionsUrl } from "./client.ts";
import { accessToken } from "./auth.ts";
import type { VisionConfig } from "../pipeline/vision/config.ts";

// Signed-in AI assist: instead of a key in the browser, route the OpenRouter
// call through the project's `ai-extract` Edge Function (an OpenAI-compatible
// passthrough holding the real key in function secrets). The user's Supabase
// access token is the bearer credential; the function verifies it.

/**
 * When the user is signed in (and hasn't supplied their own key), return a
 * config override that targets the server proxy. Null = no override (use the
 * local config as-is).
 */
export async function serverProxyOverride(
  cfg: VisionConfig,
): Promise<VisionConfig | null> {
  if (!syncConfigured()) return null;
  if (cfg.provider !== "openrouter") return null;
  if (cfg.apiKey.trim()) return null; // an explicit user key always wins
  const token = await accessToken();
  if (!token) return null;
  return {
    ...cfg,
    baseUrl: `${functionsUrl()}/ai-extract`,
    apiKey: token,
  };
}
