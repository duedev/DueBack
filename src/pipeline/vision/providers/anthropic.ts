import type { VisionProvider } from "../types.ts";
import {
  RECEIPT_JSON_SCHEMA,
  SYSTEM_PROMPT,
  userInstruction,
  parseVisionJson,
} from "../schema.ts";
import { blobToBase64, errorBody, visionFetch, type ProviderInit } from "./shared.ts";

// Anthropic Claude — vision + structured outputs in one call. Browser calls
// require the explicit opt-in header below plus a user-supplied key. Default
// model is Claude Haiku 4.5: cheap, fast, vision-capable — a fraction of a cent
// per receipt, which is the whole point of a confidence-triggered paid tier.

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

// $/1M tokens (input, output), Anthropic first-party rates. Keyed by model id;
// a dated snapshot ("claude-haiku-4-5-20251001") resolves to its base id by
// longest prefix. An id not in the table is charged at the TOP rate: the
// Model field is free text, and "unknown = $0" meant a paid provider ran with
// "Spent so far: $0.00" and the spend cap never engaged.
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-fable-5": { in: 10, out: 50 },
  "claude-fable-5-1": { in: 10, out: 50 },
};
const TOP_RATE = { in: 10, out: 50 };

/** The price row for a model id: exact, else the longest table id the given
 *  id starts with, else the top rate (never $0). Pure; Node-tested. */
export function priceFor(model: string): { in: number; out: number } {
  const id = model.trim().toLowerCase();
  if (PRICES[id]) return PRICES[id]!;
  const prefix = Object.keys(PRICES)
    .filter((k) => id.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? PRICES[prefix]! : TOP_RATE;
}

export function createAnthropicProvider(init: ProviderInit): VisionProvider {
  return {
    id: "anthropic",
    async extract(image) {
      const { base64, mediaType } = await blobToBase64(image);
      const url = `${init.baseUrl || "https://api.anthropic.com"}/v1/messages`;
      const res = await visionFetch("Anthropic", url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": init.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: init.model,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: userInstruction() },
                { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
              ],
            },
          ],
          output_config: { format: { type: "json_schema", schema: RECEIPT_JSON_SCHEMA } },
        }),
      });
      if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await errorBody(res)}`);
      const data = (await res.json()) as AnthropicResponse;
      const text = (data.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      const fields = parseVisionJson(text);
      if (!fields) throw new Error("Anthropic returned no parseable JSON.");
      return {
        fields,
        rawText: text,
        costUsd: priceCall(init.model, data.usage),
        model: init.model,
      };
    },
  };
}

function priceCall(model: string, usage: AnthropicResponse["usage"]): number {
  if (!usage) return 0;
  const p = priceFor(model);
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}
