import type { ChatClient, ChatReply, ChatRequest, ChatTurn } from "../types.ts";
import type { Endpoint } from "../endpoint.ts";
import { errorBody, toolArgs, visionFetch } from "./shared.ts";

// The Google Gemini dialect — a no-card free tier (e.g. gemini-2.5-flash),
// native vision, function calling, and structured output via responseSchema.
// Browser CORS is supported. Free-tier calls report $0 cost.

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name?: string; args?: unknown };
}

interface GeminiResponse {
  candidates?: { content?: { role?: string; parts?: GeminiPart[] }; finishReason?: string }[];
  /** The model version that answered. */
  modelVersion?: string;
}

/** Ids this adapter invented for calls that came without one; they are
 *  never sent back (Google would not recognize them). */
const SYNTHETIC_ID = "gemini_call_";

/** Convert plain JSON Schema to Gemini's OpenAPI-style dialect: uppercase
 *  type names, and no `additionalProperties`, which it rejects. Pure. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "additionalProperties") continue;
    if (k === "type" && typeof v === "string") out.type = v.toUpperCase();
    else if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([name, s]) => [name, toGeminiSchema(s)]),
      );
    } else if (k === "items") out.items = toGeminiSchema(v);
    else if (k === "enum" && Array.isArray(v)) out.enum = [...v];
    else out[k] = v;
  }
  return out;
}

interface GeminiContent {
  role: "user" | "model";
  parts: unknown[];
}

function toContent(turn: ChatTurn): GeminiContent {
  switch (turn.role) {
    case "user":
      return {
        role: "user",
        parts: turn.content.map((p) =>
          p.type === "text"
            ? { text: p.text }
            : { inline_data: { mime_type: p.mediaType, data: p.base64 } },
        ),
      };
    case "assistant": {
      // Echo the model's own content when we have it: Gemini's thinking
      // models attach a thought signature to each function call and reject
      // a follow-up whose signature was dropped.
      const raw = turn.raw?.dialect === "gemini" ? (turn.raw.message as GeminiContent) : null;
      if (raw && Array.isArray(raw.parts)) return { role: "model", parts: raw.parts };
      return {
        role: "model",
        parts: [
          ...(turn.text ? [{ text: turn.text }] : []),
          ...turn.toolCalls.map((tc) => ({ functionCall: { name: tc.name, args: tc.args } })),
        ],
      };
    }
    case "tool":
      return {
        role: "user",
        parts: turn.results.map((r) => {
          const parsed = toolArgs(r.content);
          return {
            functionResponse: {
              ...(r.id.startsWith(SYNTHETIC_ID) ? {} : { id: r.id }),
              name: r.name,
              response: Object.keys(parsed).length ? parsed : { result: r.content },
            },
          };
        }),
      };
  }
}

/** The request body (the key rides a header, and the model the URL).
 *  Consecutive same-role contents are merged. Pure; Node-tested. */
export function geminiBody(req: ChatRequest): Record<string, unknown> {
  const contents: GeminiContent[] = [];
  for (const c of req.turns.map(toContent)) {
    const prev = contents[contents.length - 1];
    if (prev && prev.role === c.role) prev.parts = [...prev.parts, ...c.parts];
    else contents.push({ ...c, parts: [...c.parts] });
  }
  // No maxOutputTokens: on the 2.5 models thinking tokens count against it,
  // and a tight cap returns an empty answer instead of a short one.
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents,
    generationConfig: {
      temperature: 0,
      ...(req.jsonSchema
        ? { responseMimeType: "application/json", responseSchema: toGeminiSchema(req.jsonSchema) }
        : {}),
    },
  };
  if (req.tools?.length) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: toGeminiSchema(t.parameters),
        })),
      },
    ];
    body.toolConfig = {
      functionCallingConfig: req.forceTool
        ? { mode: "ANY", allowedFunctionNames: [req.forceTool] }
        : { mode: "AUTO" },
    };
  }
  return body;
}

/** Map a response into the neutral reply. Pure; Node-tested. */
export function parseGeminiReply(data: GeminiResponse): ChatReply {
  const content = data.candidates?.[0]?.content;
  const parts = content?.parts ?? [];
  const reasoning = parts
    .filter((p) => p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  return {
    ...(reasoning ? { reasoning } : {}),
    text: parts
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join(""),
    toolCalls: parts
      .filter((p) => p.functionCall?.name)
      .map((p, i) => ({
        id: p.functionCall!.id || `${SYNTHETIC_ID}${i}`,
        name: p.functionCall!.name!,
        args: toolArgs(p.functionCall!.args),
      })),
    // Free tier → $0. Paid usage would be priced from usageMetadata; left
    // at 0 because the free tier is the intended path here.
    costUsd: 0,
    truncated: data.candidates?.[0]?.finishReason === "MAX_TOKENS",
    ...(typeof data.modelVersion === "string" && data.modelVersion ? { model: data.modelVersion } : {}),
    raw: content ? { dialect: "gemini", message: content } : undefined,
  };
}

export function createGeminiClient(ep: Endpoint): ChatClient {
  return {
    label: ep.label,
    model: ep.model,
    async chat(req) {
      // The key rides the x-goog-api-key header Google's own clients use — a
      // ?key= query string was logged by proxies, history and HAR exports.
      const res = await visionFetch(ep, `${ep.baseUrl}/models/${ep.model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": ep.apiKey },
        body: JSON.stringify(geminiBody(req)),
      });
      if (!res.ok) throw new Error(`${ep.label} HTTP ${res.status}: ${await errorBody(res)}`);
      return parseGeminiReply((await res.json()) as GeminiResponse);
    },
  };
}
