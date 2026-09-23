import type { ChatClient } from "../types.ts";
import type { Endpoint } from "../endpoint.ts";
import { createOpenAiClient } from "./openai.ts";
import { createAnthropicClient } from "./anthropic.ts";
import { createGeminiClient } from "./gemini.ts";

/** The chat client for an endpoint's wire dialect. `pause` reaches every
 *  request; visionFetch decides whether this endpoint may listen to it. */
export function createClient(ep: Endpoint, pause?: AbortSignal): ChatClient {
  switch (ep.dialect) {
    case "anthropic":
      return createAnthropicClient(ep, pause);
    case "gemini":
      return createGeminiClient(ep, pause);
    case "openai":
    default:
      return createOpenAiClient(ep, pause);
  }
}
