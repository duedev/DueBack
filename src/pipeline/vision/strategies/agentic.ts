import type { ChatClient, ChatTurn, VisionExtraction } from "../types.ts";
import { SYSTEM_PROMPT, parseVisionJson } from "../schema.ts";
import {
  AGENT_TOOLS,
  SUBMIT_SPEC,
  SUBMIT_TOOL,
  agentBrief,
  executeTool,
  type AgentContext,
} from "./tools.ts";
import type { ImagePart, StrategyOptions } from "./oneshot.ts";

// Agentic: a short, bounded tool loop. The model gets the image AND the
// on-device read, may call the app's own checks (tools.ts) to verify what it
// sees, and finishes by calling submit_receipt. The loop is deliberately
// small and predictable:
//   • at most MAX_AGENT_CALLS model calls; the last one may ONLY submit;
//   • tools are pure and local — the model can ask questions, never act;
//   • a model that ignores tools but answers in JSON still counts (small
//     local models often do);
//   • every call's cost is reported as it lands, and the spend cap is
//     re-checked before each follow-up call.

export const MAX_AGENT_CALLS = 5;

const AGENT_SYSTEM =
  SYSTEM_PROMPT +
  " You may call tools to verify your reading before answering. Finish by calling " +
  `${SUBMIT_TOOL} with the fields.`;

/** A JSON answer given as text instead of a submit call must at least look
 *  like a receipt — a tool-argument object echoed in prose must not end the
 *  run. */
function looksLikeReceipt(fields: Record<string, unknown>): boolean {
  return "amount" in fields || "vendor" in fields;
}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

export async function runAgentic(
  client: ChatClient,
  image: ImagePart,
  ctx: AgentContext,
  opts: StrategyOptions & { maxCalls?: number } = {},
): Promise<VisionExtraction> {
  const maxCalls = Math.max(1, opts.maxCalls ?? MAX_AGENT_CALLS);
  const turns: ChatTurn[] = [
    { role: "user", content: [{ type: "text", text: agentBrief(ctx) }, image] },
  ];
  // A readable trace of the run, kept as the receipt's raw text for review.
  const trace: string[] = [];
  let cost = 0;
  const finish = (fields: Record<string, unknown>, calls: number): VisionExtraction => {
    trace.push(`${SUBMIT_TOOL} ${JSON.stringify(fields)}`);
    return { fields, rawText: trace.join("\n"), costUsd: cost, model: client.model, calls };
  };

  for (let call = 1; call <= maxCalls; call++) {
    if (call > 1 && opts.canSpend && !opts.canSpend()) {
      throw new Error("Spend cap reached during the agent run.");
    }
    const last = call === maxCalls;
    const reply = await client.chat({
      system: AGENT_SYSTEM,
      turns,
      tools: last ? [SUBMIT_SPEC] : AGENT_TOOLS,
      forceTool: last ? SUBMIT_TOOL : undefined,
      maxTokens: 1024,
    });
    cost += reply.costUsd;
    opts.onCost?.(reply.costUsd);

    const submit = reply.toolCalls.find((tc) => tc.name === SUBMIT_TOOL);
    if (submit) return finish(submit.args, call);

    if (!reply.toolCalls.length) {
      const fields = parseVisionJson(reply.text);
      if (fields && looksLikeReceipt(fields)) return finish(fields, call);
      trace.push(`(no tool call) ${clip(reply.text)}`);
      turns.push({ role: "assistant", text: reply.text, toolCalls: [], raw: reply.raw });
      turns.push({
        role: "user",
        content: [{ type: "text", text: `Call ${SUBMIT_TOOL} with the receipt fields now.` }],
      });
      continue;
    }

    turns.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw });
    const results = reply.toolCalls.map((tc) => executeTool(tc, ctx));
    turns.push({ role: "tool", results });
    reply.toolCalls.forEach((tc, i) =>
      trace.push(`${tc.name} ${JSON.stringify(tc.args)} → ${clip(results[i]!.content)}`),
    );
  }
  throw new Error(`${client.label} gave no answer within ${maxCalls} calls.`);
}
