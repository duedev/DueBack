import type { AssistProvenance, BBox, Field, Flag, OcrLine, Receipt } from "../../types.ts";
import { findAliasOnLines, findDateEvidence, locateValue, VENDOR_STOPWORD_RE, type Extraction } from "../extract.ts";
import { FUZZY_HINT_RATIO, fuzzyMatchVendorLines, matchVendor } from "../../config/vendors.ts";
import { formatMoney } from "../../util/money.ts";
import { BUILTIN_OPENROUTER_KEY } from "./config.ts";
import type { Endpoint } from "./endpoint.ts";
import type { Strategy, VisionExtraction } from "./types.ts";

// A vision model answers with VALUES only — never where on the receipt it saw
// them. The geometry therefore comes from the on-device OCR lines, which know
// where every line sits: the model says WHAT, the OCR says WHERE. A value the
// OCR can't find gets no box rather than a guess (a highlight on the wrong
// line is worse than none), and that "can't find it" is itself evidence the
// model may have invented the value — `corroborate` turns it into a review
// flag, never into a changed value. The provenance record says which model
// read the receipt, where it ran, whose key it used and how (one-shot vs
// agentic), next to the rules read it replaced. Pure; Node-tested.

/** The model's raw answer is kept up to this many characters — the TAIL,
 *  because the agent's submit line and a reasoning-channel JSON come last. */
export const ASSIST_RAW_MAX = 4000;

// A UTF-16 surrogate without its partner: half of an emoji or other astral
// character. The stored answer rides the sync payload (`Receipt.assist`), and
// Postgres jsonb refuses a lone surrogate — the whole receipts upsert fails,
// on every push after, with nothing in the UI to find or fix the row.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `s` with every lone surrogate replaced by U+FFFD (what
 *  `String.prototype.toWellFormed` does; ES2022 lacks it). A model can emit
 *  one itself (a broken "\ud83d" escape), not only a cut. */
export function wellFormed(s: string): string {
  return s.replace(LONE_SURROGATE_RE, "\uFFFD");
}

export function tailCap(s: string): string {
  if (s.length <= ASSIST_RAW_MAX) return wellFormed(s);
  let tail = s.slice(-ASSIST_RAW_MAX);
  // The cut landed inside a surrogate pair: drop the orphaned low half.
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return `…${wellFormed(tail)}`;
}

// ── Boxes ────────────────────────────────────────────────────────────────────

/** A box a field already carries is trusted as-is. The model never returns
 *  geometry, so a box on an AI field was put there by code that took the
 *  value from the OCR read (vetting that falls back to the rules vendor, for
 *  one) — re-anchoring it could only move it off the line it came from. Only
 *  a malformed box is stripped and re-found. */
function usableBox(b: BBox | undefined): b is BBox {
  return (
    !!b &&
    [b.x, b.y, b.w, b.h].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    b.w > 0 &&
    b.h > 0
  );
}

/** The field with its box settled: a blank value never carries one; a
 *  usable box it already has is kept; otherwise `find` supplies one, or the
 *  field goes without. Never mutates `f`, never changes its value. */
function anchorField<T>(f: Field<T>, hasValue: boolean, find: () => BBox | undefined): Field<T> {
  const { bbox, ...rest } = f;
  if (!hasValue) return rest;
  if (usableBox(bbox)) return { ...rest, bbox: { ...bbox } };
  const found = find();
  return found ? { ...rest, bbox: { ...found } } : rest;
}

/** Lowercased, punctuation-folded text for "same vendor" comparisons. */
function foldName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Same text, or the same brand by the matcher ("Home Depot" vs "The Home
 *  Depot", "MOBIL MART" vs "Mobil", "Chevron Station Inc." vs "Chevron"). */
function sameVendor(ai: string, draft: string): boolean {
  if (!ai || !draft) return false;
  if (foldName(ai) === foldName(draft)) return true;
  const brand = matchVendor(ai)?.name;
  return !!brand && brand === matchVendor(draft)?.name;
}

/** The OCR lines a box sits on: its vertical centre inside the line and some
 *  horizontal overlap (a brand box is a slice of its line, same y/h). */
function linesUnder(lines: OcrLine[], box: BBox): OcrLine[] {
  const cy = box.y + box.h / 2;
  return lines.filter((l) => {
    const b = l.bbox;
    if (!b || b.w <= 0 || b.h <= 0) return false;
    const overlapX = Math.min(b.x + b.w, box.x + box.w) - Math.max(b.x, box.x);
    return cy >= b.y && cy <= b.y + b.h && overlapX > 0;
  });
}

/** Does this line print `text` (word-bounded, glyph-folded fallback) or name
 *  `brand` the way the rules would have read it (exact/glyph brand pass, or
 *  the fuzzy header sweep at its acceptance ratio)? */
function lineHolds(line: OcrLine, text: string, brand: string | undefined): boolean {
  const probe = text.trim().toLowerCase();
  if (probe.length >= 3 && findAliasOnLines([line], probe)) return true;
  if (!brand) return false;
  if (matchVendor(line.text)?.name === brand) return true;
  const fuzzy = fuzzyMatchVendorLines([line.text]);
  return !!fuzzy && fuzzy.ratio >= FUZZY_HINT_RATIO && fuzzy.name === brand;
}

// Words too generic to tie two vendor names together on their own.
const CORPORATE_WORDS = new Set([
  "inc", "llc", "ltd", "co", "corp", "corporation", "company", "store", "stores",
  "station", "stations", "mart", "market", "shop", "center", "centers", "centre",
  "service", "services", "group",
]);

/** The AI vendor's distinctive words: ≥ 4 letters, not a stopword, not a
 *  corporate/generic business word. */
function distinctiveTokens(s: string): string[] {
  return foldName(s)
    .split(" ")
    .filter(
      (t) =>
        (t.match(/[a-z]/g) ?? []).length >= 4 &&
        !VENDOR_STOPWORD_RE.test(t) &&
        !CORPORATE_WORDS.has(t),
    );
}

function anchorVendor(ai: Field<string>, draft: Field<string>, lines: OcrLine[]): Field<string> {
  const value = ai.value.trim();
  return anchorField(ai, value.length > 0, () => {
    // (a) The model's full string printed verbatim — boxes "Palm Spring
    //     Chevron" whole, where the rules box is only the "Chevron" slice.
    const full = value.toLowerCase().replace(/\s+/g, " ");
    if (full.length >= 3) {
      const hit = findAliasOnLines(lines, full);
      if (hit) return hit.bbox;
    }
    const dBox = usableBox(draft.bbox) ? draft.bbox : undefined;
    // (b) Same text or brand as the rules read → the rules' box, which knows
    //     the alias that produced it. Only when that box really holds the
    //     draft text or brand: logo fusion renames the vendor but keeps the
    //     previous OCR line's box.
    if (dBox && sameVendor(value, draft.value)) {
      const brand = matchVendor(value)?.name ?? matchVendor(draft.value)?.name;
      if (linesUnder(lines, dBox).some((l) => lineHolds(l, draft.value, brand))) return dBox;
    }
    // (c) The locator a review correction uses (full name, then the leading
    //     non-stopword).
    const located = locateValue(lines, "vendor", value);
    if (located) return located.bbox;
    // (d) The rules' vendor line shares a distinctive word with the model's
    //     name ("WHOLESALE" → "Costco Wholesale"); generic business words
    //     ("station", "inc") never tie two names together.
    if (dBox) {
      const under = linesUnder(lines, dBox);
      const shared = distinctiveTokens(value).some((t) => under.some((l) => findAliasOnLines([l], t)));
      if (shared) return dBox;
    }
    return undefined;
  });
}

/**
 * Give an AI read's vendor/date/amount honest boxes on the OCR lines. Values,
 * tax, category, flags and confidence are untouched, and `ai` is never
 * mutated. Per field: a usable box it already carries stays (see
 * `usableBox`); a blank value gets none; otherwise —
 *   • amount/date: the rules draft's box when the model read the SAME value
 *     (its locator knew the total tier / date ranking), else `locateValue`;
 *   • vendor: the full string on a line → the draft's box for the same text
 *     or brand (guarded) → `locateValue` → the draft's box when its line
 *     shares a distinctive word;
 *   • else no box — a draft box for a DIFFERENT value never transfers (an AI
 *     107.38 must not inherit the rules' 187.38 box).
 * Any post-processing of the AI values (vendor vetting, falling back to the
 * rules read) must run BEFORE this, or the box lands on a value that is no
 * longer displayed.
 */
export function anchorAssistBoxes(ai: Extraction, draft: Extraction, lines: OcrLine[]): Extraction {
  const amount = ai.amount.value;
  const date = ai.date.value;
  return {
    ...ai,
    vendor: anchorVendor(ai.vendor, draft.vendor, lines),
    date: anchorField(ai.date, !!date, () =>
      date === draft.date.value && usableBox(draft.date.bbox)
        ? draft.date.bbox
        : locateValue(lines, "date", date)?.bbox,
    ),
    amount: anchorField(ai.amount, Number.isFinite(amount) && amount > 0, () =>
      Math.abs(amount - draft.amount.value) < 0.005 && usableBox(draft.amount.bbox)
        ? draft.amount.bbox
        : locateValue(lines, "amount", amount)?.bbox,
    ),
  };
}

/** How sure the rules must be of their OWN total before it may contradict the
 *  AI's. The assist mostly runs because the OCR garbled the total: on the
 *  owner's 30 AI reads every total corroboration flag fired on a rules total
 *  at 0.50–0.55 ("$2850" for $28.50, "9%09", a stray "0.94" line) and the AI
 *  was right all six times. 0.75 takes a cleanly read total line (label
 *  weight × OCR line confidence, rules/amount.ts): "TOTAL" read at OCR ≥ 88,
 *  "AMOUNT DUE" at ≥ 75. */
export const CORROBORATE_MIN_RULES_CONFIDENCE = 0.75;

/** Same for the date: 0.8 is an unambiguous read (0.9 when labeled). The
 *  0.65 tier — ambiguous m/d or a repaired year — is where the owner's AI
 *  dates were right and the rules wrong (a return-policy expiry, an OCR'd
 *  "06/11" for 08/11); a day/month swap is flagged at any confidence. */
export const CORROBORATE_MIN_RULES_DATE_CONFIDENCE = 0.8;
/** The OCR confidence (0..100) the rules date's line needs before it can
 *  contradict the AI: the owner's Lowe's date sat on a line read at 17 and
 *  a Home Depot misread "06/11" on one read at 8. */
export const CORROBORATE_MIN_DATE_LINE_CONFIDENCE = 50;

/** Same year, day and month exchanged: "2025-11-06" against "2025-06-11". */
function dayMonthSwapped(a: string, b: string): boolean {
  const [ya, ma, da] = a.split("-");
  const [yb, mb, db] = b.split("-");
  return a !== b && ya === yb && ma === db && da === mb;
}

/**
 * Flags for AI values the OCR contradicts. Values are never changed — the
 * human decides — but an AI value the OCR can't find, differing from a rules
 * read that is itself trustworthy, must not ship unreviewed: the same "never
 * silently swap a plausible total" rule the rules path obeys.
 *   • total: the rules total is a confident read
 *     (≥ CORROBORATE_MIN_RULES_CONFIDENCE) that the rules don't themselves
 *     question (no total_suspect/total_mismatch) — a weak one is usually the
 *     very garble that sent the receipt to the AI;
 *   • date: the rules date is a clean read — ≥ CORROBORATE_MIN_RULES_DATE_
 *     CONFIDENCE, not a last-resort pick (a policy expiry or due date, rank
 *     3 in `findDateEvidence`), on a line OCR read at ≥ CORROBORATE_MIN_DATE_
 *     LINE_CONFIDENCE — or, at any confidence, the AI date is the rules date
 *     with day and month swapped, the classic model error on an ambiguous
 *     m/d date.
 * Both are warns that force review (`extract.forcesManualReview`). The
 * message says which reader found what, never what the receipt "prints": the
 * on-device read can be the wrong one. No lines, no evidence either way —
 * nothing is flagged.
 */
export function corroborate(ai: Extraction, draft: Extraction, lines: OcrLine[]): Flag[] {
  if (lines.length === 0) return [];
  const flags: Flag[] = [];
  const a = ai.amount.value;
  const d = draft.amount.value;
  // A rules total the rules themselves question (footing's window recovery
  // stamps a synthetic confidence but flags it) is no evidence against the AI.
  const draftDoubtsTotal = draft.flags.some((f) => f.code === "total_suspect" || f.code === "total_mismatch");
  if (
    a > 0 &&
    d > 0 &&
    Math.abs(a - d) >= 0.005 &&
    draft.amount.confidence >= CORROBORATE_MIN_RULES_CONFIDENCE &&
    !draftDoubtsTotal &&
    !locateValue(lines, "amount", a)
  ) {
    flags.push({
      code: "total_suspect",
      severity: "warn",
      message: `The AI read ${formatMoney(a)}; the on-device reader found ${formatMoney(d)} — check the total.`,
    });
  }
  const aiDate = ai.date.value;
  const rulesDate = draft.date.value;
  if (aiDate && rulesDate && aiDate !== rulesDate) {
    const swapped = dayMonthSwapped(aiDate, rulesDate);
    // A clean rules date is not just its confidence: a last-resort pick (a
    // return-policy expiry, a due date — rank 3) keeps unlabeled confidence,
    // and an unambiguous misread on a garbled line reads 0.8 too. Both used
    // to flag a CORRECT AI date.
    const ev = findDateEvidence(lines);
    const cleanRulesDate =
      draft.date.confidence >= CORROBORATE_MIN_RULES_DATE_CONFIDENCE &&
      !!ev &&
      ev.field.value === rulesDate &&
      ev.rank < 3 &&
      ev.lineConfidence >= CORROBORATE_MIN_DATE_LINE_CONFIDENCE;
    if ((swapped || cleanRulesDate) && !locateValue(lines, "date", aiDate)) {
      flags.push({
        code: "date_suspect",
        severity: "warn",
        message: `The AI read ${aiDate}; the on-device reader found ${rulesDate} — ${swapped ? "check the day and month order" : "check the date"}.`,
      });
    }
  }
  return flags;
}

/**
 * The assist's extraction as the pipeline stores it: anchored on the OCR
 * lines, with corroboration flags FIRST (the card's banner shows the first
 * flag, and these are the reason for the review). Each step is best-effort —
 * the answer is already billed, so a throw keeps the bare answer rather than
 * discarding it (the same stance as logo fusion and the highlighter).
 */
export function settleAssistExtraction(ai: Extraction, draft: Extraction, lines: OcrLine[]): Extraction {
  let out = ai;
  try {
    out = anchorAssistBoxes(ai, draft, lines);
  } catch (err) {
    console.warn("[vision] couldn't anchor the AI read on the OCR lines.", err);
  }
  try {
    const flags = corroborate(out, draft, lines);
    // A corroboration flag supersedes the answer's own flag of the same code:
    // "the AI read 2024-03-26; the on-device reader found 2026-03-24" already
    // sends the reviewer to the date, with the likelier year beside it — the
    // age check's "more than two years old" (dateFlags) would only repeat it.
    const codes = new Set(flags.map((f) => f.code));
    if (flags.length) out = { ...out, flags: [...flags, ...out.flags.filter((f) => !codes.has(f.code))] };
  } catch (err) {
    console.warn("[vision] couldn't corroborate the AI read.", err);
  }
  return out;
}

// ── Provenance ───────────────────────────────────────────────────────────────

/** Where the endpoint's model runs, from its base URL — the URL itself is
 *  never recorded. Loopback is this device; RFC 1918, link-local, CGNAT
 *  (Tailscale-style 100.64/10), IPv6 unique-local/link-local, *.local /
 *  *.lan / *.internal / *.home.arpa and bare single-label names are the
 *  local network; anything else (or an unparseable URL) is the internet. */
export function assistHost(baseUrl: string): AssistProvenance["host"] {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "internet";
  }
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "::") {
    return "this-device";
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0) return "this-device";
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return "private-network";
    }
    return "internet";
  }
  if (host.includes(":")) {
    // IPv6: fc00::/7 unique-local, fe80::/10 link-local.
    return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)
      ? "private-network"
      : "internet";
  }
  if (!host.includes(".") || /\.(?:local|lan|internal|home\.arpa)$/.test(host)) {
    return "private-network";
  }
  return "internet";
}

/** Whose credential the call used — never the credential. The proxy's
 *  bearer is the account's session token; a cloud key equal to the build's
 *  free router key is that key (a user's own key always wins upstream,
 *  endpoint.cloudApiKey). `builtIn` is injectable for tests. */
export function assistKeySource(
  ep: Pick<Endpoint, "backend" | "apiKey" | "viaProxy">,
  builtIn: string = BUILTIN_OPENROUTER_KEY,
): AssistProvenance["keySource"] {
  if (ep.viaProxy) return "account";
  if (!ep.apiKey) return "none";
  if (ep.backend === "cloud" && builtIn && ep.apiKey === builtIn) return "builtin";
  return "own";
}

/** The rules read an assist replaced. Defensive: provenance must never be
 *  the reason a billed answer is discarded. */
function rulesSnapshot(draft: Extraction): AssistProvenance["rules"] {
  try {
    return {
      vendor: draft.vendor.value,
      date: draft.date.value,
      amount: draft.amount.value,
      tax: draft.tax.value,
      category: draft.category.value,
      confidence: draft.confidence,
    };
  } catch {
    return { vendor: "", date: "", amount: 0, tax: 0, category: "Other", confidence: 0 };
  }
}

export function assistProvenance(a: {
  endpoint: Pick<Endpoint, "backend" | "label" | "model" | "viaProxy" | "baseUrl" | "apiKey">;
  requested: Strategy;
  strategy: Strategy;
  result: Pick<VisionExtraction, "model" | "servedModel" | "calls" | "rawText">;
  draft: Extraction;
  builtIn?: string;
}): AssistProvenance {
  const { endpoint, result } = a;
  const served = result.servedModel?.trim();
  return {
    backend: endpoint.backend,
    provider: endpoint.label,
    model: result.model,
    ...(served && served !== result.model ? { servedModel: served } : {}),
    host: assistHost(endpoint.baseUrl),
    keySource: assistKeySource(endpoint, a.builtIn),
    requestedStrategy: a.requested,
    strategy: a.strategy,
    viaProxy: endpoint.viaProxy,
    calls: result.calls,
    rawAnswer: tailCap(String(result.rawText ?? "")),
    rules: rulesSnapshot(a.draft),
  };
}

/** The receipt's `methodDetail`, e.g. "Self-hosted · bonsai-27b · one-shot"
 *  or "OpenRouter · openrouter/free → qwen/…:free · one-shot (agentic
 *  requested) · via your account". The strategy is always named: absence
 *  no longer implies one-shot. */
export function assistMethodDetail(p: AssistProvenance): string {
  const model = p.servedModel ? `${p.model} → ${p.servedModel}` : p.model;
  const how =
    p.strategy === "agentic"
      ? `agentic, ${p.calls} call${p.calls === 1 ? "" : "s"}`
      : p.requestedStrategy === "agentic"
        ? "one-shot (agentic requested)"
        : "one-shot";
  return [p.provider, model, how, p.viaProxy ? "via your account" : ""].filter(Boolean).join(" · ");
}

// ── Rows stored before provenance existed ────────────────────────────────────

/** An AI read stored before `Receipt.assist` existed. Its `ocrText` is the
 *  MODEL'S answer: every successful assist overwrote it. */
export function isLegacyAiRead(r: Pick<Receipt, "methodUsed" | "assist">): boolean {
  return r.methodUsed === "paid" && !r.assist;
}

/** The old `methodDetail` shape, `[label, model, "agentic"?].join(" · ")`,
 *  read back into fields (one-shot was implied by the missing word). */
export function parseLegacyMethod(detail: string | undefined): {
  provider: string;
  model: string;
  strategy: Strategy;
} {
  const parts = (detail ?? "").split(" · ").map((s) => s.trim());
  return {
    provider: parts[0] ?? "",
    model: parts[1] ?? "",
    strategy: parts[2] === "agentic" ? "agentic" : "oneshot",
  };
}

export function ocrLinesText(lines?: OcrLine[]): string {
  return (lines ?? []).map((l) => l.text).join("\n");
}

function meanLineConfidence(lines: OcrLine[]): number {
  return lines.reduce((s, l) => s + (Number.isFinite(l.confidence) ? l.confidence : 0), 0) / lines.length;
}

/**
 * The OCR read an identical image (same hash) can lend, or null for a fresh
 * OCR pass. `confidence` is on the OCR engine's 0–100 scale.
 *   • A rules read lends its `ocrText` + lines (and, as before, its stored
 *     confidence ×100).
 *   • An AI read never lends its `ocrText`: before provenance existed every
 *     assist overwrote it with the model's answer, and an old-build tab can
 *     still do so next to a new `assist` record — re-parsed as printed text,
 *     the model's vendor looked like OCR evidence and the confidence jumped
 *     past the review line. Its text is rebuilt from the persisted lines
 *     (always the OCR read) with their mean confidence (the stored one is
 *     the model's); without lines it lends nothing.
 */
export function reusableOcr(
  r: Pick<Receipt, "ocrText" | "ocrLines" | "confidence" | "methodUsed">,
): { text: string; lines: OcrLine[]; confidence: number } | null {
  const lines = r.ocrLines ?? [];
  if (r.methodUsed === "paid") {
    if (lines.length === 0) return null;
    return { text: ocrLinesText(lines), lines, confidence: meanLineConfidence(lines) };
  }
  if (!r.ocrText) return null;
  return { text: r.ocrText, lines, confidence: r.confidence * 100 };
}
