import type { ChatClient, ChatReply, ChatRequest, ChatTurn } from "../types.ts";
import type { Endpoint } from "../endpoint.ts";
import { errorBody, visionFetch } from "./shared.ts";

// The Anthropic Messages dialect — vision, tool use and structured outputs.
// Browser calls require the explicit opt-in header below plus a
// user-supplied key. Default model is Claude Haiku 4.5: cheap, fast,
// vision-capable — a fraction of a cent per receipt, which is the whole point
// of a confidence-triggered paid tier.

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
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

function priceCall(model: string, usage: AnthropicResponse["usage"]): number {
  if (!usage) return 0;
  const p = priceFor(model);
  return ((usage.input_tokens ?? 0) / 1e6) * p.in + ((usage.output_tokens ?? 0) / 1e6) * p.out;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: unknown[];
}

function toMessage(turn: ChatTurn): AnthropicMessage {
  switch (turn.role) {
    case "user":
      return {
        role: "user",
        content: turn.content.map((p) =>
          p.type === "text"
            ? { type: "text", text: p.text }
            : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.base64 } },
        ),
      };
    case "assistant":
      if (turn.raw?.dialect === "anthropic" && Array.isArray(turn.raw.message)) {
        return { role: "assistant", content: turn.raw.message };
      }
      return {
        role: "assistant",
        content: [
          ...(turn.text ? [{ type: "text", text: turn.text }] : []),
          ...turn.toolCalls.map((tc) => ({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args })),
        ],
      };
    case "tool":
      // Tool results ride a USER message in this dialect.
      return {
        role: "user",
        content: turn.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      };
  }
}

/** The request body. Consecutive same-role messages (a tool result followed
 *  by the agent's nudge) are merged — the dialect wants roles to alternate.
 *  Pure; Node-tested. */
export function anthropicBody(req: ChatRequest, ep: Endpoint): Record<string, unknown> {
  const messages: AnthropicMessage[] = [];
  for (const m of req.turns.map(toMessage)) {
    const prev = messages[messages.length - 1];
    if (prev && prev.role === m.role) prev.content = [...prev.content, ...m.content];
    else messages.push({ ...m, content: [...m.content] });
  }
  const body: Record<string, unknown> = {
    model: ep.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages,
  };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    body.tool_choice = req.forceTool ? { type: "tool", name: req.forceTool } : { type: "auto" };
  }
  if (req.jsonSchema) {
    body.output_config = { format: { type: "json_schema", schema: req.jsonSchema } };
  }
  return body;
}

/** Map a response into the neutral reply. Pure; Node-tested. */
export function parseAnthropicReply(data: AnthropicResponse, ep: Endpoint): ChatReply {
  const blocks = data.content ?? [];
  return {
    text: blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join(""),
    toolCalls: blocks
      .filter((b) => b.type === "tool_use" && b.name)
      .map((b, i) => ({
        id: b.id || `toolu_${i}`,
        name: b.name!,
        args:
          b.input && typeof b.input === "object" && !Array.isArray(b.input)
            ? (b.input as Record<string, unknown>)
            : {},
      })),
    costUsd: priceCall(ep.model, data.usage),
    raw: { dialect: "anthropic", message: blocks },
  };
}

export function createAnthropicClient(ep: Endpoint): ChatClient {
  return {
    label: ep.label,
    model: ep.model,
    async chat(req) {
      const res = await visionFetch(ep, `${ep.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ep.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(anthropicBody(req, ep)),
      });
      if (!res.ok) throw new Error(`${ep.label} HTTP ${res.status}: ${await errorBody(res)}`);
      return parseAnthropicReply((await res.json()) as AnthropicResponse, ep);
    },
  };
}
