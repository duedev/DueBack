import type { ChatClient } from "../types.ts";
import type { Endpoint } from "../endpoint.ts";
import { createOpenAiClient } from "./openai.ts";
import { createAnthropicClient } from "./anthropic.ts";
import { createGeminiClient } from "./gemini.ts";

/** The chat client for an endpoint's wire dialect. */
export function createClient(ep: Endpoint): ChatClient {
  switch (ep.dialect) {
    case "anthropic":
      return createAnthropicClient(ep);
    case "gemini":
      return createGeminiClient(ep);
    case "openai":
    default:
      return createOpenAiClient(ep);
  }
}
