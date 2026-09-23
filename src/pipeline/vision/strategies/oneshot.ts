import type { ChatClient, ChatReply, ContentPart, VisionExtraction } from "../types.ts";
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
  /** Answer budget per call (the endpoint's `maxTokens`). */
  maxTokens?: number;
}

export const DEFAULT_MAX_TOKENS = 1024;

/** Why a reply held no usable answer, in words a person can act on: how it
 *  began (or that it was empty), and whether the token limit cut it off. A
 *  bare "no parseable JSON" left only the server's own logs to explain it. */
export function unusableReply(reply: Pick<ChatReply, "text" | "truncated">, maxTokens: number): string {
  const text = reply.text.trim();
  const began = text
    ? ` It began: "${text.length > 160 ? `${text.slice(0, 160)}…` : text}"`
    : " The reply was empty.";
  const cut = reply.truncated
    ? ` It was cut off at the ${maxTokens}-token limit: a "thinking" model can spend all of it ` +
      `reasoning, so turn thinking off for this model or pick one that answers directly.`
    : "";
  return began + cut;
}

export async function runOneShot(
  client: ChatClient,
  image: ImagePart,
  opts: StrategyOptions = {},
): Promise<VisionExtraction> {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const reply = await client.chat({
    system: SYSTEM_PROMPT,
    turns: [{ role: "user", content: [{ type: "text", text: userInstruction() }, image] }],
    jsonSchema: RECEIPT_JSON_SCHEMA as unknown as Record<string, unknown>,
    maxTokens,
  });
  opts.onCost?.(reply.costUsd);
  const fields = parseVisionJson(reply.text);
  if (!fields) {
    throw new Error(`${client.label} returned no parseable JSON.${unusableReply(reply, maxTokens)}`);
  }
  return { fields, rawText: reply.text, costUsd: reply.costUsd, model: client.model, calls: 1 };
}
