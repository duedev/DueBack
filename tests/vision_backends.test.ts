import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultVisionConfig,
  mergeVisionConfig,
  normalizeVisionConfig,
  type VisionConfig,
} from "../src/pipeline/vision/config.ts";
import {
  CLOUD_MAX_TOKENS,
  CLOUD_TIMEOUT_MS,
  LOCAL_MAX_TOKENS,
  LOCAL_TIMEOUT_MS,
  effectiveStrategy,
  endpointProblem,
  resolveEndpoint,
  type Endpoint,
} from "../src/pipeline/vision/endpoint.ts";
import { openAiBody, openAiHeaders, parseOpenAiReply } from "../src/pipeline/vision/clients/openai.ts";
import { anthropicBody, parseAnthropicReply } from "../src/pipeline/vision/clients/anthropic.ts";
import { geminiBody, parseGeminiReply, toGeminiSchema } from "../src/pipeline/vision/clients/gemini.ts";
import { toolArgs, unreachableHint } from "../src/pipeline/vision/clients/shared.ts";
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

test("every dialect surfaces the model the server says answered", () => {
  // OpenRouter's free router names its pick per request.
  const or = resolveEndpoint(cfg(), "k");
  const routed = parseOpenAiReply(
    { model: "meta-llama/llama-3.2-11b-vision-instruct:free", choices: [{ message: { content: "{}" } }] },
    or,
  );
  assert.equal(routed.model, "meta-llama/llama-3.2-11b-vision-instruct:free");
  assert.equal("model" in parseOpenAiReply({ choices: [{ message: { content: "{}" } }] }, or), false);
  assert.equal("model" in parseOpenAiReply({ model: "", choices: [{ message: { content: "{}" } }] }, or), false);
  // Anthropic answers an alias with its dated snapshot; Gemini reports its version.
  const an = resolveEndpoint(cfg({ cloud: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "k" } }), "");
  assert.equal(parseAnthropicReply({ model: "claude-haiku-4-5-20251001", content: [] }, an).model, "claude-haiku-4-5-20251001");
  assert.equal("model" in parseAnthropicReply({ content: [] }, an), false);
  assert.equal(parseGeminiReply({ modelVersion: "gemini-2.5-flash", candidates: [] }).model, "gemini-2.5-flash");
  assert.equal("model" in parseGeminiReply({ candidates: [] }), false);
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
  // The card network on the tender block is called out, not looked up.
  assert.deepEqual(lookupVendor("AMERICAN EXPRESS"), {
    known: false,
    payment_network: true,
    note: "card network/payment processor — not the merchant",
  });
  assert.equal(lookupVendor("Panda Express").payment_network, undefined);
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

test("a run reports the model(s) that actually answered, not just the configured id", async () => {
  const one = await runOneShot(scripted([{ text: JSON.stringify(SUBMITTED), model: "qwen/x:free" }]), IMAGE);
  assert.equal(one.model, "fake-1", "the configured id stays");
  assert.equal(one.servedModel, "qwen/x:free");
  const silent = await runOneShot(scripted([{ text: JSON.stringify(SUBMITTED) }]), IMAGE);
  assert.equal("servedModel" in silent, false);
  // The router can hand each call of one agent run to a different model.
  const agent = await runAgentic(
    scripted([
      { toolCalls: [{ id: "a", name: "lookup_vendor", args: { name: "Shell" } }], model: "a" },
      { toolCalls: [{ id: "b", name: SUBMIT_TOOL, args: SUBMITTED }], model: "b" },
    ]),
    IMAGE,
    { draft: null, lines: [] },
  );
  assert.equal(agent.servedModel, "a, b");
  const quiet = await runAgentic(scripted([{ toolCalls: [{ id: "b", name: SUBMIT_TOOL, args: SUBMITTED }] }]), IMAGE, {
    draft: null,
    lines: [],
  });
  assert.equal("servedModel" in quiet, false);
});

// ── Unreachable-server hint ──────────────────────────────────────────────────

test("an unreachable local server's hint names every cause fetch() hides, and points at the console", () => {
  const lan = resolveEndpoint(
    cfg({ backend: "selfhosted", selfhosted: { url: "http://10.0.0.167:1234/v1", model: "m" } }),
    "",
  );
  const onHttps = unreachableHint(lan, "https:");
  assert.match(onHttps, /^couldn't reach http:\/\/10\.0\.0\.167:1234\/v1\./, "the label isn't repeated");
  assert.match(onHttps, /CORS/);
  assert.match(onHttps, /ERR_BLOCKED_BY_CLIENT is an extension/);
  assert.match(onHttps, /local network access/);
  assert.match(onHttps, /Mixed Content/, "an https page calling http:// on the LAN");
  // Loopback is exempt from mixed content everywhere, and an http page never mixes.
  const loopback = resolveEndpoint(cfg({ backend: "local" }), "");
  assert.doesNotMatch(unreachableHint(loopback, "https:"), /Mixed Content/);
  assert.match(unreachableHint(loopback, "https:"), /OLLAMA_ORIGINS=/);
  assert.doesNotMatch(unreachableHint(lan, "http:"), /Mixed Content/);
  // Cloud stays terse: none of these causes apply to a public API.
  assert.equal(unreachableHint(resolveEndpoint(cfg(), "k")), "couldn't reach https://openrouter.ai/api/v1.");
});

// ── Why a reply was unusable ─────────────────────────────────────────────────

test("every dialect reports a reply the token limit cut off", () => {
  const ep = resolveEndpoint(cfg({ backend: "local" }), "");
  assert.equal(parseOpenAiReply({ choices: [{ finish_reason: "length", message: { content: "<think>" } }] }, ep).truncated, true);
  assert.equal(parseOpenAiReply({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] }, ep).truncated, false);
  const an = resolveEndpoint(cfg({ cloud: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "k" } }), "");
  assert.equal(parseAnthropicReply({ content: [], stop_reason: "max_tokens" }, an).truncated, true);
  assert.equal(parseGeminiReply({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] }).truncated, true);
});

test("free backends get a roomy answer budget; metered cloud stays tight", () => {
  assert.equal(resolveEndpoint(cfg({ backend: "local" }), "").maxTokens, LOCAL_MAX_TOKENS);
  assert.equal(
    resolveEndpoint(cfg({ backend: "selfhosted", selfhosted: { url: "http://x/v1", model: "m" } }), "").maxTokens,
    LOCAL_MAX_TOKENS,
  );
  assert.equal(resolveEndpoint(cfg(), "k").maxTokens, CLOUD_MAX_TOKENS);
  assert.ok(LOCAL_MAX_TOKENS > CLOUD_MAX_TOKENS);
});

test("an unparseable one-shot reply says how it began and whether it was cut off", async () => {
  const thinking = scripted([{ text: "<think>The receipt shows a cafe. Let me look at the total", truncated: true }]);
  await assert.rejects(runOneShot(thinking, IMAGE, { maxTokens: 4096 }), (err: Error) => {
    assert.match(err.message, /returned no parseable JSON\. It began: "<think>The receipt shows a cafe/);
    assert.match(err.message, /cut off at the 4096-token limit/);
    assert.match(err.message, /turn thinking off/);
    return true;
  });
  assert.equal(thinking.requests[0]!.maxTokens, 4096, "the endpoint's budget reaches the request");
  await assert.rejects(runOneShot(scripted([{ text: "  " }]), IMAGE), /The reply was empty\.$/);
  await assert.rejects(runOneShot(scripted([{ text: "I cannot read this." }]), IMAGE), (err: Error) => {
    assert.doesNotMatch(err.message, /cut off/, "not truncated, so no token-limit advice");
    return true;
  });
});

test("an agent run that never answers quotes its last reply", async () => {
  const chatter = Array.from({ length: MAX_AGENT_CALLS }, () => ({ text: "Still thinking…", truncated: true }));
  await assert.rejects(runAgentic(scripted(chatter), IMAGE, { draft: null, lines: [] }), (err: Error) => {
    assert.match(err.message, /no answer within 5 calls\. Its last reply: It began: "Still thinking…"/);
    assert.match(err.message, /cut off at the 1024-token limit/);
    return true;
  });
});

// ── A thinking model that files its answer as reasoning ──────────────────────

// Verbatim from LM Studio serving prism-ml/bonsai-27b to a one-shot Test
// connection: structured output kept the whole answer inside the thinking
// block, so `content` came back empty and the JSON landed in reasoning.
const LM_STUDIO_REASONING_ONLY = {
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "",
        reasoning_content:
          '{"vendor": "TEST CAFE", "date": "2026-01-02", "amount": 4.2, "tax": 0, "category": "Meals"}',
        tool_calls: [],
      },
      finish_reason: "stop",
    },
  ],
};

test("an answer filed entirely as reasoning is still read (LM Studio + a thinking model)", async () => {
  const ep = resolveEndpoint(cfg({ backend: "selfhosted", selfhosted: { url: "http://x/v1", model: "m" } }), "");
  const reply = parseOpenAiReply(LM_STUDIO_REASONING_ONLY, ep);
  assert.equal(reply.text, "");
  assert.match(reply.reasoning!, /TEST CAFE/);
  const res = await runOneShot(scripted([reply]), IMAGE);
  assert.deepEqual(res.fields, { vendor: "TEST CAFE", date: "2026-01-02", amount: 4.2, tax: 0, category: "Meals" });
  assert.match(res.rawText, /TEST CAFE/, "the provenance keeps what the model wrote");
  // vLLM / OpenRouter name the same channel `reasoning`.
  assert.equal(parseOpenAiReply({ choices: [{ message: { content: "", reasoning: "r" } }] }, ep).reasoning, "r");
  // Gemini's thought parts are its reasoning channel.
  assert.equal(parseGeminiReply({ candidates: [{ content: { parts: [{ text: "hmm", thought: true }] } }] }).reasoning, "hmm");
});

test("reasoning never overrides a real answer, and only a receipt-shaped object counts", async () => {
  // A visible (if unparseable) answer wins: the reasoning is not consulted.
  await assert.rejects(
    runOneShot(scripted([{ text: "I can't read this receipt.", reasoning: '{"vendor":"X","amount":1}' }]), IMAGE),
    /It began: "I can't read this receipt\."/,
  );
  // Scratch JSON in reasoning that isn't a receipt is not an answer.
  await assert.rejects(
    runOneShot(scripted([{ text: "", reasoning: 'Plan: call {"step":1} first' }]), IMAGE),
    /The reply was empty; the model wrote only reasoning: "Plan: call/,
  );
  // The agent loop takes the same fallback instead of burning its calls.
  const res = await runAgentic(
    scripted([{ text: "\n\n", reasoning: JSON.stringify(SUBMITTED) }]),
    IMAGE,
    { draft: null, lines: [] },
  );
  assert.deepEqual(res.fields, SUBMITTED);
  assert.equal(res.calls, 1);
});
