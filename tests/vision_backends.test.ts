import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultVisionConfig,
  mergeVisionConfig,
  normalizeVisionConfig,
  type VisionConfig,
} from "../src/pipeline/vision/config.ts";
import {
  CLOUD_TIMEOUT_MS,
  LOCAL_TIMEOUT_MS,
  effectiveStrategy,
  endpointProblem,
  resolveEndpoint,
  type Endpoint,
} from "../src/pipeline/vision/endpoint.ts";
import { openAiBody, openAiHeaders, parseOpenAiReply } from "../src/pipeline/vision/clients/openai.ts";
import { anthropicBody, parseAnthropicReply } from "../src/pipeline/vision/clients/anthropic.ts";
import { geminiBody, parseGeminiReply, toGeminiSchema } from "../src/pipeline/vision/clients/gemini.ts";
import { toolArgs } from "../src/pipeline/vision/clients/shared.ts";
import { RECEIPT_JSON_SCHEMA, visionToExtraction } from "../src/pipeline/vision/schema.ts";
import {
  AGENT_TOOLS,
  SUBMIT_TOOL,
  agentBrief,
  checkMath,
  executeTool,
  findOnReceipt,
  lookupVendor,
} from "../src/pipeline/vision/strategies/tools.ts";
import { runAgentic, MAX_AGENT_CALLS } from "../src/pipeline/vision/strategies/agentic.ts";
import { runOneShot, type ImagePart } from "../src/pipeline/vision/strategies/oneshot.ts";
import type { ChatClient, ChatReply, ChatRequest, ChatTurn } from "../src/pipeline/vision/types.ts";
import { messagesProblem, policeBody } from "../supabase/functions/ai-extract/policy.ts";

// The AI assist's backend × strategy seam: config migration, endpoint
// resolution, the three wire-dialect adapters (pure body/parse halves), the
// agent's tools, and the agent loop against a scripted fake client.

const cfg = (patch: Parameters<typeof mergeVisionConfig>[1] = {}): VisionConfig =>
  mergeVisionConfig(defaultVisionConfig(""), patch);

const IMAGE: ImagePart = { type: "image", base64: "AAAA", mediaType: "image/jpeg" };

// ── Config ───────────────────────────────────────────────────────────────────

test("an empty store yields the defaults; a build-time key turns the cloud tier on", () => {
  const d = normalizeVisionConfig(null, "");
  assert.equal(d.enabled, false);
  assert.equal(d.backend, "cloud");
  assert.equal(d.strategy, "oneshot");
  assert.equal(d.local.url, "http://localhost:11434/v1");
  assert.equal(normalizeVisionConfig(null, "sk-built-in").enabled, true);
});

test("a v1 single-provider config migrates onto the cloud backend", () => {
  const v1 = {
    enabled: true,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    apiKey: "sk-ant",
    baseUrl: "",
    spendCapUsd: 2,
    spentUsd: 0.5,
  };
  const c = normalizeVisionConfig(v1, "");
  assert.equal(c.enabled, true);
  assert.equal(c.backend, "cloud");
  assert.equal(c.strategy, "oneshot");
  assert.deepEqual(c.cloud, { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "sk-ant" });
  assert.equal(c.spendCapUsd, 2);
  assert.equal(c.spentUsd, 0.5);
});

test("a v1 OpenRouter baseUrl override was a self-hosted server all along", () => {
  const c = normalizeVisionConfig(
    { enabled: true, provider: "openrouter", model: "my-model", apiKey: "k", baseUrl: "https://llm.corp/v1" },
    "",
  );
  assert.equal(c.backend, "selfhosted");
  assert.deepEqual(c.selfhosted, { url: "https://llm.corp/v1", model: "my-model", apiKey: "k" });
});

test("junk in storage falls back field by field", () => {
  const c = normalizeVisionConfig(
    {
      backend: "mars",
      strategy: 7,
      cloud: { provider: "nope", apiKey: 42 },
      local: { server: "lmstudio" },
      spendCapUsd: -5,
      spentUsd: "lots",
    },
    "",
  );
  assert.equal(c.backend, "cloud");
  assert.equal(c.strategy, "oneshot");
  assert.equal(c.cloud.provider, "openrouter");
  assert.equal(c.cloud.model, "openrouter/free");
  assert.equal(c.cloud.apiKey, "");
  // A known local server with no URL/model gets THAT server's defaults.
  assert.equal(c.local.url, "http://localhost:1234/v1");
  assert.equal(c.local.model, "qwen2.5-vl-7b-instruct");
  assert.equal(c.spendCapUsd, 0);
  assert.equal(c.spentUsd, 0);
});

test("a patch merges each backend's settings instead of replacing them", () => {
  const base = cfg({ cloud: { apiKey: "sk-keep" } });
  const next = mergeVisionConfig(base, { backend: "local", local: { model: "gemma3:12b" } });
  assert.equal(next.backend, "local");
  assert.equal(next.local.model, "gemma3:12b");
  assert.equal(next.local.url, base.local.url, "the URL survives a model-only patch");
  assert.equal(next.cloud.apiKey, "sk-keep", "flipping the toggle never loses another backend's key");
});

// ── Endpoints ────────────────────────────────────────────────────────────────

test("local resolves to a keyless, unmetered OpenAI-compatible endpoint", () => {
  const ep = resolveEndpoint(cfg({ backend: "local", local: { url: "http://localhost:11434/v1/ " } }), "");
  assert.equal(ep.dialect, "openai");
  assert.equal(ep.label, "Ollama");
  assert.equal(ep.baseUrl, "http://localhost:11434/v1", "trailing slash and space trimmed");
  assert.equal(ep.apiKey, "");
  assert.equal(ep.metered, false);
  assert.equal(ep.openRouter, false);
  assert.equal(ep.timeoutMs, LOCAL_TIMEOUT_MS);
  assert.equal(endpointProblem(ep), null);
});

test("self-hosted carries its optional key; cloud picks the provider's dialect", () => {
  const sh = resolveEndpoint(
    cfg({ backend: "selfhosted", selfhosted: { url: "https://llm.corp/v1", model: "qwen", apiKey: " t0k " } }),
    "",
  );
  assert.equal(sh.apiKey, "t0k");
  assert.equal(sh.metered, false);
  const an = resolveEndpoint(
    cfg({ cloud: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "sk" } }),
    "",
  );
  assert.equal(an.dialect, "anthropic");
  assert.equal(an.metered, true);
  assert.equal(an.timeoutMs, CLOUD_TIMEOUT_MS);
  const or = resolveEndpoint(cfg(), "sk-built-in");
  assert.equal(or.dialect, "openai");
  assert.equal(or.openRouter, true);
  assert.equal(or.apiKey, "sk-built-in");
});

test("endpointProblem names what is missing", () => {
  assert.match(endpointProblem(resolveEndpoint(cfg(), ""))!, /API key/);
  assert.match(
    endpointProblem(resolveEndpoint(cfg({ backend: "selfhosted" }), ""))!,
    /server URL/,
  );
  assert.match(
    endpointProblem(resolveEndpoint(cfg({ backend: "selfhosted", selfhosted: { url: "llm.corp/v1" } }), ""))!,
    /http:\/\//,
  );
  assert.match(
    endpointProblem(resolveEndpoint(cfg({ backend: "local", local: { model: " " } }), ""))!,
    /model/,
  );
});

test("a proxied endpoint always runs one-shot", () => {
  const ep = resolveEndpoint(cfg(), "");
  assert.equal(effectiveStrategy(ep, "agentic"), "agentic");
  assert.equal(effectiveStrategy({ ...ep, viaProxy: true }, "agentic"), "oneshot");
});

// ── OpenAI-compatible adapter ────────────────────────────────────────────────

const ONE_SHOT: ChatRequest = {
  system: "sys",
  turns: [{ role: "user", content: [{ type: "text", text: "Extract." }, IMAGE] }],
  jsonSchema: RECEIPT_JSON_SCHEMA as unknown as Record<string, unknown>,
  maxTokens: 1024,
};

test("the proxied one-shot body passes the ai-extract message policy", () => {
  const ep: Endpoint = { ...resolveEndpoint(cfg(), ""), apiKey: "session", viaProxy: true };
  const body = openAiBody(ONE_SHOT, ep);
  assert.equal(messagesProblem(body.messages), null);
  const policed = policeBody(body);
  assert.deepEqual(policed.messages, body.messages);
  // Free router: no strict schema, no require_parameters.
  assert.equal("response_format" in body, false);
  assert.deepEqual(body.provider, { sort: "throughput", allow_fallbacks: true });
});

test("a local one-shot asks for structured output and sends no OpenRouter extras", () => {
  const ep = resolveEndpoint(cfg({ backend: "local" }), "");
  const body = openAiBody(ONE_SHOT, ep);
  assert.equal((body.response_format as { type: string }).type, "json_schema");
  assert.equal("provider" in body, false);
  assert.equal("usage" in body, false);
  assert.deepEqual(openAiHeaders(ep), { "Content-Type": "application/json" }, "no empty bearer");
});

const AGENT_TURNS: ChatTurn[] = [
  { role: "user", content: [{ type: "text", text: "brief" }, IMAGE] },
  { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "check_math", args: { total: 5 } }] },
  { role: "tool", results: [{ id: "c1", name: "check_math", content: '{"foots":true}' }] },
  { role: "user", content: [{ type: "text", text: "Submit now." }] },
];

test("OpenAI tool turns serialize as tool_calls + tool messages; a forced tool is named", () => {
  const ep = resolveEndpoint(cfg({ backend: "local" }), "");
  const body = openAiBody(
    { system: "s", turns: AGENT_TURNS, tools: AGENT_TOOLS, forceTool: SUBMIT_TOOL, maxTokens: 100 },
    ep,
  );
  const msgs = body.messages as Record<string, unknown>[];
  assert.deepEqual(msgs.map((m) => m.role), ["system", "user", "assistant", "tool", "user"]);
  const call = (msgs[2]!.tool_calls as { function: { arguments: string } }[])[0]!;
  assert.equal(call.function.arguments, '{"total":5}', "arguments travel as a JSON string");
  assert.equal(msgs[3]!.tool_call_id, "c1");
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: SUBMIT_TOOL } });
  assert.equal((body.tools as unknown[]).length, AGENT_TOOLS.length);
});

test("OpenAI replies parse tool calls, synthesize missing ids, and surface 200-with-error", () => {
  const ep = resolveEndpoint(cfg({ backend: "local" }), "");
  const reply = parseOpenAiReply(
    {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { function: { name: "lookup_vendor", arguments: '{"name":"SHELL"}' } },
              { function: { name: "", arguments: "{}" } },
            ],
          },
        },
      ],
      usage: { cost: 0.5 },
    },
    ep,
  );
  assert.equal(reply.text, "");
  assert.deepEqual(reply.toolCalls, [{ id: "call_0", name: "lookup_vendor", args: { name: "SHELL" } }]);
  assert.equal(reply.costUsd, 0, "only OpenRouter reports a trustworthy cost");
  const or = resolveEndpoint(cfg(), "k");
  assert.equal(parseOpenAiReply({ choices: [{ message: { content: "{}" } }], usage: { cost: 0.01 } }, or).costUsd, 0.01);
  assert.throws(() => parseOpenAiReply({ error: { message: "no free provider" } }, or), /no free provider/);
});

test("toolArgs tolerates strings, objects and junk", () => {
  assert.deepEqual(toolArgs('{"a":1}'), { a: 1 });
  assert.deepEqual(toolArgs({ a: 1 }), { a: 1 });
  assert.deepEqual(toolArgs("not json"), {});
  assert.deepEqual(toolArgs("[1]"), {});
  assert.deepEqual(toolArgs(undefined), {});
});

// ── Anthropic adapter ────────────────────────────────────────────────────────

test("Anthropic merges the tool result and the nudge into one user message", () => {
  const ep = resolveEndpoint(cfg({ cloud: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "k" } }), "");
  const body = anthropicBody(
    { system: "s", turns: AGENT_TURNS, tools: AGENT_TOOLS, forceTool: SUBMIT_TOOL, maxTokens: 100 },
    ep,
  );
  const msgs = body.messages as { role: string; content: { type: string }[] }[];
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(msgs[1]!.content.map((b) => b.type), ["tool_use"]);
  assert.deepEqual(msgs[2]!.content.map((b) => b.type), ["tool_result", "text"]);
  assert.deepEqual(body.tool_choice, { type: "tool", name: SUBMIT_TOOL });
  assert.equal("output_config" in body, false, "no structured output alongside tools");
  assert.ok("output_config" in anthropicBody(ONE_SHOT, ep));
});

test("Anthropic echoes its own content blocks back verbatim", () => {
  const ep = resolveEndpoint(cfg({ cloud: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "k" } }), "");
  const reply = parseAnthropicReply(
    {
      content: [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "toolu_1", name: "check_math", input: { total: 9 } },
      ],
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    },
    ep,
  );
  assert.equal(reply.text, "Checking.");
  assert.deepEqual(reply.toolCalls, [{ id: "toolu_1", name: "check_math", args: { total: 9 } }]);
  assert.equal(reply.costUsd, 1, "priced at Haiku 4.5's $1/M input");
  const body = anthropicBody(
    {
      system: "s",
      turns: [
        AGENT_TURNS[0]!,
        { role: "assistant", text: "ignored", toolCalls: reply.toolCalls, raw: reply.raw },
      ],
      maxTokens: 10,
    },
    ep,
  );
  assert.deepEqual((body.messages as { content: unknown }[])[1]!.content, reply.raw!.message);
});

// ── Gemini adapter ───────────────────────────────────────────────────────────

test("toGeminiSchema uppercases types and drops additionalProperties at every depth", () => {
  const g = toGeminiSchema(RECEIPT_JSON_SCHEMA) as Record<string, unknown>;
  assert.equal(g.type, "OBJECT");
  assert.equal("additionalProperties" in g, false);
  const props = g.properties as Record<string, { type: string; enum?: string[] }>;
  assert.equal(props.amount!.type, "NUMBER");
  assert.ok(props.category!.enum!.includes("Fuel"));
});

test("Gemini keeps thought signatures by echoing the model's content", () => {
  const modelContent = {
    role: "model",
    parts: [{ functionCall: { name: "check_math", args: { total: 5 } }, thoughtSignature: "sig==" }],
  };
  const reply = parseGeminiReply({ candidates: [{ content: modelContent }] });
  assert.equal(reply.toolCalls[0]!.name, "check_math");
  assert.match(reply.toolCalls[0]!.id, /^gemini_call_/);
  const body = geminiBody({
    system: "s",
    turns: [
      AGENT_TURNS[0]!,
      { role: "assistant", text: "", toolCalls: reply.toolCalls, raw: reply.raw },
      { role: "tool", results: [{ id: reply.toolCalls[0]!.id, name: "check_math", content: '{"foots":true}' }] },
    ],
    tools: AGENT_TOOLS,
    forceTool: SUBMIT_TOOL,
    maxTokens: 10,
  });
  const contents = body.contents as { role: string; parts: Record<string, unknown>[] }[];
  assert.deepEqual(contents[1]!.parts, modelContent.parts, "signature survives the round trip");
  const fr = contents[2]!.parts[0]!.functionResponse as Record<string, unknown>;
  assert.equal("id" in fr, false, "an id Google never issued is not sent back");
  assert.deepEqual(fr.response, { foots: true });
  assert.deepEqual(body.toolConfig, {
    functionCallingConfig: { mode: "ANY", allowedFunctionNames: [SUBMIT_TOOL] },
  });
});

test("Gemini replies skip thought parts", () => {
  const reply = parseGeminiReply({
    candidates: [{ content: { parts: [{ text: "hmm", thought: true }, { text: '{"amount":1}' }] } }],
  });
  assert.equal(reply.text, '{"amount":1}');
});

// ── Agent tools ──────────────────────────────────────────────────────────────

const LINES = [
  { text: "SHELL" },
  { text: "123 MAIN ST" },
  { text: "SUBTOTAL 40.00" },
  { text: "TAX 3.20" },
  { text: "TOTAL $ 43.20" },
];

test("find_on_receipt matches text and amounts loosely", () => {
  // Substring search: "total" also surfaces SUBTOTAL, which a verifier wants to see.
  assert.deepEqual(findOnReceipt(LINES, "total"), {
    matches: [
      { line: 3, text: "SUBTOTAL 40.00" },
      { line: 5, text: "TOTAL $ 43.20" },
    ],
  });
  assert.deepEqual(findOnReceipt(LINES, "43.2"), { matches: [{ line: 5, text: "TOTAL $ 43.20" }] });
  assert.deepEqual(findOnReceipt(LINES, "$43.20"), { matches: [{ line: 5, text: "TOTAL $ 43.20" }] });
  assert.ok("note" in findOnReceipt([], "total"));
  assert.ok("error" in findOnReceipt(LINES, "  "));
});

test("check_math foots and carries the rules path's plausibility gates", () => {
  const ok = checkMath({ subtotal: 40, tax: 3.2, total: 43.2 });
  assert.equal(ok.foots, true);
  assert.equal(ok.tax_rate_pct, 8);
  assert.deepEqual(ok.warnings, []);
  const slip = checkMath({ subtotal: 40, tax: 32, total: 72 });
  assert.equal(slip.foots, true);
  assert.match((slip.warnings as string[])[0]!, /misread/);
  const dropped = checkMath({ subtotal: 40, total: 4.32 });
  assert.equal(dropped.foots, false);
  assert.match((dropped.warnings as string[]).join(" "), /dropped/);
  assert.equal(checkMath({ subtotal: 40, discount: 5, total: 35 }).foots, true);
  assert.ok("error" in checkMath({ subtotal: 40 }));
  assert.equal(checkMath({ subtotal: "$40.00", tax: "3.20", total: "43.20" }).foots, true);
});

test("lookup_vendor answers from the brand database", () => {
  assert.deepEqual(lookupVendor("SHELL OIL 5741"), { known: true, brand: "Shell", category: "Fuel", match: "exact" });
  const unknown = lookupVendor("Zzyzx Widgets");
  assert.equal(unknown.known, false);
  assert.ok("error" in lookupVendor(""));
});

test("an unknown tool is an error RESULT, never a thrown run", () => {
  const r = executeTool({ id: "x", name: "rm_rf", args: {} }, { draft: null, lines: [] });
  assert.equal(r.isError, true);
  assert.match(r.content, /Unknown tool/);
});

test("the brief numbers OCR lines, bounds them, and states the draft and its concerns", () => {
  const draft = visionToExtraction({ vendor: "Shell", date: "", amount: 43.2, tax: 3.2, category: "Fuel" });
  const brief = agentBrief({ draft, lines: LINES });
  assert.match(brief, /\s5\| TOTAL \$ 43\.20/);
  assert.match(brief, /vendor Shell, date \(none\), total 43\.2/);
  assert.match(brief, /Its concerns: No date found\./);
  const many = Array.from({ length: 120 }, (_, i) => ({ text: `LINE ${i}` }));
  assert.match(agentBrief({ draft: null, lines: many }), /40 more lines; search them with find_on_receipt/);
});

// ── The loop ─────────────────────────────────────────────────────────────────

function scripted(replies: Partial<ChatReply>[]): ChatClient & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    label: "Fake",
    model: "fake-1",
    requests,
    async chat(req) {
      requests.push(structuredClone(req));
      const next = replies.shift();
      if (!next) throw new Error("script exhausted");
      return { text: "", toolCalls: [], costUsd: 0, ...next };
    },
  };
}

const SUBMITTED = { vendor: "Shell", date: "2026-03-14", amount: 43.2, tax: 3.2, category: "Fuel" };

test("the agent runs a tool, sees its result, then submits", async () => {
  const client = scripted([
    { toolCalls: [{ id: "a", name: "check_math", args: { subtotal: 40, tax: 3.2, total: 43.2 } }], costUsd: 0.001 },
    { toolCalls: [{ id: "b", name: SUBMIT_TOOL, args: SUBMITTED }], costUsd: 0.002 },
  ]);
  const costs: number[] = [];
  const res = await runAgentic(client, IMAGE, { draft: null, lines: LINES }, { onCost: (c) => costs.push(c) });
  assert.deepEqual(res.fields, SUBMITTED);
  assert.equal(res.calls, 2);
  assert.equal(Math.round(res.costUsd * 1000) / 1000, 0.003);
  assert.deepEqual(costs, [0.001, 0.002], "each call's cost reported as it lands");
  const second = client.requests[1]!.turns;
  assert.deepEqual(second.map((t) => t.role), ["user", "assistant", "tool"]);
  const toolTurn = second[2] as Extract<ChatTurn, { role: "tool" }>;
  assert.equal(JSON.parse(toolTurn.results[0]!.content).foots, true);
  assert.match(res.rawText, /check_math .*→ .*"foots":true/);
});

test("a model that answers in JSON text instead of a tool call still counts", async () => {
  const client = scripted([{ text: "Here: " + JSON.stringify(SUBMITTED) }]);
  const res = await runAgentic(client, IMAGE, { draft: null, lines: [] });
  assert.deepEqual(res.fields, SUBMITTED);
  assert.equal(res.calls, 1);
});

test("the last call may only submit; a run that never does fails", async () => {
  const chatter = Array.from({ length: MAX_AGENT_CALLS }, () => ({ text: "Let me think about it." }));
  const client = scripted(chatter);
  await assert.rejects(runAgentic(client, IMAGE, { draft: null, lines: [] }), /no answer within 5 calls/);
  assert.equal(client.requests.length, MAX_AGENT_CALLS);
  const last = client.requests[MAX_AGENT_CALLS - 1]!;
  assert.equal(last.forceTool, SUBMIT_TOOL);
  assert.deepEqual(last.tools!.map((t) => t.name), [SUBMIT_TOOL]);
  assert.equal(client.requests[0]!.forceTool, undefined);
});

test("the spend cap is re-checked before every follow-up call", async () => {
  const client = scripted([
    { toolCalls: [{ id: "a", name: "lookup_vendor", args: { name: "Shell" } }], costUsd: 0.5 },
    { toolCalls: [{ id: "b", name: SUBMIT_TOOL, args: SUBMITTED }] },
  ]);
  await assert.rejects(
    runAgentic(client, IMAGE, { draft: null, lines: [] }, { canSpend: () => false }),
    /Spend cap/,
  );
  assert.equal(client.requests.length, 1);
});

test("one-shot reports its cost even when the answer is unparseable", async () => {
  const costs: number[] = [];
  await assert.rejects(
    runOneShot(scripted([{ text: "sorry", costUsd: 0.004 }]), IMAGE, { onCost: (c) => costs.push(c) }),
    /no parseable JSON/,
  );
  assert.deepEqual(costs, [0.004]);
  const ok = await runOneShot(scripted([{ text: JSON.stringify(SUBMITTED) }]), IMAGE);
  assert.deepEqual(ok.fields, SUBMITTED);
  assert.equal(ok.calls, 1);
});
