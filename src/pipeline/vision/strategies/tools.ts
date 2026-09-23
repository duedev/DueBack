import type { ToolCall, ToolResult, ToolSpec } from "../types.ts";
import type { Extraction } from "../../extract.ts";
import { TAX_MAX_RATIO } from "../../extract.ts";
import { matchVendor, fuzzyMatchVendor, isPaymentBrandName } from "../../../config/vendors.ts";
import { CATEGORIES, categorize } from "../../../config/categories.ts";
import { parseAmount } from "../../../util/money.ts";
import { RECEIPT_JSON_SCHEMA } from "../schema.ts";

// The agent's toolbox: the app's OWN deterministic checks, offered to the
// model so it can verify a reading instead of guessing. Every tool is a pure
// function over the receipt's on-device read — no network, no DOM — so the
// whole set is Node-tested, and a tool can never do anything but answer.

/** What the agent knows besides the image: the rules path's draft (it was
 *  unsure — that is why the agent runs) and the on-device OCR lines. */
export interface AgentContext {
  draft: Extraction | null;
  lines: { text: string }[];
}

export const SUBMIT_TOOL = "submit_receipt";
const MAX_MATCHES = 8;
/** OCR lines shown in the brief; the rest stay reachable via find_on_receipt. */
const BRIEF_MAX_LINES = 80;
const BRIEF_MAX_CHARS = 6000;

const numberParam = (description: string) => ({ type: "number", description });

export const SUBMIT_SPEC: ToolSpec = {
  name: SUBMIT_TOOL,
  description: "Submit the final receipt fields. Call exactly once, when you are confident.",
  parameters: RECEIPT_JSON_SCHEMA as unknown as Record<string, unknown>,
};

export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: "find_on_receipt",
    description:
      "Search the on-device OCR lines for a word, phrase or amount (case-insensitive; spaces and $ ignored). " +
      "Returns the matching line numbers and text. Use it to confirm a value is really printed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string", description: 'Text or amount to look for, e.g. "TOTAL" or "42.10".' },
      },
      required: ["text"],
    },
  },
  {
    name: "check_math",
    description:
      "Check that subtotal + tax + tip - discount equals the total. Returns the expected total, the " +
      "difference, the tax rate, and warnings about implausible values.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        total: numberParam("The grand total you believe was paid."),
        subtotal: numberParam("The printed subtotal, if any."),
        tax: numberParam("The tax, if any."),
        tip: numberParam("A tip or gratuity, if any."),
        discount: numberParam("Discounts, coupons or savings, as a positive number."),
      },
      required: ["total"],
    },
  },
  {
    name: "lookup_vendor",
    description:
      "Look a merchant name up in the app's brand database (hundreds of US chains, OCR-typo tolerant). " +
      "Returns the canonical brand and its expense category, or a keyword-based category guess. " +
      "Says so when the name is a card network or payment processor (never the merchant).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string", description: "The merchant name as read." } },
      required: ["name"],
    },
  },
  SUBMIT_SPEC,
];

const round2 = (n: number) => Math.round(n * 100) / 100;

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) return parseAmount(v);
  return null;
}

/** Lines whose text contains the query, with spaces/$ ignored; an amount
 *  query also matches its two-decimal form ("42.1" finds "$42.10"). */
export function findOnReceipt(lines: AgentContext["lines"], query: string): Record<string, unknown> {
  if (!lines.length) return { matches: [], note: "No on-device text read is available; rely on the image." };
  const squash = (s: string) => s.toLowerCase().replace(/[\s$]/g, "");
  const q = squash(query);
  if (!q) return { error: "Give some text to look for." };
  const needles = [q];
  const amount = /\d/.test(query) ? parseAmount(query) : null;
  if (amount !== null && amount > 0) needles.push(amount.toFixed(2));
  const matches: { line: number; text: string }[] = [];
  lines.forEach((l, i) => {
    const hay = squash(l.text);
    if (needles.some((n) => hay.includes(n))) matches.push({ line: i + 1, text: l.text.slice(0, 120) });
  });
  return {
    matches: matches.slice(0, MAX_MATCHES),
    ...(matches.length > MAX_MATCHES ? { more: matches.length - MAX_MATCHES } : {}),
  };
}

/** Footing arithmetic plus the rules path's own plausibility gates (a tax
 *  above TAX_MAX_RATIO of the subtotal is a misread, a total under the
 *  subtotal with no discount dropped a digit). */
export function checkMath(args: Record<string, unknown>): Record<string, unknown> {
  const total = asNumber(args.total);
  if (total === null) return { error: "total is required." };
  const subtotal = asNumber(args.subtotal);
  const tax = asNumber(args.tax) ?? 0;
  const tip = asNumber(args.tip) ?? 0;
  const discount = Math.abs(asNumber(args.discount) ?? 0);
  const warnings: string[] = [];
  if (total <= 0) warnings.push("The total must be positive.");
  if (subtotal === null) {
    return { expected_total: null, foots: null, warnings: [...warnings, "No subtotal given; nothing to foot."] };
  }
  const expected = round2(subtotal + tax + tip - discount);
  const difference = round2(total - expected);
  if (subtotal > 0 && tax / subtotal > TAX_MAX_RATIO) {
    warnings.push(
      `Tax is ${Math.round((tax / subtotal) * 100)}% of the subtotal; above ${TAX_MAX_RATIO * 100}% is almost always a misread.`,
    );
  }
  if (total < subtotal - 0.005 && discount === 0) {
    warnings.push("The total is below the subtotal with no discount; a digit may have been dropped.");
  }
  return {
    expected_total: expected,
    difference,
    foots: Math.abs(difference) <= 0.02,
    tax_rate_pct: subtotal > 0 ? Math.round((tax / subtotal) * 1000) / 10 : null,
    warnings,
  };
}

/** The brand database's answer for a name: a card network/processor is
 *  called out as not the merchant; else the exact/glyph pass, then the
 *  bounded fuzzy pass, else the keyword categorizer's guess. */
export function lookupVendor(name: string): Record<string, unknown> {
  const q = name.trim();
  if (!q) return { error: "Give a merchant name." };
  // The cheapest place to self-correct: the bold "AMERICAN EXPRESS" on the
  // tender block is what a model reaches for when the header is worn.
  if (isPaymentBrandName(q)) {
    return { known: false, payment_network: true, note: "card network/payment processor — not the merchant" };
  }
  const hit = matchVendor(q);
  if (hit) return { known: true, brand: hit.name, category: hit.category, match: hit.via };
  const fuzzy = fuzzyMatchVendor(q);
  if (fuzzy) {
    return { known: true, brand: fuzzy.name, category: fuzzy.category, match: "fuzzy", similarity: round2(fuzzy.ratio) };
  }
  const cat = categorize(q, "", null);
  return { known: false, category_guess: cat.matched ? cat.category : null };
}

/** Run one tool call. Unknown tools and bad arguments come back as an
 *  error RESULT (the model can correct itself), never a thrown run. */
export function executeTool(call: ToolCall, ctx: AgentContext): ToolResult {
  const result = (content: unknown, isError = false): ToolResult => ({
    id: call.id,
    name: call.name,
    content: JSON.stringify(content),
    ...(isError ? { isError } : {}),
  });
  try {
    switch (call.name) {
      case "find_on_receipt":
        return result(findOnReceipt(ctx.lines, String(call.args.text ?? "")));
      case "check_math":
        return result(checkMath(call.args));
      case "lookup_vendor":
        return result(lookupVendor(String(call.args.name ?? "")));
      default:
        return result({ error: `Unknown tool "${call.name}".` }, true);
    }
  } catch (err) {
    return result({ error: err instanceof Error ? err.message : String(err) }, true);
  }
}

/** The agent's opening message: the OCR lines (numbered, bounded), the
 *  rules draft and its concerns, and the job. Pure; Node-tested. */
export function agentBrief(ctx: AgentContext): string {
  const parts: string[] = [
    "The attached image is a receipt. An on-device reader already tried it and was unsure of its result.",
  ];
  if (ctx.lines.length) {
    const shown: string[] = [];
    let chars = 0;
    for (const [i, l] of ctx.lines.slice(0, BRIEF_MAX_LINES).entries()) {
      const row = `${String(i + 1).padStart(3)}| ${l.text}`;
      if (chars + row.length > BRIEF_MAX_CHARS) break;
      shown.push(row);
      chars += row.length + 1;
    }
    const hidden = ctx.lines.length - shown.length;
    parts.push(
      "Its OCR text (OCR errors are common):\n" +
        shown.join("\n") +
        (hidden > 0 ? `\n(${hidden} more lines; search them with find_on_receipt)` : ""),
    );
  } else {
    parts.push("No on-device text read is available; read the image.");
  }
  const d = ctx.draft;
  if (d) {
    const fmt = (v: string | number) => (v === "" || v === 0 ? "(none)" : String(v));
    parts.push(
      `Its draft: vendor ${fmt(d.vendor.value)}, date ${fmt(d.date.value)}, total ${fmt(d.amount.value)}, ` +
        `tax ${fmt(d.tax.value)}, category ${d.category.value}.`,
    );
    const concerns = d.flags.filter((f) => f.severity !== "info").map((f) => f.message);
    if (concerns.length) parts.push(`Its concerns: ${concerns.join(" ")}`);
  }
  parts.push(
    "Read the IMAGE yourself; the draft may be wrong. Use the tools for what you are unsure of: " +
      "check_math for the arithmetic, lookup_vendor for the brand and category, find_on_receipt to " +
      `confirm a value is printed. Then call ${SUBMIT_TOOL} exactly once. Allowed categories: ` +
      `${CATEGORIES.join(", ")}. Amounts are US dollars; the date is ISO yyyy-mm-dd.`,
  );
  return parts.join("\n\n");
}
