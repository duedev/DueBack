import type { Category, Field, Flag, OcrLine } from "../../types.ts";
import { brandFieldFromLines, dateFlags, vendorNameProblem, type Extraction } from "../extract.ts";
import { CATEGORIES, categorize } from "../../config/categories.ts";
import { CONFIDENCE, FLAGS, CURRENCY_DEFAULT } from "../../config/constants.ts";
import { stripProcessorPrefix } from "../../config/vendors.ts";
import { wellFormed } from "./provenance.ts";
import { parseAmount, safeAmount } from "../../util/money.ts";
import { isValidIso } from "../../util/format.ts";

// The contract with the vision model + the mapping of its JSON back into the
// app's `Extraction` shape. Pure (no network, no DOM) so it is unit-testable
// and shared by every provider.

/** JSON Schema for structured outputs and the agent's submit tool. Plain JSON
 *  Schema; clients/gemini.ts converts it to Google's dialect. */
export const RECEIPT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    vendor: {
      type: "string",
      description: "Merchant/brand name — not the street address, the city, or the card network/payment processor.",
    },
    date: { type: "string", description: "Purchase date as ISO yyyy-mm-dd." },
    amount: { type: "number", description: "Grand total actually paid." },
    tax: { type: "number", description: "Tax amount, or 0 if none shown." },
    category: { type: "string", enum: CATEGORIES },
  },
  required: ["vendor", "date", "amount", "tax", "category"],
} as const;

export const SYSTEM_PROMPT =
  "You are a meticulous receipt-data extractor. Read the receipt image and " +
  "return ONLY the requested fields as strict JSON. Use the merchant/brand name " +
  "for vendor — never the street address, the city, or the card network/payment " +
  "processor printed on the tender lines (American Express, Visa, Square…). " +
  "Date must be ISO yyyy-mm-dd. amount is " +
  "the grand total actually paid; tax is the tax line (0 if none). Pick the single " +
  "best category from the allowed list. Do not invent values you cannot see.";

export function userInstruction(): string {
  return (
    "Extract the receipt fields as JSON. Allowed categories: " +
    CATEGORIES.join(", ") +
    ". Amounts are US dollars."
  );
}

/** Best-effort JSON parse of a model text response (tolerates code fences and
 *  surrounding prose). Returns a loose record or null. */
export function parseVisionJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  // Reasoning models on the free router leak <think>…</think> blocks, whose
  // braces used to defeat the first-"{"-to-last-"}" slice.
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const fenced = stripped.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : stripped;
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(s);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  // Widest slice first (the common case), then every balanced object from
  // each "{" — prose or a stray brace before the JSON no longer sinks it.
  const end = body.lastIndexOf("}");
  for (let start = body.indexOf("{"); start >= 0 && start < end; start = body.indexOf("{", start + 1)) {
    const wide = tryParse(body.slice(start, end + 1));
    if (wide) return wide;
    let depth = 0;
    for (let i = start; i <= end; i++) {
      const ch = body[i];
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        const balanced = tryParse(body.slice(start, i + 1));
        if (balanced) return balanced;
        break;
      }
    }
  }
  return null;
}

/** A JSON object must at least look like a receipt before it is taken as the
 *  answer from anywhere but the model's proper answer channel — a
 *  tool-argument object echoed in prose, or a scratch object in reasoning,
 *  must not end a run. */
export function looksLikeReceipt(fields: Record<string, unknown>): boolean {
  return "amount" in fields || "vendor" in fields;
}

/** Some servers file a thinking model's WHOLE output as reasoning when the
 *  structured-output grammar keeps it from ever closing its thinking block
 *  (LM Studio: `content: ""`, the JSON in `reasoning_content`). Only when the
 *  visible answer is EMPTY is the reasoning read, and only a receipt-shaped
 *  object from it counts — a real answer is never overridden. */
export function answerFromReasoning(reply: {
  text: string;
  reasoning?: string;
}): Record<string, unknown> | null {
  if (reply.text.trim() || !reply.reasoning?.trim()) return null;
  const fields = parseVisionJson(reply.reasoning);
  return fields && looksLikeReceipt(fields) ? fields : null;
}

function coerceAmount(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return safeAmount(v);
  if (typeof v === "string") return safeAmount(parseAmount(v) ?? 0);
  return 0;
}

/** What the assist knows besides the model's JSON: vision/index.ts passes
 *  both; the settings probe and legacy callers pass neither. Extend THIS
 *  (never a positional parameter) when the mapping needs more evidence. */
export interface VisionContext {
  /** The rules path's draft for this receipt (it was unsure — that is why
   *  the assist ran). */
  draft?: Extraction | null;
  /** The on-device OCR lines — what a rejected vendor falls back to. */
  lines?: OcrLine[];
}

/**
 * The model's vendor, vetted against the receipt's own OCR read. A model
 * copies the clearest text it sees, and on a worn slip that is often the
 * bold card-network line (it answered "AMERICAN EXPRESS" for a Banning, CA
 * fill-up) or the address block's city. Such an answer is never taken:
 *   • the brand the OCR prints near the top (or in the site ID) replaces it
 *     silently — the same evidence the rules trust without review;
 *   • a brand printed only further down (a footer ad?) replaces it, flagged;
 *   • else a cleanly-read rules header (≥ 0.8) is kept, flagged;
 *   • else the vendor is BLANKED, flagged — a known-wrong value must not
 *     reach file names and the workbook through a click-through review.
 * The `vendor_unclear` warn quotes the model's answer and forces review
 * (`extract.forcesManualReview`). A draft vendor keeps no box of its own:
 * anchoring (provenance.ts) re-finds it on the lines, guarded against logo
 * fusion's leftover box; a brand's box comes straight from its OCR line.
 * Pure; Node-tested.
 */
export function vetVisionVendor(
  name: string,
  ctx: VisionContext = {},
): { field: Field<string>; flag?: Flag } {
  const lines = ctx.lines ?? [];
  const problem = vendorNameProblem(name, lines);
  if (!problem) return { field: { value: name, confidence: name ? 0.9 : 0 } };
  const what = problem === "payment" ? "a card network/payment processor" : "the city printed on the receipt";
  const unclear = (message: string): Flag => ({ code: "vendor_unclear", severity: "warn", message });
  const brand = brandFieldFromLines(lines);
  if (brand?.header) return { field: brand.field };
  if (brand) {
    return {
      field: brand.field,
      flag: unclear(
        `The AI named ${what} ("${name}"), not the merchant — used "${brand.field.value}", printed further down the receipt; confirm the vendor.`,
      ),
    };
  }
  const draft = ctx.draft?.vendor;
  if (draft?.value && draft.confidence >= 0.8 && !vendorNameProblem(draft.value, lines)) {
    return {
      field: { value: draft.value, confidence: draft.confidence },
      flag: unclear(
        `The AI named ${what} ("${name}"), not the merchant — kept the printed header "${draft.value}"; confirm the vendor.`,
      ),
    };
  }
  return {
    field: { value: "", confidence: 0 },
    flag: unclear(`The AI named ${what} ("${name}"), not the merchant — enter the vendor.`),
  };
}

/** Map a model's loose JSON into the app's `Extraction` (same shape the rules
 *  path produces), so the rest of the pipeline is identical for either tier.
 *  `ctx` lets the vendor be vetted against the receipt's own OCR read
 *  (`vetVisionVendor`); a processor prefix ("SQ *JOES COFFEE") is dropped. */
export function visionToExtraction(raw: Record<string, unknown>, ctx: VisionContext = {}): Extraction {
  // Cut on a code point and made well-formed: a lone surrogate (an emoji
  // split at 80, or a model's broken \ud83d escape) makes Postgres refuse
  // the whole receipts upsert on every push.
  const vetted = vetVisionVendor(wellFormed(Array.from(stripProcessorPrefix(String(raw.vendor ?? "").trim())).slice(0, 80).join("")), ctx);
  const vendorName = vetted.field.value;
  const amountVal = coerceAmount(raw.amount);
  const taxVal = coerceAmount(raw.tax);

  const dateRaw = String(raw.date ?? "").trim();
  const dateVal = isValidIso(dateRaw) ? dateRaw : "";

  const currency = CURRENCY_DEFAULT; // USD-only app

  const catRaw = String(raw.category ?? "").trim();
  const modelCat = CATEGORIES.find((c) => c === catRaw);
  const cat: { category: Category; matched: boolean } = modelCat
    ? { category: modelCat, matched: true }
    : categorize(vendorName);

  const vendor: Field<string> = vetted.field;
  const date: Field<string> = { value: dateVal, confidence: dateVal ? 0.9 : 0 };
  const amount: Field<number> = { value: amountVal, confidence: amountVal > 0 ? 0.92 : 0 };
  const tax: Field<number> = { value: taxVal, confidence: 0.85 };
  const category: Field<Category> = {
    value: cat.category,
    confidence: cat.matched ? 0.9 : 0.4,
  };

  const flags: Flag[] = [];
  if (amountVal <= 0) flags.push({ code: "no_amount", severity: "error", message: "No total found." });
  if (!dateVal) flags.push({ code: "no_date", severity: "warn", message: "No date found." });
  if (vetted.flag) flags.push(vetted.flag);
  else if (!vendorName) flags.push({ code: "no_vendor", severity: "warn", message: "No vendor found." });
  if (!cat.matched) flags.push({ code: "uncategorized", severity: "info", message: "Category is a guess." });
  if (amountVal > FLAGS.largeAmount) {
    flags.push({ code: "large_amount", severity: "info", message: "Unusually large amount — verify." });
  }
  // The rules' own plausibility flags (future / stale / more than two years
  // old — a model misreads a faded year as readily as the OCR does).
  flags.push(...dateFlags(dateVal ? date : null));

  // A vision read with all key fields present is high-confidence; missing fields
  // and warnings pull it down, routing the receipt back into the review sweep.
  let confidence = 0.92;
  if (amountVal <= 0) confidence -= 0.45;
  if (!dateVal) confidence -= 0.15;
  if (!vendorName) confidence -= 0.15;
  for (const f of flags) {
    if (f.severity === "error") confidence -= 0.15;
    else if (f.severity === "warn") confidence -= 0.07;
  }
  confidence = Math.max(0, Math.min(1, confidence));
  if (confidence < CONFIDENCE.reviewBelow) {
    flags.push({ code: "low_confidence", severity: "info", message: "Low confidence — please review." });
  }

  return { vendor, date, amount, tax, currency, category, confidence, flags };
}
