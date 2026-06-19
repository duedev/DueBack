import type { VisionProvider } from "../types.ts";
import {
  RECEIPT_JSON_SCHEMA,
  SYSTEM_PROMPT,
  userInstruction,
  parseVisionJson,
} from "../schema.ts";
import { blobToBase64, dataUrl, appOrigin, errorBody, type ProviderInit } from "./shared.ts";

// OpenRouter — one OpenAI-compatible endpoint and one key. The default is the
// Free Models Router (`openrouter/free`), which picks a free model per request
// and *smartly filters* to ones that support the request's needs — so sending an
// image automatically constrains it to free **vision** models.
//
// Preference for quick + reliable routing: `provider.sort: "throughput"` (the
// "nitro" fast path) with fallbacks enabled so a busy free provider rolls to
// another. We deliberately DON'T force strict structured outputs on the free
// router: that would filter to the tiny intersection of free + vision +
// json-schema providers and frequently fail. Instead the firm JSON system
// prompt + the tolerant parser do the job. Explicit paid models keep the strict
// schema (and require_parameters) for maximum fidelity.

interface OpenRouterResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { cost?: number };
  error?: { message?: string };
}

/** True when the model uses OpenRouter's free routing (the router, or any
 *  `:free` model), where strict structured outputs are best avoided. */
export function usesFreeRouting(model: string): boolean {
  return model === "openrouter/free" || model.includes(":free");
}

export function createOpenRouterProvider(init: ProviderInit): VisionProvider {
  return {
    id: "openrouter",
    async extract(image, ctx) {
      const { base64, mediaType } = await blobToBase64(image);
      const url = `${init.baseUrl || "https://openrouter.ai/api/v1"}/chat/completions`;
      const free = usesFreeRouting(init.model);

      const body: Record<string, unknown> = {
        model: init.model,
        temperature: 0,
        max_tokens: 700,
        usage: { include: true },
        // Quick + reliable provider selection (throughput = nitro fast path).
        provider: free
          ? { sort: "throughput", allow_fallbacks: true }
          : { sort: "throughput", allow_fallbacks: true, require_parameters: true },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: userInstruction(ctx.currencyDefault) },
              { type: "image_url", image_url: { url: dataUrl(base64, mediaType) } },
            ],
          },
        ],
      };
      // Strict structured outputs only for explicit paid models (see note above).
      if (!free) {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: "receipt", strict: true, schema: RECEIPT_JSON_SCHEMA },
        };
      }

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${init.apiKey}`,
          "HTTP-Referer": appOrigin(),
          "X-Title": "Reimbursements Online",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${await errorBody(res)}`);
      const data = (await res.json()) as OpenRouterResponse;
      // OpenRouter can return HTTP 200 with an error body (e.g. no free provider
      // available right now) — surface it so the pipeline falls back to rules.
      if (data.error?.message) throw new Error(`OpenRouter: ${data.error.message}`);
      const text = data.choices?.[0]?.message?.content ?? "";
      const fields = parseVisionJson(text);
      if (!fields) throw new Error("OpenRouter returned no parseable JSON.");
      return {
        fields,
        rawText: text,
        costUsd: typeof data.usage?.cost === "number" ? data.usage.cost : 0,
        model: init.model,
      };
    },
  };
}
