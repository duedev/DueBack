import type { ChatClient, ContentPart, VisionExtraction } from "../types.ts";
import { RECEIPT_JSON_SCHEMA, SYSTEM_PROMPT, userInstruction, parseVisionJson } from "../schema.ts";

// One-shot: one call, image in, JSON out. Works with any vision model on any
// backend, and it is the only shape the signed-in ai-extract proxy relays.

export type ImagePart = Extract<ContentPart, { type: "image" }>;

export interface StrategyOptions {
  /** Called with each call's measured cost as soon as it is known, so a
   *  run that fails after billing still lands in "Spent so far". */
  onCost?: (usd: number) => void;
  /** Checked before every call after the first; false stops the run. */
  canSpend?: () => boolean;
}

export async function runOneShot(
  client: ChatClient,
  image: ImagePart,
  opts: StrategyOptions = {},
): Promise<VisionExtraction> {
  const reply = await client.chat({
    system: SYSTEM_PROMPT,
    turns: [{ role: "user", content: [{ type: "text", text: userInstruction() }, image] }],
    jsonSchema: RECEIPT_JSON_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1024,
  });
  opts.onCost?.(reply.costUsd);
  const fields = parseVisionJson(reply.text);
  if (!fields) throw new Error(`${client.label} returned no parseable JSON.`);
  return { fields, rawText: reply.text, costUsd: reply.costUsd, model: client.model, calls: 1 };
}
