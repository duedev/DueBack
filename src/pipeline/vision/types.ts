// Tier 3 (DESIGN §5/§9): an optional, confidence-triggered "accuracy dial".
// A vision LLM reads the cleaned receipt image and returns structured fields —
// only for receipts the free on-device rules path is unsure about.
//
// Two independent choices shape a call (vision/config.ts):
//   • BACKEND — where the model runs: `local` (Ollama / LM Studio on this
//     computer), `selfhosted` (your own OpenAI-compatible server) or `cloud`
//     (OpenRouter / Gemini / Anthropic, keyed by the user, the build's free
//     router key, or the signed-in ai-extract proxy).
//   • STRATEGY — how it reads: `oneshot` (image → JSON in one call) or
//     `agentic` (a short tool loop that can check the arithmetic, look the
//     brand up and search the on-device OCR before it submits).
//
// Every backend speaks one of three wire DIALECTS; clients/ adapts a neutral
// chat request (below) to each, so the strategies never see a vendor format.

export type Backend = "local" | "selfhosted" | "cloud";
export type Strategy = "oneshot" | "agentic";
export type ProviderId = "openrouter" | "gemini" | "anthropic";
export type LocalServerId = "ollama" | "lmstudio" | "custom";
export type Dialect = "openai" | "anthropic" | "gemini";

// ── Neutral chat shape ───────────────────────────────────────────────────────

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; base64: string; mediaType: string };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  /** The id of the ToolCall this answers. */
  id: string;
  name: string;
  /** JSON text handed back to the model. */
  content: string;
  isError?: boolean;
}

/** A tool the model may call; `parameters` is plain JSON Schema (the Gemini
 *  adapter converts it to Google's dialect). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ChatTurn =
  | { role: "user"; content: ContentPart[] }
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCall[];
      /** The provider's own message, echoed back verbatim when the next
       *  request goes to the same dialect: Gemini rejects a function call
       *  whose thought signature was dropped, and re-serializing loses it. */
      raw?: { dialect: Dialect; message: unknown };
    }
  | { role: "tool"; results: ToolResult[] };

export interface ChatRequest {
  system: string;
  turns: ChatTurn[];
  tools?: ToolSpec[];
  /** Require this tool on this turn (the agent's last turn forces submit). */
  forceTool?: string;
  /** Ask for structured output matching this JSON Schema (one-shot). */
  jsonSchema?: Record<string, unknown>;
  maxTokens: number;
}

export interface ChatReply {
  text: string;
  toolCalls: ToolCall[];
  /** Measured dollar cost of this call; 0 when free or unknowable. */
  costUsd: number;
  /** The model stopped because it hit the token limit, not because it was
   *  done — a "thinking" model can spend the whole budget reasoning. */
  truncated?: boolean;
  raw?: { dialect: Dialect; message: unknown };
}

/** One configured model endpoint behind the seam. */
export interface ChatClient {
  /** Human label for messages and provenance ("Ollama", "OpenRouter"…). */
  readonly label: string;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatReply>;
}

/** A strategy's result: the model's raw JSON (validated/normalized later by
 *  schema.ts), the raw text kept for the review panel, and the total cost. */
export interface VisionExtraction {
  fields: Record<string, unknown>;
  rawText: string;
  costUsd: number;
  model: string;
  /** Model calls it took (1 for one-shot). */
  calls: number;
}
