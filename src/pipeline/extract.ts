import type {
  OcrResult,
  OcrLine,
  BBox,
  Category,
  Field,
  Flag,
} from "../types.ts";
import { parseAmount } from "../util/money.ts";
import { monthFromName, toIso, fromIso, daysBetween } from "../util/format.ts";
import { categorize } from "../config/categories.ts";
import {
  matchVendor,
  wordBoundaryMatcher,
  normalizeGlyphs,
  fuzzyMatchVendor,
  fuzzyMatchVendorLines,
  FUZZY_HINT_RATIO,
  GENERIC_ALIASES,
  type FuzzyVendorMatch,
  type VendorMatch,
} from "../config/vendors.ts";
import { CONFIDENCE, FLAGS, CURRENCY_DEFAULT } from "../config/constants.ts";

// Extract structured fields from OCR text with rules/heuristics (§5 step 3).
// Deterministic, free, portable. The goal isn't perfection — it's "right often
// enough that a quick human review fixes the rest in seconds" (§1). Every field
// carries its own confidence and the box it came from, to power the review UX.

export interface Extraction {
  vendor: Field<string>;
  date: Field<string>;
  amount: Field<number>;
  tax: Field<number>;
  currency: string;
  category: Field<Category>;
  confidence: number;
  flags: Flag[];
}

// A money token must look like money: a currency symbol, a decimal-cents part,
// or thousands grouping. Bare integers are excluded so dates/phone/quantities
// don't masquerade as amounts. The trailing lookaheads reject fragments of a
// longer number (e.g. "14.03" inside the date "14.03.2026").
//
// Grouping is deliberately strict: US grouping uses commas, and dot-grouping
// (EU) only counts WITH a comma-cents tail. A lone dot followed by 3 digits is
// NOT money — receipts are full of 3-decimal unit prices and quantities
// ("$3.499/gal", "11.204 GAL") that the old permissive grouped form read as
// $3,499 / $11,204 and then promoted to the receipt total.
const MONEY_SRC =
  "(?:[$£€¥]\\s?)?\\d{1,3}(?:,\\d{3})+(?:\\.\\d{2})?(?!\\d)" + // US grouped
  "|(?:[$£€¥]\\s?)?\\d{1,3}(?:\\.\\d{3})+,\\d{2}(?!\\d)" + //     EU grouped + cents
  "|(?:[$£€¥]\\s?)?\\d+[.,]\\d{2}(?![.,]?\\d)" + //               decimal cents
  "|[$£€¥]\\s?\\d+(?![\\d.,])"; //                                symbol + whole
const MONEY_RE = new RegExp(MONEY_SRC);
// Used only on lines we already know are labeled totals/taxes, so a whole-number
// amount ("TOTAL 9") is still picked up without risking false positives.
const LENIENT_MONEY_RE = /-?[$£€¥]?\s?\d[\d.,]*/g;
// A money token printed NEGATIVE on its own line: a leading "-" (either side
// of the currency symbol), an accounting "(12.00)", or a trailing "-" / "CR"
// (credit). Return/refund slips print their totals this way; the chosen
// amount keeps its magnitude and the sign only gates review. "TOTAL 12.00
// (2 items)", "CREDIT CARD" and a "03-14-26" date deliberately don't match.
const SIGNED_MONEY_RE =
  /(?:^|[\s:])(?:-\s?[$£€¥]?|[$£€¥]\s?-)\s?\d[\d,]*(?:[.,]\d{2})?(?![\d.,])|(?:^|[\s:])\(\s?[$£€¥]?\s?\d[\d,]*(?:[.,]\d{2})?\s?\)|\d[.,]\d{2}\s?(?:-(?!\w)|CR\b)/i;
// A line that names the transaction a refund/return — only meaningful on the
// total's own line ("REFUND TOTAL 12.00") or as a value echo ("REFUND TO AMEX
// 107.17"); a "RETURN POLICY" footer never flags anything.
const REFUND_LABEL_RE = /\b(refund|return|credit\s+memo|reversal)\b/i;
const REFUND_ECHO_RE = /\brefund\b/i;

export function looksLikeMoney(s: string): boolean {
  return MONEY_RE.test(s);
}

interface MoneyHit {
  value: number;
  bbox?: BBox;
}

/** Pull money tokens from a line, with precise word boxes where possible. */
function moneyHitsFromLine(line: OcrLine, lenient = false): MoneyHit[] {
  const hits: MoneyHit[] = [];
  const scan = new RegExp(MONEY_SRC, "g");
  for (const w of line.words) {
    if (!/\d/.test(w.text)) continue;
    scan.lastIndex = 0;
    const m = scan.exec(w.text);
    if (m) {
      // Parse the MATCHED substring, never the whole word — a qty@price token
      // like "2@19.28" tests as money but whole-word parsing glued the qty
      // digits onto the price ($219.28… and worse with an OCR-misread digit).
      const v = parseAmount(m[0]);
      if (v !== null) hits.push({ value: v, bbox: w.bbox });
    }
  }
  if (hits.length === 0) {
    // Words may be split oddly (or absent); scan the whole line text and
    // slice the line box to the match so markers stay tight.
    for (const m of line.text.matchAll(new RegExp(MONEY_SRC, "g"))) {
      const v = parseAmount(m[0]);
      if (v !== null) {
        const hit: MoneyHit = { value: v };
        const b = sliceBBox(line, m.index ?? 0, (m.index ?? 0) + m[0].length);
        if (b) hit.bbox = b;
        hits.push(hit);
      }
    }
  }
  if (hits.length === 0) {
    // OCR often injects a space around the decimal point ("USD$ 248. 81"),
    // splitting the money token — retry once on a space-collapsed copy.
    const collapsed = line.text
      .replace(/(\d)\s+([.,])\s*(\d{2})(?!\d)/g, "$1$2$3")
      .replace(/(\d)([.,])\s+(\d{2})(?!\d)/g, "$1$2$3");
    if (collapsed !== line.text) {
      for (const m of collapsed.matchAll(new RegExp(MONEY_SRC, "g"))) {
        const v = parseAmount(m[0]);
        if (v !== null) {
          const hit: MoneyHit = { value: v };
          const b = sliceBBox(line, m.index ?? 0, (m.index ?? 0) + m[0].length);
          if (b) hit.bbox = b;
          hits.push(hit);
        }
      }
    }
  }
  if (hits.length === 0 && lenient) {
    // Lenient pass (labeled-total lines only): a bare integer can be the value
    // ("TOTAL 9"), but blank date/time tokens (same-length, offsets preserved)
    // so "05/10/2026" or "14:03" can never be read as the total.
    const cleaned = line.text
      .replace(/\b\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b/g, (m) => " ".repeat(m.length))
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, (m) => " ".repeat(m.length));
    for (const m of cleaned.matchAll(LENIENT_MONEY_RE)) {
      const v = parseAmount(m[0]);
      if (v !== null) {
        const hit: MoneyHit = { value: v };
        const b = sliceBBox(line, m.index ?? 0, (m.index ?? 0) + m[0].length);
        if (b) hit.bbox = b;
        hits.push(hit);
      }
    }
  }
  return hits;
}

/** The right-most positive money value on a line — receipts right-align totals. */
function rightmostAmount(line: OcrLine, lenient = false): MoneyHit | null {
  const hits = moneyHitsFromLine(line, lenient).filter((h) => h.value >= 0);
  if (hits.length === 0) return null;
  return hits.reduce((best, h) =>
    (h.bbox?.x ?? 1) >= (best.bbox?.x ?? 0) ? h : best,
  );
}

const TOTAL_LABELS = [
  { re: /\b(grand\s*total|amount\s*due|balance\s*due|balance\s+to\s+pay|total\s*due|total\s*paid)\b/i, weight: 1.0 },
  { re: /\btotal\b/i, weight: 0.85 },
  // Gas pumps print "FUEL SALE $31.86" with no other total line; ranked below
  // a plain TOTAL so a combined fuel + car-wash TOTAL still wins.
  { re: /\bfuel\s+(?:total|sale)\b/i, weight: 0.8 },
];
const SUBTOTAL_RE = /\bsub[\s-]?total\b/i;
// A generic "total" line that is really something else — subtotal/tax/tender/
// change/savings/discount/points/item-count, or a PRE-discount subtotal
// variant ("MERCHANDISE TOTAL", "TOTAL BEFORE COUPONS", "ORIGINAL TOTAL")
// that department and drug stores print above the coupon line — is not the
// grand total. Adapted from the original app's _NON_GRAND_LINE_RE so these
// never win the amount (the largest value wins within a tier, so a
// pre-coupon total would otherwise beat the real one by the coupon amount).
const NON_GRAND_RE =
  /\b(sub[\s-]?total|tax|savings|discounts?|coupons?|merch(?:andise)?|before|original|tender(?:ed)?|tend|cash|change|points|rewards?|items?|qty|quantity|count)\b/i;
// Payment/tender lines whose money value can exceed the total (cash given, card
// charged). Excluded when finding the largest plausible amount so they don't
// masquerade as the grand total or trip the reconcile "larger amount" check.
const PAYMENT_RE =
  /\b(cash|change|tender(?:ed)?|tend|card|visa|master\s*card|mastercard|amex|american\s*express|debit|credit|approval|auth|points|rewards?)\b/i;
const TAX_RE = /\b(sales\s*tax|tax|vat|gst|hst|tps|tvq)\b/i;
// Registration/ID lines carry a tax KEYWORD but never a tax amount — "VAT No
// 123 4567 89" donated 89 to footing math, which then "corrected" a correct
// total. Tested against the label-folded text, like TAX_RE.
const TAX_ID_RE =
  /\b(?:sales\s*tax|tax|vat|gst|hst|tps|tvq)\b[\s:.#-]*(?:(?:id|no\.?|num(?:ber)?|reg(?:istration)?|invoice|exempt(?:ion)?|ein|abn|rn)\b|#)/i;
// Rate lines quote a percentage ("TAX RATE 8.25%"), not the tax amount.
const TAX_RATE_RE = /\brate\b/i;
// A printed "TOTAL TAX" line is the sum of the component tax lines by
// definition (STATE/COUNTY/CITY TAX above it).
const TOTAL_TAX_RE = /\b(total\s+tax(?:es)?|tax(?:es)?\s+total)\b/i;
/** A tax above this share of the subtotal is a garble (a decimal slip on the
 *  TAX line, or a misread SUBTOTAL), never a rate — footing math must not
 *  ADOPT subtotal + such a tax over the printed total. */
const TAX_MAX_RATIO = 0.5;

/** Smallest box covering every box given (undefined when none). */
function unionBBox(boxes: BBox[]): BBox | undefined {
  if (boxes.length === 0) return undefined;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Lines findAmount reads LENIENTLY — a labeled total whose generic label
 *  isn't disqualified by NON_GRAND_RE — so a bare integer ("TOTAL 9") counts.
 *  Post-hoc location (locateValue/readValueInBox) must accept exactly what
 *  extraction accepts, so they share this rule. */
function lenientTotalLine(text: string): boolean {
  const folded = labelFold(text);
  if (SUBTOTAL_RE.test(folded)) return false;
  const label = TOTAL_LABELS.find((l) => l.re.test(folded));
  return !!label && !(label.weight < 1 && NON_GRAND_RE.test(folded));
}

/** Fold digit-glyph OCR confusions for LABEL matching only ("T0TAL" → "total",
 *  "5UBTOTAL" → "subtotal"). Values are always parsed from the raw text. */
function labelFold(s: string): string {
  return s.toLowerCase().replace(/0/g, "o").replace(/1/g, "l").replace(/5/g, "s");
}

/** Proportional slice of a line's bbox for a substring match — keeps fallback
 *  markers tight to the value instead of spanning the full line. */
function sliceBBox(line: OcrLine, start: number, end: number): BBox | undefined {
  const b = line.bbox;
  if (!b || b.w <= 0) return b;
  const len = Math.max(1, line.text.length);
  const x = b.x + (b.w * Math.max(0, start)) / len;
  const w = Math.min((b.w * Math.max(1, end - start)) / len, b.x + b.w - x);
  return { x, y: b.y, w, h: b.h };
}
const DATE_LABEL_RE = /\b(date|invoice\s*date|order\s*date|transaction\s*date)\b/i;

/** True when a labeled-total line is just the label plus a value ("TOTAL 9",
 *  "Total Amount USD 9") — no other words that would make it a header/body
 *  line. `folded` is `labelFold(raw)` (same length, so the folded match's
 *  offsets slice the RAW text — the fold turns "10" into "lo", which would
 *  read as letters), `labelRe` already matched it. The lenient bare-integer
 *  read is for these lines only: a merchant header that merely contains the
 *  word ("TOTAL WINE & MORE #1234") must not donate its store number. */
function isLabelValueLine(raw: string, folded: string, labelRe: RegExp): boolean {
  const m = labelRe.exec(folded);
  if (!m || m.index === undefined) return false;
  const residue = raw.slice(0, m.index) + raw.slice(m.index + m[0].length);
  return !/[A-Za-z]{2,}/.test(residue.replace(/\b(?:usd|us|amount|due|paid)\b/gi, ""));
}

function findAmount(lines: OcrLine[]): {
  amount: Field<number> | null;
  subtotal: number | null;
  allMax: MoneyHit | null;
  /** The line the chosen total was read from (the label line, or the line
   *  below a label-only line); null on the largest-value fallback. */
  donor: OcrLine | null;
  /** The donor line printed the value with a negative sign (refund/return). */
  negative: boolean;
} {
  let best: { hit: MoneyHit; weight: number; conf: number; donor: OcrLine } | null = null;
  let subtotal: number | null = null;
  let allMax: MoneyHit | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const text = labelFold(line.text);

    // Track the largest money value anywhere (used for reconciliation), but
    // skip payment/tender lines whose value can exceed the actual total, and
    // per-gallon price lines — "PRICE/G: $4,599" (comma-for-dot OCR) parses
    // as thousands and would flag every pump receipt for review.
    if (
      !PAYMENT_RE.test(text) &&
      !FUEL_UNIT_RE.test(line.text) &&
      !FUEL_RATE_RE.test(line.text)
    ) {
      const energy = energyQuantities(line.text);
      for (const h of moneyHitsFromLine(line)) {
        if (energy.some((q) => Math.abs(q - h.value) < 0.005)) continue;
        if (!allMax || h.value > allMax.value) allMax = h;
      }
    }

    if (SUBTOTAL_RE.test(text)) {
      const h = rightmostAmount(line);
      if (h) subtotal = h.value;
      continue; // never treat subtotal as the grand total
    }

    for (const label of TOTAL_LABELS) {
      if (!label.re.test(text)) continue;
      // A generic "total" line that is really subtotal/tax/tender/change/savings/
      // discount/points/item-count is not the grand total — skip it.
      if (label.weight < 1 && NON_GRAND_RE.test(text)) break;
      // Amount may be on the same line or the next (label-only line). The
      // label line itself gets the lenient scan ("TOTAL 9"); the next line
      // must look strictly like money — it is arbitrary receipt text (a date,
      // "STORE 0442 REG 2", …) and a lenient grab there turned dates into
      // totals.
      let hit = rightmostAmount(line, isLabelValueLine(line.text, text, label.re));
      let donor: OcrLine = line;
      if (!hit && lines[i + 1]) {
        // …and never a tender/change/savings line — "TOTAL" ↵ "CASH 20.00"
        // shipped the cash given as the total.
        const next = labelFold(lines[i + 1]!.text);
        if (!NON_GRAND_RE.test(next) && !PAYMENT_RE.test(next)) {
          hit = rightmostAmount(lines[i + 1]!, false);
          donor = lines[i + 1]!;
        }
      }
      if (hit && hit.value > 0) {
        const conf = label.weight * (line.confidence / 100 || 0.7);
        // Within the same tier the LARGEST value wins (e.g. FUEL TOTAL vs the
        // combined TOTAL on a fuel + car-wash receipt) — ported from the
        // original app's extract_best_total.
        if (
          !best ||
          label.weight > best.weight ||
          (label.weight === best.weight && hit.value > best.hit.value)
        ) {
          best = { hit, weight: label.weight, conf, donor };
        }
      }
      break;
    }
  }

  if (best) {
    const field: Field<number> = {
      value: best.hit.value,
      confidence: Math.max(0.5, Math.min(0.97, best.conf)),
    };
    if (best.hit.bbox) field.bbox = best.hit.bbox;
    return {
      amount: field,
      subtotal,
      allMax,
      donor: best.donor,
      negative: SIGNED_MONEY_RE.test(best.donor.text),
    };
  }

  // No labeled total — fall back to the largest money value on the receipt.
  if (allMax && allMax.value > 0) {
    const field: Field<number> = { value: allMax.value, confidence: 0.5 };
    if (allMax.bbox) field.bbox = allMax.bbox;
    return { amount: field, subtotal, allMax, donor: null, negative: false };
  }
  return { amount: null, subtotal, allMax, donor: null, negative: false };
}

/** Percent-suffixed numbers on a line ("8.25%") — rates, never amounts. */
function percentValues(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d[\d.,]*)\s?%/g)) {
    const v = parseAmount(m[1]!);
    if (v !== null) out.push(v);
  }
  return out;
}

/** The receipt's tax. US receipts routinely print several component lines
 *  (STATE / COUNTY / CITY TAX) and often a "TOTAL TAX" sum; `subtotal` and
 *  `total` (the pre-footing pick) let the components be summed when the
 *  receipt's own arithmetic corroborates the sum. */
function findTax(
  lines: OcrLine[],
  subtotal: number | null = null,
  total: number | null = null,
): Field<number> | null {
  const hits: { field: Field<number>; isTotal: boolean }[] = [];
  for (const line of lines) {
    const folded = labelFold(line.text);
    if (TAX_RE.test(folded) && !SUBTOTAL_RE.test(folded)) {
      // ID/registration and rate lines carry the keyword but not the amount —
      // keep scanning; the real tax line may still follow.
      if (TAX_ID_RE.test(folded) || TAX_RATE_RE.test(folded)) continue;
      const hit = rightmostAmount(line, true);
      if (hit && hit.value >= 0) {
        // The chosen value is a percentage — a rate, not the amount.
        if (percentValues(line.text).some((v) => Math.abs(v - hit.value) < 0.005)) {
          continue;
        }
        const field: Field<number> = {
          value: hit.value,
          confidence: 0.8 * (line.confidence / 100 || 0.7),
        };
        if (hit.bbox) field.bbox = hit.bbox;
        hits.push({ field, isTotal: TOTAL_TAX_RE.test(folded) });
      }
    }
  }
  if (hits.length === 0) return null;
  // A printed TOTAL TAX line is the sum by definition (NON_GRAND_RE already
  // keeps it from being read as the grand total).
  const printedSum = hits.find((h) => h.isTotal);
  if (printedSum) return printedSum.field;
  // Several component lines and no printed sum: add them up ONLY when
  // total − subtotal corroborates the sum — never blindly, or a duplicated
  // customer/merchant copy would double the tax.
  if (hits.length >= 2 && subtotal !== null && total !== null) {
    const expected = Math.round((total - subtotal) * 100) / 100;
    const sum = Math.round(hits.reduce((s, h) => s + h.field.value, 0) * 100) / 100;
    const tol = Math.max(0.02, expected * 0.005);
    if (expected > 0 && Math.abs(sum - expected) <= tol) {
      const field: Field<number> = {
        value: sum,
        confidence: Math.min(...hits.map((h) => h.field.confidence)),
      };
      const box = unionBBox(hits.map((h) => h.field.bbox).filter((b): b is BBox => !!b));
      if (box) field.bbox = box;
      return field;
    }
  }
  return hits[0]!.field;
}

interface DateHit {
  iso: string;
  ambiguous: boolean;
  bbox?: BBox;
  labeled: boolean;
}

/** Repair digit-glyph confusions INSIDE numeric-date-shaped tokens only
 *  ("l2/O2/2@23" → "12/02/2023") — month names elsewhere stay untouched.
 *  B is ambiguous (a bold 8 or a broken 0: "B2/08/2023" is February); both
 *  folds are tried and the one that yields a plausible date wins. */
function fixDateGlyphs(t: string): string {
  const digitish = "[\\dOoQIlL|pPSBGZ@©®°]";
  const re = new RegExp(
    `(?<![A-Za-z\\d])${digitish}{1,4}[-/.]${digitish}{1,2}[-/.]${digitish}{2,4}(?![A-Za-z\\d])`,
    "g",
  );
  const fold = (tok: string, bAs: string): string =>
    tok
      .replace(/[OoQpP@©®°]/g, "0")
      .replace(/[IlL|]/g, "1")
      .replace(/Z/g, "2")
      .replace(/S/g, "5")
      .replace(/G/g, "6")
      .replace(/B/g, bAs);
  const plausible = (tok: string): boolean => {
    const m = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(tok);
    if (!m) return false;
    const [, a, b] = m as unknown as [string, string, string];
    // Either y-m-d (first segment a year) or m/d/y — segments must be sane.
    if (a.length === 4) return Number(b) >= 1 && Number(b) <= 12;
    return Number(a) >= 1 && Number(a) <= 12 && Number(b) >= 1 && Number(b) <= 31;
  };
  return t.replace(re, (tok) => {
    const as8 = fold(tok, "8");
    if (!tok.includes("B") || plausible(as8)) return as8;
    const as0 = fold(tok, "0");
    return plausible(as0) ? as0 : as8;
  });
}

function parseDatesInLine(line: OcrLine, labeled: boolean): DateHit[] {
  const out: DateHit[] = [];
  const t = fixDateGlyphs(line.text);
  const box = (m: RegExpMatchArray): BBox | undefined =>
    sliceBBox(line, m.index ?? 0, (m.index ?? 0) + m[0].length);

  // ISO yyyy-mm-dd
  for (const m of t.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) {
    pushNumeric(out, line, labeled, +m[1]!, +m[2]!, +m[3]!, "ymd", box(m));
  }
  // Numeric d/m/y or m/d/y
  for (const m of t.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/g)) {
    pushNumeric(out, line, labeled, +m[3]!, +m[1]!, +m[2]!, "mdy", box(m));
  }
  // Month name DD, YYYY — the comma may arrive with no space ("11,2024") or
  // read as a dot ("SEPTEMBER 11.2024"). The year must not be the hour of a
  // clock time: "TUE SEP 11 12:30 PM" read as 2012-09-11 (the ":" gave the
  // "12" a word boundary), hence the (?![:.]\d) lookahead on both forms.
  for (const m of t.matchAll(
    /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*[.,]\s*|\s+)(\d{2,4})\b(?![:.]\d)/g,
  )) {
    const mo = monthFromName(m[1]!);
    if (mo) addHit(out, line, labeled, +m[3]!, mo, +m[2]!, false, box(m));
  }
  // DD Month YYYY
  for (const m of t.matchAll(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?(?:\s*[.,]\s*|\s+)(\d{2,4})\b(?![:.]\d)/g,
  )) {
    const mo = monthFromName(m[2]!);
    if (mo) addHit(out, line, labeled, +m[3]!, mo, +m[1]!, false, box(m));
  }
  // ctime-style "Wed Sep 11 12:30:45 PDT 2024": the year sits after the time
  // (and an optional zone), out of reach of the forms above.
  for (const m of t.matchAll(
    /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?\s*(?:[A-Z]{2,5}\s+)?(\d{4})\b/g,
  )) {
    const mo = monthFromName(m[1]!);
    if (mo) addHit(out, line, labeled, +m[3]!, mo, +m[2]!, false, box(m));
  }
  return out;
}

function pushNumeric(
  out: DateHit[],
  line: OcrLine,
  labeled: boolean,
  year: number,
  a: number,
  b: number,
  order: "ymd" | "mdy",
  bbox?: BBox,
): void {
  let month: number, day: number, ambiguous = false;
  if (order === "ymd") {
    month = a;
    day = b;
  } else {
    // a=first field, b=second. Default US m/d; flip if impossible; ambiguous if both <=12.
    if (a > 12 && b <= 12) {
      month = b;
      day = a;
    } else if (b > 12 && a <= 12) {
      month = a;
      day = b;
    } else {
      month = a;
      day = b;
      ambiguous = a <= 12 && b <= 12 && a !== b;
    }
  }
  addHit(out, line, labeled, year, month, day, ambiguous, bbox);
}

function addHit(
  out: DateHit[],
  line: OcrLine,
  labeled: boolean,
  yearRaw: number,
  month: number,
  day: number,
  ambiguous: boolean,
  bbox?: BBox,
): void {
  let year = yearRaw;
  if (year < 100) year += 2000;
  // "2823" is a misread "2023" (0→8 is a common thermal-print confusion);
  // recover any 2xxx year whose last two digits form a plausible 20xx date.
  if (year > 2100 && year < 3000 && 2000 + (year % 100) <= 2100) {
    year = 2000 + (year % 100);
    ambiguous = true;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return;
  if (year < 2000 || year > 2100) return;
  const d = new Date(year, month - 1, day);
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return; // real date?
  const hit: DateHit = { iso: toIso(d), ambiguous, labeled };
  const b = bbox ?? line.bbox;
  if (b) hit.bbox = b;
  out.push(hit);
}

// A supplier invoice prints the payment deadline ("Due Date", Net 30) near the
// top — often ABOVE "Invoice Date" — and a first-labeled-line-wins pick shipped
// the deadline as the expense date (wrong MM-DD-YY file name, wrong Expense
// Period). Rank: a transaction-naming label first, then a bare "Date", then
// unlabeled dates, and only then a deadline/expiry/shipping label (kept as a
// last resort so a due-date-only stub still gets dated).
const DATE_STRONG_RE =
  /\b(invoice|order|transaction|sales?|receipt|purchase|service)\s*date\b/i;
const DATE_DEMOTE_RE =
  /\b(due|expir\w*|valid|ship\w*|deliver\w*|pay(?:ment)?\s*due)\s*date\b|\bdate\s+due\b/i;

function dateLabelRank(text: string): number {
  if (DATE_STRONG_RE.test(text)) return 0;
  if (DATE_DEMOTE_RE.test(text)) return 3;
  if (DATE_LABEL_RE.test(text)) return 1;
  return 2;
}

function findDate(lines: OcrLine[]): Field<string> | null {
  let best: { hit: DateHit; rank: number } | null = null;
  for (const line of lines) {
    const rank = dateLabelRank(line.text);
    // Strict "<" keeps line order as the tie-break within a rank; a demoted
    // last-resort hit carries unlabeled confidence rather than 0.9.
    for (const hit of parseDatesInLine(line, rank <= 1)) {
      if (!best || rank < best.rank) best = { hit, rank };
    }
  }
  const chosen = best?.hit;
  if (!chosen) return null;
  const field: Field<string> = {
    value: chosen.iso,
    confidence: chosen.labeled ? 0.9 : chosen.ambiguous ? 0.65 : 0.8,
  };
  if (chosen.bbox) field.bbox = chosen.bbox;
  return field;
}

// "blv\w{0,2}" instead of "blvd": OCR regularly misreads the suffix ("Blvg",
// "Blvo") and the address line then won a vendor slot.
const ADDRESS_RE =
  /\b(street|st\.?|ave|avenue|road|rd\.?|blv\w{0,2}|boulevard|suite|ste|floor|fl\.?|drive|dr\.?|lane|ln\.?|way|hwy|p\.?o\.?\s*box)\b/i;
// Politeness/boilerplate lines that often sit above the real merchant name.
const GREETING_RE =
  /^\s*(welcome(\s+to)?|thank\s*(you|s)|have\s+a\s+nice|greetings|hello)\b/i;
// A "City ST" line (the zip often sits on the NEXT line, dodging the
// state+zip guard) — "Anaheim CA" is an address, not a merchant. But merchant
// names also end in state-shaped words ("SMITH SUPPLY CO", "GRILL IN LA"), so
// only a comma'd form ("Santa Fe, NM") or a bare two-word "City ST" rejects.
const US_STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
const CITY_STATE_RE = new RegExp(`,\\s*(?:${US_STATES})\\.?\\s*$`);
const CITY_STATE_BARE_RE = new RegExp(
  `^\\s*[A-Z][A-Za-z.'-]+\\s+(?:${US_STATES})\\.?\\s*$`,
);
const PHONE_RE = /(\+?\d[\d\s().-]{6,}\d)/;
// "Springfield, IL 62704" — a US state abbreviation followed by a ZIP code.
const STATE_ZIP_RE = /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/;
// "123 Main St", "1700 W 7th Ave" — a leading street number plus a street word.
const STREET_NUMBER_RE = /^\s*\d{1,6}\s+\w/;
// A short line ending in a state abbreviation ("SANTA ANA CA") — deliberately
// NOT a reject on its own (see CITY_STATE_BARE_RE above); it only rejects
// when its neighbours prove it sits inside an address block.
const STATE_TAIL_RE = new RegExp(`\\s(?:${US_STATES})\\.?\\s*$`);
const BARE_ZIP_RE = /^\s*\d{5}(?:-\d{4})?\s*$/;
// Leading words a vendor correction may start with that must never be the
// probe on their own ("The" would land on "OTHER STORE").
const VENDOR_STOPWORD_RE = /^(the|a|an|and|of|at|el|la|le|los|las)$/;
// Tender lines ("PAID WITH GOOGLE PAY", "VISA APPROVED") out-scored short
// real names on letter count once the brand word inside them stopped
// matching — never the merchant.
const VENDOR_TENDER_RE =
  /\b(?:paid|payment|tender(?:ed)?|approved|approval|auth(?:orization)?|change\s+due|visa|master\s*card|amex|american\s*express|discover|debit|credit\s+card)\b/i;
// A timestamp line ("TUE SEP 11 12:30 PM", "Wed Sep 11 12:30:45 PDT 2024"):
// year-less forms dodge the date parser, but a weekday + month + day or a
// clock time never names a shop.
const TIMESTAMP_LINE_RE =
  /\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?(?=\s|$)/i;
// A fuel-grade line with a number ("SUPER 93 OCTANE", "REGULAR 87") is pump
// data, and out-scored "JOE'S GAS" for the vendor slot.
const FUEL_GRADE_RE = /\b(?:super|regular|premium|mid-?grade|unleaded|diesel|octane)\b/i;

function looksLikeVendorLine(line: OcrLine, prev?: OcrLine, next?: OcrLine): boolean {
  const t = line.text.trim();
  if (t.length < 3) return false;
  const letters = (t.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 3) return false;
  if (letters / t.length < 0.4) return false; // mostly symbols/digits
  // A line carrying a money value is an item/total line, never the merchant
  // name — taking it fabricated vendors like "Wiper blades 34.99".
  if (MONEY_RE.test(t)) return false;
  if (DATE_LABEL_RE.test(t)) return false;
  // A line that IS a date ("WED SEPTEMBER 11, 2024 12:30 PM") is never the
  // merchant — restaurant slips print it right under a logo OCR can't read,
  // and its letter count out-scored real names in findVendor.
  if (parseDatesInLine(line, false).length > 0) return false;
  if (PHONE_RE.test(t) && letters < 6) return false;
  if (STATE_ZIP_RE.test(t)) return false; // "..., IL 62704"
  if (STREET_NUMBER_RE.test(t) && ADDRESS_RE.test(t)) return false; // "123 Main St"
  if (ADDRESS_RE.test(t)) return false;
  if (/^(receipt|invoice|order|tel|phone|fax|www\.|http)/i.test(t)) return false;
  // "WELCOME TO" / "THANK YOU" headers are not the merchant — the name is
  // usually the line below.
  if (GREETING_RE.test(t)) return false;
  // "Anaheim CA" / "Santa Fe, NM" — a city/state line from the address block.
  if (t.split(/\s+/).length <= 4 && CITY_STATE_RE.test(t)) return false;
  if (CITY_STATE_BARE_RE.test(t)) return false;
  // "SANTA ANA CA" / "LOS ANGELES CA" — a multi-word city can't be told from
  // "SMITH SUPPLY CO" by shape alone, so it only rejects when it sits INSIDE
  // an address block: a street line above it or a bare ZIP below it.
  if (t.split(/\s+/).length <= 4 && STATE_TAIL_RE.test(t)) {
    const p = prev?.text.trim() ?? "";
    const n = next?.text.trim() ?? "";
    if ((STREET_NUMBER_RE.test(p) && ADDRESS_RE.test(p)) || BARE_ZIP_RE.test(n)) return false;
  }
  // Register boilerplate ("STORE #4821", "REG 2", "TRANS 0071") is not a
  // merchant name — a numbered store/register/transaction line must not win.
  if (/^(store|reg(?:ister)?|lane|till|terminal|cashier|clerk|trans(?:action)?)\b[\s#:.]*\d/i.test(t)) {
    return false;
  }
  // Loyalty/account boilerplate ("REWARDS MEMBER #1234") is longer than the
  // real name above it and out-scored "JOES DINER".
  if (/^(?:rewards?|member(?:ship)?|loyalty|customer|acct|account)\b[\s#:.\w]*\d/i.test(t)) {
    return false;
  }
  // Tender, staff and social-footer lines are never the merchant.
  if (VENDOR_TENDER_RE.test(t) || STAFF_LINE_RE.test(t) || SOCIAL_FOOTER_RE.test(t)) return false;
  if (TIMESTAMP_LINE_RE.test(t)) return false;
  // Pump/quantity data ("GALLONS: 6.927", "PRICE/GAL 4.599", "PUMP# 01")
  // dodges the money-line reject (3-decimal quantities aren't strict money)
  // but its letter count out-scored short real names like "nob" for the
  // vendor slot. Only pump-SHAPED data rejects — a merchant header with a
  // store number ("PRICE CHOPPER #123") must survive.
  if (
    QTY_AFTER_RE.test(t) ||
    QTY_BEFORE_RE.test(t) ||
    FUEL_UNIT_RE.test(t) ||
    FUEL_RATE_RE.test(t) ||
    /\b(?:pump|grade|octane|unleaded|diesel|gallons?|litres?|liters?)\b[\s#:=.]*\d/i.test(t) ||
    (FUEL_GRADE_RE.test(t) && /\d/.test(t)) ||
    // The charging equivalent: "ENERGY 42.31 kWh", "42.31 kWh @ $0.36".
    ENERGY_QTY_RE.test(t)
  ) {
    return false;
  }
  return true;
}

// ── Brand-scan scoping ───────────────────────────────────────────────────────
// Many single-word brand aliases are ordinary words, surnames and US place
// names ("shell", "hilton", "napa", "google"); scanned over the WHOLE receipt
// they fire on addresses ("6000 GULF BLVD"), tender lines ("GOOGLE PAY"),
// footers ("REVIEW US ON GOOGLE"), staff lines ("YOUR SERVER WAS CASEY") and
// item lines ("HARD SHELL TACO 3.50"). Generic aliases (GENERIC_ALIASES)
// therefore only count on header lines that are none of those; distinctive
// aliases and slogans keep the whole-text scan.
const SOCIAL_FOOTER_RE =
  /\b(?:review|rate|find|follow|visit|like)\s+us\b|\bmaps\b|\b(?:google|apple|samsung)\s+pay\b/i;
const STAFF_LINE_RE = /\b(?:server|cashier|clerk|served\s+by)\b/i;
const TENDER_WORD_RE = /\b(?:pay|paid)\b/i;
// A restaurant-shaped line ("ADOBE GRILL", "MURPHY'S PUB") names an eatery,
// not the software/fuel brand that shares its first word.
const EATERY_RE =
  /\b(?:grill|pub|cafe|café|bistro|diner|restaurant|bar|bakery|pizza|pizzeria|tavern|kitchen|deli|eatery|cantina|taqueria)\b/i;

/** A line no GENERIC brand alias should be trusted on: address/city/ZIP,
 *  money/item, tender, social-footer or staff lines. */
function brandHostileLine(text: string): boolean {
  const t = text.trim();
  return (
    STATE_ZIP_RE.test(t) ||
    ADDRESS_RE.test(t) ||
    (t.split(/\s+/).length <= 4 && CITY_STATE_RE.test(t)) ||
    CITY_STATE_BARE_RE.test(t) ||
    MONEY_RE.test(t) ||
    PAYMENT_RE.test(t) ||
    TENDER_WORD_RE.test(t) ||
    SOCIAL_FOOTER_RE.test(t) ||
    STAFF_LINE_RE.test(t)
  );
}

/** Header lines a generic alias may be read from. */
function brandHeaderLines(lines: OcrLine[]): OcrLine[] {
  return lines.slice(0, 8).filter((l) => !brandHostileLine(l.text));
}

/** Header lines the fuzzy sweep may read: merchant-shaped (the vendor-line
 *  rejects — money, address, city/state, date, pump data), not brand-hostile,
 *  and not an eatery name — a restaurant's first word must never be edited
 *  into a lookalike brand ("ADOBE GRILL" is not Adobe). */
function fuzzyHeaderLines(lines: OcrLine[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length && i < 8 && out.length < 6; i++) {
    const l = lines[i]!;
    if (!looksLikeVendorLine(l, lines[i - 1], lines[i + 1])) continue;
    if (brandHostileLine(l.text) || EATERY_RE.test(l.text)) continue;
    out.push(l.text);
  }
  return out;
}

/** The brand scan (`matchVendor`) with generic aliases scoped to trustworthy
 *  header lines. A distinctive alias or slogan anywhere on the receipt still
 *  names the brand; a generic one must sit on a non-address/item/tender header
 *  line, and never on an eatery-named line for a non-Meals brand. */
export function matchKnownVendor(lines: OcrLine[], text: string): VendorMatch | null {
  const whole = matchVendor(text);
  if (whole && !GENERIC_ALIASES.has(whole.alias)) return whole;
  // The whole-text winner is a generic word (or nothing): re-run over the
  // header lines a generic alias may legitimately come from.
  const header = brandHeaderLines(lines);
  const hit = matchVendor(header.map((l) => l.text).join("\n"));
  if (!hit) return null;
  if (!GENERIC_ALIASES.has(hit.alias)) return hit;
  const re = wordBoundaryMatcher(hit.alias);
  const host = header.find((l) => re.test(l.text.toLowerCase()));
  if (host && hit.category !== "Meals" && EATERY_RE.test(host.text)) return null;
  return hit;
}

/** Find the bbox of the first line containing a known-vendor alias, so the
 *  review UI can still draw an on-image marker for a brand-matched vendor. */
function lineBBoxForAlias(lines: OcrLine[], alias: string): BBox | undefined {
  return findAliasOnLines(lines, alias)?.bbox;
}

/** Locate a brand alias (or a vendor probe) on the OCR lines the way the brand
 *  matcher does — word-bounded, then glyph-folded — so the review marker and
 *  the correction locator can't drift apart. */
function findAliasOnLines(
  lines: OcrLine[],
  alias: string,
): { bbox: BBox; lineText: string } | undefined {
  const re = wordBoundaryMatcher(alias);
  for (const line of lines) {
    const m = re.exec(line.text.toLowerCase());
    if (m) {
      return {
        bbox: sliceBBox(line, m.index, m.index + alias.length) ?? line.bbox,
        lineText: line.text,
      };
    }
  }
  // Glyph fallback: the alias may only surface after OCR-confusion folding
  // (e.g. the line reads "7-ELEUEN" but the alias is "7-eleven").
  const normAlias = normalizeGlyphs(alias);
  if (normAlias) {
    const nre = wordBoundaryMatcher(normAlias);
    for (const line of lines) {
      if (nre.test(normalizeGlyphs(line.text))) return { bbox: line.bbox, lineText: line.text };
    }
  }
  return undefined;
}

function findVendor(lines: OcrLine[]): Field<string> | null {
  const top = lines.slice(0, 6);
  // Best candidate: among the top lines, the earliest qualifying line, biased
  // toward the one with the most letters (merchant names are prominent).
  let best: { line: OcrLine; score: number } | null = null;
  top.forEach((line, i) => {
    // Neighbours come from the full list so line 6 still sees its real
    // successor (a bare ZIP below a city line).
    if (!looksLikeVendorLine(line, lines[i - 1], lines[i + 1])) return;
    const letters = (line.text.match(/[A-Za-z]/g) ?? []).length;
    const positionBonus = (6 - i) * 2; // earlier is better
    const score = letters + positionBonus + (line.confidence || 50) / 25;
    if (!best || score > best.score) best = { line, score };
  });
  if (!best) return null;
  const b = best as { line: OcrLine; score: number };
  const name = cleanVendorName(b.line.text);
  if (!name) return null;
  const field: Field<string> = {
    value: name,
    confidence: Math.max(0.45, Math.min(0.9, (b.line.confidence || 60) / 100)),
  };
  if (b.line.bbox) field.bbox = b.line.bbox;
  return field;
}

function cleanVendorName(raw: string): string {
  return raw
    // "PRICE CHOPPER #123", "STORE #0442", "STR # 12" — a trailing hash-number
    // is the store/register id, never part of the name (it made every branch
    // a different vendor in the Summary). Bare digits ("STUDIO 54") are left
    // alone on purpose.
    .replace(/\s*(?:\b(?:store|str|no)\.?\s*)?#\s*\d{1,6}\s*$/i, "")
    .replace(/[*#|_]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.&'-]+$/g, "")
    .trim()
    .slice(0, 60);
}

// ── Pump-math reconciliation ─────────────────────────────────────────────────
// Fuel receipts print GALLONS and PRICE/GAL alongside the total, so the total
// is *checkable*: gallons × price ≈ total (pumps round to the cent). This is a
// deterministic ground truth OCR misreads can't fake — a garbled "$3,188.00"
// against 6.927 gal × $4.599 is caught immediately.

// The slash class is REQUIRED in the "price/g" form — OCR reads the slash as
// Z/7/l/1/\ ("PRICEZG"), but an *optional* slash let "PRICE GOOD THRU 7.15"
// pass as a per-gallon price and corrupt a correct total.
const FUEL_UNIT_RE =
  /(?:price\s*[\/z7l1\\]\s*g(?:al(?:lon)?)?\b|(?:price\s+)?per\s+gal(?:lon)?|\$\s*\/\s*g)/i;
// Loyalty/discount lines quote per-gallon RATES ("DISCOUNT 1.00/GAL", "FUEL
// SAVINGS EARNED 1.00 PER GALLON") — never pump quantities or prices.
const FUEL_PROMO_RE =
  /\b(discount|save[ds]?|savings?|rewards?|earned|redeem\w*|loyalty|off)\b/i;
// The gallons count must sit adjacent to its keyword. The keyword must LEAD
// the line in the after form ("GALLONS: 6.927"), so item lines like
// "MILK 1 GAL 4.99" can't donate their price as a quantity; the before form
// is the pump's own "11.204 GAL".
const QTY_AFTER_RE =
  /^[^A-Za-z0-9]*(?:fuel\s+|unleaded\s+|diesel\s+)?(?:gallons?|gal|litres?|liters?)\b[\s:.#=]*(\d+\.\d{1,3})/i;
const QTY_BEFORE_RE = /(\d+\.\d{1,3})\s*(?:gallons?|gal|litres?|liters?)\b/i;
// A keyword-less per-gallon rate ("UNL $4.599/GAL", comma-misread "$4,599/GAL"):
// money-or-3-decimal token right before the (possibly glyph-garbled) /GAL.
const FUEL_RATE_RE = /\d[.,]\d{2,3}\s*[\/z7l1\\]\s*g(?:al(?:lon)?)?\b/i;
const PLAIN_NUM_RE = /\d+\.\d{1,3}/g;

// EV charging is the electric pump, and its quantity line is the one that
// misleads: a session prints its ENERGY in kWh ("42.31 kWh") right next to a
// much smaller dollar total ($15.23). That quantity parses as strict money,
// so left alone it becomes reconcile's "a larger amount appears above the
// total" — a warn that forces *every* charging receipt into manual review.
// Only the kWh QUANTITY is dropped, never the whole line: a session line can
// carry the charge itself ("42.31 kWh    $15.23").
const ENERGY_QTY_SRC = String.raw`(\d+(?:[.,]\d{1,3})?)\s*k\s*w\s*h\b`;
const ENERGY_QTY_RE = new RegExp(ENERGY_QTY_SRC, "i");

/** The kWh quantities printed on a line, for exclusion from the money scan. */
function energyQuantities(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(new RegExp(ENERGY_QTY_SRC, "gi"))) {
    const v = parseAmount((m[1] ?? "").replace(",", "."));
    if (v !== null) out.push(v);
  }
  return out;
}

/** gallons × price/gal from the printed pump lines, or null. */
function pumpMathTotal(lines: OcrLine[]): number | null {
  let qty: number | null = null;
  let unit: number | null = null;
  for (const line of lines) {
    if (FUEL_PROMO_RE.test(line.text)) continue;
    const isUnitLine = FUEL_UNIT_RE.test(line.text) || FUEL_RATE_RE.test(line.text);
    if (qty === null && !isUnitLine) {
      const m = QTY_AFTER_RE.exec(line.text) ?? QTY_BEFORE_RE.exec(line.text);
      const v = m ? Number(m[1]) : NaN;
      if (v > 0 && v < 300) qty = v;
    } else if (unit === null && isUnitLine) {
      const nums = (line.text.match(PLAIN_NUM_RE) ?? []).map(Number);
      const v = nums.filter((n) => n > 0.5 && n < 20);
      if (v.length) unit = v[v.length - 1]!;
    }
  }
  if (qty === null || unit === null) return null;
  const product = Math.round(qty * unit * 100) / 100;
  return product >= 1 && product <= 2000 ? product : null;
}

/** How many money hits across the receipt sit within `tol` of `value`. */
function countHitsNear(lines: OcrLine[], value: number, tol: number): number {
  let n = 0;
  for (const line of lines) {
    for (const h of moneyHitsFromLine(line)) {
      if (Math.abs(h.value - value) <= tol) n++;
    }
  }
  return n;
}

/** Closest money hit to `value` within `tol` (non-payment lines preferred).
 *  Whether the winning hit sits on a payment/tender line is reported — a
 *  tender equal to the pump product means the charge WAS fuel-only, which
 *  reads very differently from a printed FUEL TOTAL sub-line. */
function findHitByValue(
  lines: OcrLine[],
  value: number,
  tol: number,
): (MoneyHit & { payment: boolean }) | null {
  let best: { hit: MoneyHit; diff: number; payment: boolean } | null = null;
  for (const line of lines) {
    const payment = PAYMENT_RE.test(line.text);
    for (const h of moneyHitsFromLine(line)) {
      const diff = Math.abs(h.value - value);
      if (diff > tol) continue;
      if (
        !best ||
        (best.payment && !payment) ||
        (best.payment === payment && diff < best.diff)
      ) {
        best = { hit: h, diff, payment };
      }
    }
  }
  return best ? { ...best.hit, payment: best.payment } : null;
}

/** Cross-check/correct the amount with pump math. Returns flags plus whether
 *  the amount now agrees with gallons × price (which silences the noisy
 *  larger-amount reconcile warning — the math is stronger evidence). */
function applyPumpMath(
  lines: OcrLine[],
  amount: Field<number> | null,
): { amount: Field<number> | null; verified: boolean; isPump: boolean; flags: Flag[] } {
  const expected = pumpMathTotal(lines);
  if (expected === null) {
    // The math needs both gallons and a unit price; a per-gallon price line
    // alone still proves fuel STRUCTURE ("GALLONS: 18153" loses its decimal
    // to OCR, but the receipt is definitionally a pump receipt).
    const fuelStructure = lines.some(
      (l) =>
        !FUEL_PROMO_RE.test(l.text) &&
        (FUEL_UNIT_RE.test(l.text) || FUEL_RATE_RE.test(l.text)),
    );
    return { amount, verified: false, isPump: fuelStructure, flags: [] };
  }
  const tol = 0.05;

  if (amount && Math.abs(amount.value - expected) <= tol) {
    // The printed total foots with the pump math — highest confidence.
    return {
      amount: { ...amount, confidence: Math.max(amount.confidence, 0.95) },
      verified: true,
      isPump: true,
      flags: [],
    };
  }

  // The chosen amount disagrees with gallons × price/gal. The product only
  // covers the FUEL portion of the receipt, so a larger printed total is
  // often legitimate (fuel + car wash / store items) — decide by how the
  // receipt's own numbers corroborate each side rather than assuming the
  // printed total is the misread one.
  const anchor = findHitByValue(lines, expected, tol); // the printed fuel-only value
  if (amount) {
    const ratio = amount.value / expected;
    const suspect: Flag = {
      code: "total_suspect",
      severity: "warn",
      message: `Total ${amount.value.toFixed(2)} doesn't match gallons × price/gal (≈ ${expected.toFixed(2)}) — needs review.`,
    };
    // A vanished decimal point multiplies by exactly ×10/×100 — and it
    // vanishes on EVERY line printing that value (same faint dot), so a
    // tender-line echo can't vouch for a slip-scale total.
    const decimalSlip = [10, 100, 1000, 0.1, 0.01].some(
      (k) => Math.abs(ratio - k) / k <= 0.03,
    );
    if (decimalSlip) {
      // …but a printed fuel-only line (non-payment anchor) under a larger
      // total is real fuel+extras evidence: a $100 total over a $10 FUEL
      // TOTAL is indistinguishable from a ×10 slip — a human decides.
      if (anchor && !anchor.payment && amount.value > expected) {
        return { amount, verified: false, isPump: true, flags: [suspect] };
      }
      // Uncorroborated slip: the garbled-total class this net exists for —
      // fall through and correct.
    } else {
      // Another line echoing the chosen total (the tender line usually does)
      // means two independent reads agree — the computed product loses.
      if (countHitsNear(lines, amount.value, tol) >= 2) {
        return { amount, verified: false, isPump: true, flags: [] };
      }
      if (anchor?.payment) {
        // The tender equals the pump product: the charge WAS the fuel-only
        // value and the larger "total" is the misread — fall through and
        // correct toward the printed tender.
      } else if (amount.value > expected && anchor && ratio < 2) {
        // The fuel-only value is printed elsewhere (FUEL TOTAL) and the total
        // is plausibly fuel + extras — keep the larger combined total.
        return { amount, verified: false, isPump: true, flags: [] };
      } else {
        // Unexplained disagreement: never silently swap in either direction
        // (the gallons digits are misread as often as the total) — keep the
        // printed total and demand a human look.
        return { amount, verified: false, isPump: true, flags: [suspect] };
      }
    }
  }

  // Prefer a printed money value that matches the product (keeps an on-image
  // box); else adopt the computed product.
  const corrected: Field<number> = anchor
    ? { value: anchor.value, confidence: 0.92, ...(anchor.bbox ? { bbox: anchor.bbox } : {}) }
    : { value: expected, confidence: 0.85 };
  const note = amount
    ? `Amount corrected: ${amount.value.toFixed(2)} didn't match gallons × price/gal (≈ ${expected.toFixed(2)}).`
    : `Amount taken from gallons × price/gal (≈ ${expected.toFixed(2)}).`;
  return {
    amount: corrected,
    verified: true,
    isPump: true,
    flags: [{ code: "total_mismatch", severity: "info", message: note }],
  };
}

/** Correct the amount with the receipt's own footing: when SUBTOTAL + TAX are
 *  printed and some OTHER printed money value equals their sum, that sum is
 *  the grand total — an OCR-garbled "total" (e.g. "2@19.28" read as a
 *  plausible-looking $2,819.28) loses to arithmetic the receipt itself
 *  provides. Only ever corrects TO a printed value, mirroring the original
 *  app's reconcile_amount. */
const TIP_RE = /\b(tip|gratuity)\b/i;
// Lines that legitimately pull the grand total BELOW the printed subtotal.
const DISCOUNT_RE =
  /\b(discount|coupon|savings?|saved|promo(?:tion)?|markdown|rebate|voucher|gift\s*card)\b/i;

function applyFootingMath(
  lines: OcrLine[],
  amount: Field<number> | null,
  subtotal: number | null,
  tax: Field<number> | null,
): { amount: Field<number> | null; flags: Flag[] } {
  if (!amount || subtotal === null) return { amount, flags: [] };

  // A tip/gratuity line legitimately lifts the grand total above SUBTOTAL +
  // TAX — footing must widen its expectations instead of "correcting" the
  // tip away (a verified silent under-reimbursement).
  const tipPresent = lines.some((l) => TIP_RE.test(l.text));

  // Without a readable tax line, fall back to a WINDOW check: the grand total
  // sits in [subtotal, subtotal × 1.35] (× 2 when a tip line is printed). An
  // amount far outside it (the glued "2@19.28" → $2,819 class) is replaced by
  // the largest printed money value inside the window from a
  // non-subtotal/tax/payment line.
  if (!tax || tax.value <= 0) {
    const lo = subtotal - 0.01;
    const hi = subtotal * (tipPresent ? 2 : 1.35) + 0.5;
    if (amount.value >= lo && amount.value <= hi) return { amount, flags: [] };
    if (tipPresent) {
      // A tip makes the total unverifiable from the subtotal alone — never
      // "correct" it (the tip line's own value would win the window), just
      // demand a human look.
      return {
        amount,
        flags: [
          {
            code: "total_suspect",
            severity: "warn",
            message: `Total ${amount.value.toFixed(2)} can't be verified against subtotal ${subtotal.toFixed(2)} with a tip printed — needs review.`,
          },
        ],
      };
    }
    let bestInWindow: MoneyHit | null = null;
    for (const line of lines) {
      const folded = labelFold(line.text);
      if (SUBTOTAL_RE.test(folded) || TAX_RE.test(folded) || PAYMENT_RE.test(folded)) continue;
      if (TIP_RE.test(line.text)) continue;
      for (const h of moneyHitsFromLine(line)) {
        if (h.value < lo || h.value > hi) continue;
        if (!bestInWindow || h.value > bestInWindow.value) bestInWindow = h;
      }
    }
    if (!bestInWindow) return { amount, flags: [] };
    // The window's floor is the subtotal itself, so on a single-item receipt
    // the item price "recovers" a garbled total with the tax dropped — that
    // is a plausible but unverified value, so it gates review; a recovery
    // ABOVE the subtotal is the usual tax-inclusive total and stays advisory.
    const taxless = bestInWindow.value <= subtotal + 0.01;
    return {
      amount: {
        value: bestInWindow.value,
        confidence: 0.9,
        ...(bestInWindow.bbox ? { bbox: bestInWindow.bbox } : {}),
      },
      flags: [
        taxless
          ? {
              code: "total_suspect",
              severity: "warn",
              message: `Total ${amount.value.toFixed(2)} is far outside subtotal (${subtotal.toFixed(2)}); took ${bestInWindow.value.toFixed(2)}, which equals the subtotal — no tax recovered, needs review.`,
            }
          : {
              code: "total_mismatch",
              severity: "info",
              message: `Amount corrected: ${amount.value.toFixed(2)} is far outside subtotal (${subtotal.toFixed(2)}) — took the largest printed value in the subtotal window.`,
            },
      ],
    };
  }

  const expected = Math.round((subtotal + tax.value) * 100) / 100;
  const tol = Math.max(0.02, expected * 0.005);
  if (Math.abs(amount.value - expected) <= tol) return { amount, flags: [] };
  if (tipPresent && amount.value >= expected - tol) {
    // SUBTOTAL + TAX + tip: the printed total legitimately exceeds the sum.
    if (amount.value > expected * 2) {
      return {
        amount,
        flags: [
          {
            code: "total_suspect",
            severity: "warn",
            message: `Total ${amount.value.toFixed(2)} is far above subtotal + tax (${expected.toFixed(2)}) — needs review.`,
          },
        ],
      };
    }
    return { amount, flags: [] };
  }
  // Subtotal and tax round independently, so the printed grand total can sit
  // a couple of cents off the sum — search ±3¢ and take the closest.
  const printed = findHitByValue(lines, expected, 0.03);
  const wildlyOff = Math.abs(amount.value - expected) > Math.max(1, expected * 0.35);
  if (!printed && !wildlyOff) return { amount, flags: [] };
  if (!printed && tax.value > subtotal * TAX_MAX_RATIO) {
    // The only thing contradicting the printed total is a sum whose tax is
    // an impossible share of the goods ("TAX 34.60" under "SUBTOTAL 42.00" —
    // a decimal slip, or a misread subtotal): never adopt that arithmetic.
    // Keep the printed total and demand a human look.
    return {
      amount,
      flags: [
        {
          code: "total_suspect",
          severity: "warn",
          message: `Total ${amount.value.toFixed(2)} doesn't foot with subtotal + tax (${expected.toFixed(2)}) and the tax looks garbled — needs review.`,
        },
      ],
    };
  }
  const corrected: Field<number> = printed
    ? {
        value: printed.value,
        confidence: 0.93,
        ...(printed.bbox ? { bbox: printed.bbox } : {}),
      }
    : // No printed grand total survived OCR, but the amount contradicts the
      // receipt's own arithmetic by an order of magnitude — the sum wins.
      { value: expected, confidence: 0.8 };
  return {
    amount: corrected,
    flags: [
      {
        code: "total_mismatch",
        severity: "info",
        message: `Amount corrected: ${amount.value.toFixed(2)} didn't foot with subtotal + tax (${expected.toFixed(2)}).`,
      },
    ],
  };
}

/** Reconcile the chosen amount against the printed totals (§5). */
function reconcile(
  amount: Field<number> | null,
  tax: Field<number> | null,
  subtotal: number | null,
  allMax: MoneyHit | null,
): Flag[] {
  const flags: Flag[] = [];
  if (!amount) return flags;
  const total = amount.value;
  const tol = Math.max(FLAGS.reconcileTolerance, total * 0.005);

  // The grand total should be the largest money value on the receipt.
  if (allMax && allMax.value - total > tol) {
    flags.push({
      code: "total_mismatch",
      severity: "warn",
      message: `A larger amount (${allMax.value.toFixed(2)}) appears above the total — double-check.`,
    });
  }
  // subtotal + tax should foot to total.
  if (subtotal !== null && tax) {
    if (Math.abs(subtotal + tax.value - total) > tol) {
      flags.push({
        code: "total_mismatch",
        severity: "warn",
        message: `Subtotal ${subtotal.toFixed(2)} + tax ${tax.value.toFixed(2)} ≠ total ${total.toFixed(2)}.`,
      });
    }
  }
  return flags;
}

function dateFlags(date: Field<string> | null): Flag[] {
  const flags: Flag[] = [];
  if (!date) return flags;
  const d = fromIso(date.value);
  if (!d) return flags;
  const now = new Date();
  if (d.getTime() > now.getTime() + 86_400_000) {
    flags.push({
      code: "future_date",
      severity: "warn",
      message: "Date is in the future.",
    });
  } else if (daysBetween(d, now) > FLAGS.staleAfterDays) {
    flags.push({
      code: "stale_date",
      severity: "info",
      message: `Receipt is over ${FLAGS.staleAfterDays} days old.`,
    });
  }
  return flags;
}

/** Combine field signals + OCR quality into one overall confidence. */
function overallConfidence(
  ocr: number,
  amount: Field<number> | null,
  date: Field<string> | null,
  vendor: Field<string> | null,
  flags: Flag[],
): number {
  const ocrC = Math.min(1, Math.max(0, ocr / 100));
  const parts = [
    { w: 3, v: amount?.confidence ?? 0 },
    { w: 2, v: date?.confidence ?? 0 },
    { w: 2, v: vendor?.confidence ?? 0 },
    { w: 1, v: ocrC },
  ];
  const sumW = parts.reduce((s, p) => s + p.w, 0);
  let score = parts.reduce((s, p) => s + p.w * p.v, 0) / sumW;
  // Errors and warnings erode trust.
  for (const f of flags) {
    if (f.severity === "error") score -= 0.15;
    else if (f.severity === "warn") score -= 0.07;
  }
  return Math.max(0, Math.min(1, score));
}

/** Flags that force a human review even when extraction "succeeded".
 *  Suspicious totals and garbled vendors are accepted as one-offs the rules
 *  can't fix — but they must never ship to a report without a human look. */
export function forcesManualReview(flags: Flag[]): boolean {
  return flags.some(
    (f) =>
      f.severity === "error" ||
      (f.severity === "warn" &&
        (f.code === "total_suspect" || f.code === "vendor_unclear")),
  );
}

export function parseReceipt(ocr: OcrResult): Extraction {
  const lines = ocr.lines.length
    ? ocr.lines
    : ocr.text
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map<OcrLine>((text) => ({
          text,
          confidence: ocr.confidence,
          bbox: { x: 0, y: 0, w: 1, h: 0 },
          words: [],
        }));

  const found = findAmount(lines);
  const { subtotal, allMax } = found;
  // The pre-footing pick only corroborates a multi-line tax sum; the tax
  // itself is settled before footing math consumes it.
  let tax = findTax(lines, subtotal, found.amount?.value ?? null);
  // A tax larger than the goods is a garble (id digits, misread cents) —
  // drop it so footing math never "corrects" the total with it.
  if (tax && subtotal !== null && tax.value > subtotal) tax = null;
  // Fuel receipts carry their own ground truth: gallons × price/gal; other
  // receipts often carry SUBTOTAL + TAX, which must foot to the total.
  const pump = applyPumpMath(lines, found.amount);
  const footing = pump.verified
    ? { amount: pump.amount, flags: [] as Flag[] }
    : applyFootingMath(lines, pump.amount, subtotal, tax);
  const amount = footing.amount;
  // Without a printed subtotal the guard above can't fire; a tax at or above
  // the settled total is still impossible ("TAX 289.00" on a 43.20 sale) —
  // drop it so the stored field never carries a garble. Runs after pump/
  // footing math so it never changes how the total is chosen.
  if (tax && amount && tax.value >= amount.value) tax = null;
  const date = findDate(lines);
  const currency = CURRENCY_DEFAULT; // USD-only app — nothing detects currency.

  // Vendor: prefer a recognized brand (names the merchant, not the store address —
  // the lesson ported from the original app's vendor DB). Fall back to the
  // address-skipping line heuristic when no known brand is present.
  const known = matchKnownVendor(lines, ocr.text);
  let vendor = findVendor(lines);
  const ocrVendor = vendor;
  let fuzzy: FuzzyVendorMatch | null = null;
  if (known) {
    const field: Field<string> = { value: known.name, confidence: 0.92 };
    const bbox = lineBBoxForAlias(lines, known.alias);
    if (bbox) field.bbox = bbox;
    vendor = field;
  } else {
    // Fuzzy sweep over merchant-shaped header lines only: a brand read one-
    // or-two letters off ("MOBTL", "CTATER", "FARMER 80YS") is assumed to be
    // the brand. Address, item, city/state and eatery lines never feed it —
    // one edit turned "MILTON, FL" into Hilton and "BLACK COFFEE" into Slack.
    fuzzy = fuzzyMatchVendorLines(fuzzyHeaderLines(lines));
    if (!fuzzy && vendor?.value) fuzzy = fuzzyMatchVendor(vendor.value);
    if (fuzzy && fuzzy.ratio >= FUZZY_HINT_RATIO) {
      vendor = {
        value: fuzzy.name,
        confidence: Math.max(vendor?.confidence ?? 0, 0.85),
        ...(vendor?.bbox ? { bbox: vendor.bbox } : {}),
      };
    } else {
      // Too weak to name the vendor is too weak to set the category.
      fuzzy = null;
    }
  }

  const hintText = lines.slice(0, 8).map((l) => l.text).join(" ");
  let cat: { category: Category; matched: boolean };
  if (fuzzy && fuzzy.ratio < 1) {
    // The brand needed real edits (digit folds are free): a generic keyword
    // on the receipt is direct evidence and beats the edited brand's
    // category — "PUBLIC PARKING" is not Publix.
    const kw = categorize(hintText, "", null);
    if (kw.matched && kw.category !== fuzzy.category) {
      vendor = ocrVendor;
      fuzzy = null;
      cat = kw;
    } else {
      cat = kw.matched ? kw : { category: fuzzy.category, matched: true };
    }
  } else if (fuzzy) {
    cat = { category: fuzzy.category, matched: true };
  } else {
    cat = categorize(vendor?.value ?? "", hintText, known);
  }
  // GALLONS + PRICE/GAL structure is definitionally a fuel receipt; a KNOWN
  // non-fuel brand (Costco, Walmart, Kroger fuel centers print the retail
  // brand) yields only when the pump math actually foots — paint is sold
  // "per gallon" at Home Depot too.
  if (pump.isPump && (!cat.matched || (pump.verified && cat.category !== "Fuel"))) {
    cat = { category: "Fuel", matched: true };
  }
  const category: Field<Category> = {
    value: cat.category,
    confidence: cat.matched ? 0.85 : 0.4,
  };

  const flags: Flag[] = [];
  if (!amount) flags.push({ code: "no_amount", severity: "error", message: "No total found." });
  if (!date) flags.push({ code: "no_date", severity: "warn", message: "No date found." });
  if (!vendor) flags.push({ code: "no_vendor", severity: "warn", message: "No vendor found." });
  // A tiny or vowel-less vendor no brand table recognized is usually an OCR
  // fragment ("nob") — accept it as a one-off, but demand a human look.
  if (vendor && !known && vendor.value !== fuzzy?.name) {
    const name = vendor.value.trim();
    const compact = name.replace(/[^A-Za-z0-9]/g, "");
    if (compact.length > 0 && (compact.length <= 3 || !/[aeiouy0-9]/i.test(name))) {
      flags.push({
        code: "vendor_unclear",
        severity: "warn",
        message: `Vendor "${name}" looks garbled — confirm the name.`,
      });
    }
  }
  if (!cat.matched) flags.push({ code: "uncategorized", severity: "info", message: "Category is a guess." });
  if (amount && amount.value > FLAGS.largeAmount) {
    flags.push({
      code: "large_amount",
      severity: "info",
      message: "Unusually large amount — verify.",
    });
  }
  // When pump math vouches for the amount, the "larger amount appears above"
  // reconcile warning is noise (stray gallons/garbled tokens) — drop it.
  const corrected = footing.flags.length > 0;
  const reconcileFlags = reconcile(amount, tax, subtotal, allMax).filter(
    (f) => (!pump.verified && !corrected) || f.code !== "total_mismatch",
  );
  flags.push(...reconcileFlags, ...pump.flags, ...footing.flags);
  // A printed SUBTOTAL with no readable tax caps what the total could foot
  // to; a chosen total far above it that no pump/footing net vouched for is
  // probably a garbled token the nets couldn't recover — demand a human look.
  // A printed tip widens the ceiling exactly like footing's own window does.
  const tipPresent = lines.some((l) => TIP_RE.test(l.text));
  if (
    amount && subtotal !== null && (!tax || tax.value <= 0) &&
    !pump.verified && !corrected
  ) {
    if (amount.value > subtotal * (tipPresent ? 2 : 1.5) + 0.02) {
      flags.push({
        code: "total_suspect",
        severity: "warn",
        message: `Total ${amount.value.toFixed(2)} is far above the printed subtotal ${subtotal.toFixed(2)} — needs review.`,
      });
    } else if (
      // Mirror image: a total BELOW the subtotal that nothing on the receipt
      // explains (no discount/coupon/savings line) is a dropped leading digit
      // ("24.05" → "4.05") — never ship it silently.
      amount.value < subtotal - 0.02 &&
      !lines.some((l) => DISCOUNT_RE.test(l.text))
    ) {
      flags.push({
        code: "total_suspect",
        severity: "warn",
        message: `Total ${amount.value.toFixed(2)} is below the printed subtotal ${subtotal.toFixed(2)} — needs review.`,
      });
    }
  }
  // Return/refund slips: the total keeps its magnitude (nothing downstream
  // handles a negative), but a negative sign on the total's own line, a
  // refund/return label on it, or a "REFUND TO …" line echoing the value
  // means this is money coming BACK — a human confirms before it's
  // reimbursed as a purchase. Bare policy text ("RETURN POLICY") never flags.
  if (amount) {
    const donorRefund = found.donor ? REFUND_LABEL_RE.test(found.donor.text) : false;
    const echoed = lines.some(
      (l) =>
        REFUND_ECHO_RE.test(l.text) &&
        moneyHitsFromLine(l).some(
          (h) => Math.abs(h.value - amount.value) <= FLAGS.reconcileTolerance,
        ),
    );
    if (found.negative || donorRefund || echoed) {
      flags.push({
        code: "total_suspect",
        severity: "warn",
        message: "Looks like a refund/return — confirm before reimbursing.",
      });
    }
  }
  flags.push(...dateFlags(date));

  const confidence = overallConfidence(ocr.confidence, amount, date, vendor, flags);
  if (confidence < CONFIDENCE.reviewBelow) {
    flags.push({
      code: "low_confidence",
      severity: "info",
      message: "Low confidence — please review.",
    });
  }

  return {
    vendor: vendor ?? { value: "", confidence: 0 },
    date: date ?? { value: "", confidence: 0 },
    amount: amount ?? { value: 0, confidence: 0 },
    tax: tax ?? { value: 0, confidence: 0 },
    currency,
    category,
    confidence,
    flags,
  };
}

// ── Post-hoc field location ──────────────────────────────────────────────────
// The digital "go back and find it": after a human corrects a field in
// review, locate the corrected value on the receipt's OCR lines so the
// highlight can be re-baked onto the image and the correction logged with
// provenance for training.

export function locateValue(
  lines: OcrLine[],
  kind: "amount" | "vendor" | "date",
  value: string | number,
): { bbox: BBox; lineText: string } | null {
  if (kind === "amount") {
    const target = Number(value);
    if (!Number.isFinite(target) || target <= 0) return null;
    let best: { bbox: BBox; lineText: string; payment: boolean } | null = null;
    for (const line of lines) {
      const payment = PAYMENT_RE.test(line.text);
      // Same lenient rule as extraction: a labeled total may be a bare
      // integer ("TOTAL 9") — the corrected value must be locatable there.
      for (const h of moneyHitsFromLine(line, lenientTotalLine(line.text))) {
        if (Math.abs(h.value - target) > 0.005) continue;
        if (!best || (best.payment && !payment)) {
          best = { bbox: h.bbox ?? line.bbox, lineText: line.text, payment };
        }
      }
    }
    return best ? { bbox: best.bbox, lineText: best.lineText } : null;
  }

  if (kind === "vendor") {
    const needle = String(value).trim().toLowerCase();
    const first = needle.split(/\s+/)[0] ?? "";
    // Full name first; then the leading word — corrections often use the
    // canonical brand form the receipt doesn't print in full. Never a
    // stopword ("The" would land on "OTHER STORE"), and word-bounded like
    // brand matching — a bare substring put "Ace" on "REPLACE" and baked
    // that box onto the image and into the training log.
    const probes = [
      needle,
      ...(first !== needle && !VENDOR_STOPWORD_RE.test(first) ? [first] : []),
    ].filter((p) => p.length >= 3);
    for (const probe of probes) {
      const hit = findAliasOnLines(lines, probe);
      if (hit) return hit;
    }
    return null;
  }

  // date: any line whose parsed dates (numeric or month-name forms, with
  // glyph repair) include the ISO value — the same machinery extraction uses.
  const iso = String(value);
  for (const line of lines) {
    for (const hit of parseDatesInLine(line, DATE_LABEL_RE.test(line.text))) {
      if (hit.iso === iso) {
        return { bbox: hit.bbox ?? line.bbox, lineText: line.text };
      }
    }
  }
  return null;
}

/** Read a field's value from the OCR lines inside a HAND-DRAWN box — the
 *  reverse of `locateValue`: the human points at the receipt, the stored
 *  geometry supplies the text. A line counts as "inside" when its vertical
 *  center falls in the box and it overlaps horizontally. Returns null when
 *  nothing readable sits there (the box still stands; only autofill skips). */
export function readValueInBox(
  lines: OcrLine[],
  kind: "amount" | "vendor" | "date",
  box: BBox,
): string | number | null {
  const inBox = lines.filter((l) => {
    const b = l.bbox;
    if (!b || b.w <= 0 || b.h <= 0) return false;
    const cy = b.y + b.h / 2;
    const overlapX = Math.min(b.x + b.w, box.x + box.w) - Math.max(b.x, box.x);
    return cy >= box.y && cy <= box.y + box.h && overlapX > 0;
  });
  if (inBox.length === 0) return null;

  if (kind === "date") {
    return findDate(inBox)?.value ?? null;
  }
  if (kind === "amount") {
    // The largest strict-money token inside the box: a drawn total box may
    // still catch a quantity fragment, and the grand total out-ranks it.
    let best: number | null = null;
    for (const l of inBox) {
      for (const m of l.text.matchAll(new RegExp(MONEY_SRC, "g"))) {
        const v = parseAmount(m[0]);
        if (v !== null && v > 0 && (best === null || v > best)) best = v;
      }
    }
    if (best === null) {
      // No strict money in the box: a labeled total may print a bare integer
      // ("TOTAL 9"), which extraction reads leniently — so does the box.
      for (const l of inBox) {
        if (!lenientTotalLine(l.text)) continue;
        for (const h of moneyHitsFromLine(l, true)) {
          if (h.value > 0 && (best === null || h.value > best)) best = h.value;
        }
      }
    }
    return best;
  }
  // Vendor: the longest line in the box (short fragments are usually noise).
  const texts = inBox.map((l) => l.text.replace(/\s{2,}/g, " ").trim()).filter(Boolean);
  if (texts.length === 0) return null;
  return texts.sort((a, b) => b.length - a.length)[0]!.slice(0, 60);
}
