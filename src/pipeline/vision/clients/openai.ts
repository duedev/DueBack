import type { ChatClient, ChatReply, ChatRequest, ChatTurn } from "../types.ts";
import { usesFreeRouting, type Endpoint } from "../endpoint.ts";
import { appOrigin, dataUrl, errorBody, toolArgs, visionFetch } from "./shared.ts";

// The OpenAI-compatible dialect: POST {baseUrl}/chat/completions. Most of
// the ecosystem speaks it, so ONE adapter serves three backends — OpenRouter
// in the cloud, Ollama / LM Studio / llama.cpp locally, and vLLM / LiteLLM /
// TGI on a self-hosted box. Only OpenRouter gets its extras (below).
//
// OpenRouter's default is the Free Models Router (`openrouter/free`), which
// picks a free model per request and *smartly filters* to ones that support
// the request's needs — so sending an image constrains it to free vision
// models. Preference for quick + reliable routing: `provider.sort:
// "throughput"` with fallbacks so a busy free provider rolls to another. We
// deliberately DON'T force strict structured outputs on the free router: that
// would filter to the tiny intersection of free + vision + json-schema
// providers and frequently fail. The firm JSON system prompt + the tolerant
// parser do the job; explicit paid models keep the strict schema (and
// require_parameters) for maximum fidelity.

interface OpenAiToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

interface OpenAiResponse {
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | { type?: string; text?: string }[] | null;
      /** LM Studio / DeepSeek-style servers. */
      reasoning_content?: string | null;
      /** vLLM / OpenRouter-style servers. */
      reasoning?: string | null;
      tool_calls?: OpenAiToolCall[];
    };
  }[];
  usage?: { cost?: number };
  /** The model that answered (OpenRouter's router names its pick here; the
   *  ai-extract proxy passes the upstream body through verbatim). */
  model?: string;
  error?: { message?: string };
}

/** Request headers. Through the proxy (`viaProxy`) the OpenRouter
 *  attribution pair is omitted: the function stamps its own on the upstream
 *  call, and every extra request header is one more preflight allow-list
 *  entry that can be wrong on either side of a deploy (it was: the preflight
 *  refused x-title and every signed-in assist failed). A keyless local
 *  server gets no Authorization header at all. */
export function openAiHeaders(
  ep: Pick<Endpoint, "apiKey" | "openRouter" | "viaProxy">,
): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (ep.apiKey) h.Authorization = `Bearer ${ep.apiKey}`;
  if (ep.openRouter && !ep.viaProxy) {
    h["HTTP-Referer"] = appOrigin();
    h["X-Title"] = "DueBack";
  }
  return h;
}

function toMessages(turn: ChatTurn): Record<string, unknown>[] {
  switch (turn.role) {
    case "user":
      return [
        {
          role: "user",
          content: turn.content.map((p) =>
            p.type === "text"
              ? { type: "text", text: p.text }
              : { type: "image_url", image_url: { url: dataUrl(p.base64, p.mediaType) } },
          ),
        },
      ];
    case "assistant":
      // Rebuilt rather than echoed: the canonical shape is the one every
      // compatible server accepts, and stray response-only fields
      // (reasoning, refusal) are refused by the stricter ones.
      return [
        {
          role: "assistant",
          content: turn.text,
          ...(turn.toolCalls.length
            ? {
                tool_calls: turn.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                })),
              }
            : {}),
        },
      ];
    case "tool":
      return turn.results.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.content }));
  }
}

/** The request body for a neutral chat request. Pure; Node-tested (the
 *  one-shot body must also pass the ai-extract proxy's message policy). */
export function openAiBody(req: ChatRequest, ep: Endpoint): Record<string, unknown> {
  const free = ep.openRouter && usesFreeRouting(ep.model);
  const body: Record<string, unknown> = {
    model: ep.model,
    temperature: 0,
    max_tokens: req.maxTokens,
    messages: [{ role: "system", content: req.system }, ...req.turns.flatMap(toMessages)],
  };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = req.forceTool
      ? { type: "function", function: { name: req.forceTool } }
      : "auto";
  }
  if (ep.openRouter) {
    body.usage = { include: true };
    body.provider = free
      ? { sort: "throughput", allow_fallbacks: true }
      : { sort: "throughput", allow_fallbacks: true, require_parameters: true };
  }
  // Structured output everywhere except the free router (see note above).
  if (req.jsonSchema && !free) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "receipt", strict: true, schema: req.jsonSchema },
    };
  }
  return body;
}

/** Map a response into the neutral reply. Pure; Node-tested. */
export function parseOpenAiReply(data: OpenAiResponse, ep: Endpoint): ChatReply {
  // OpenRouter can return HTTP 200 with an error body (e.g. no free provider
  // available right now) — surface it so the pipeline falls back to rules.
  if (data.error?.message) throw new Error(`${ep.label}: ${data.error.message}`);
  const msg = data.choices?.[0]?.message;
  const content = msg?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((p) => p?.text ?? "").join("")
        : "";
  const toolCalls = (msg?.tool_calls ?? [])
    .map((tc, i) => ({
      id: tc.id || `call_${i}`,
      name: tc.function?.name ?? "",
      args: toolArgs(tc.function?.arguments),
    }))
    .filter((tc) => tc.name);
  const costUsd = ep.openRouter && typeof data.usage?.cost === "number" ? data.usage.cost : 0;
  const reasoning =
    typeof msg?.reasoning_content === "string"
      ? msg.reasoning_content
      : typeof msg?.reasoning === "string"
        ? msg.reasoning
        : "";
  return {
    text,
    toolCalls,
    costUsd,
    truncated: data.choices?.[0]?.finish_reason === "length",
    ...(reasoning ? { reasoning } : {}),
    ...(typeof data.model === "string" && data.model ? { model: data.model } : {}),
  };
}

export function createOpenAiClient(ep: Endpoint): ChatClient {
  const post = (body: Record<string, unknown>) =>
    visionFetch(ep, `${ep.baseUrl}/chat/completions`, {
      method: "POST",
      headers: openAiHeaders(ep),
      body: JSON.stringify(body),
    });
  return {
    label: ep.label,
    model: ep.model,
    async chat(req) {
      const body = openAiBody(req, ep);
      let res = await post(body);
      // Not every compatible server implements json_schema output (older
      // llama.cpp / LocalAI builds answer 400). Retry once without it — the
      // tolerant parser still reads a prose-wrapped JSON answer.
      if (res.status === 400 && body.response_format && !ep.openRouter) {
        const detail = await errorBody(res);
        if (!/response_format|json_schema|structured|grammar/i.test(detail)) {
          throw new Error(`${ep.label} HTTP 400: ${detail}`);
        }
        delete body.response_format;
        res = await post(body);
      }
      if (!res.ok) throw new Error(`${ep.label} HTTP ${res.status}: ${await errorBody(res)}`);
      return parseOpenAiReply((await res.json()) as OpenAiResponse, ep);
    },
  };
}
