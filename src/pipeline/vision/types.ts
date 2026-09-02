// Tier 3 (DESIGN §5/§9): an optional, confidence-triggered "paid accuracy dial".
// A vision LLM reads the cleaned receipt image and returns structured fields in
// one shot — collapsing OCR + rules + categorization for the low-confidence path.
//
// This is the seam the README's two-tier vision describes: it sits *behind* the
// free on-device default and only fires for receipts the rules path is unsure
// about. Three ways it gets a key: the user pastes their own (Settings), a
// build made with OPENROUTER_API_KEY bakes in the free router and turns the
// tier ON by default (deliberate zero-click — one switch in Settings turns it
// off), or a signed-in user is routed through the ai-extract Edge Function
// that holds the deployer's key — see vision/config.ts and the privacy note.

export type ProviderId = "openrouter" | "gemini" | "anthropic";

/** The structured fields a vision model is asked to return. */
export interface VisionFields {
  vendor: string;
  /** ISO yyyy-mm-dd. */
  date: string;
  amount: number;
  tax: number;
  category?: string;
}

/** A provider's result: the model's raw JSON (validated/normalized later by
 *  schema.ts), the raw response text (kept for the review panel), and the
 *  measured dollar cost of the call (free models/tiers report 0). */
export interface VisionExtraction {
  fields: Record<string, unknown>;
  rawText: string;
  costUsd: number;
  model: string;
}

/** One provider behind the seam. `extract` does the network round-trip. */
export interface VisionProvider {
  readonly id: ProviderId;
  extract(image: Blob): Promise<VisionExtraction>;
}
