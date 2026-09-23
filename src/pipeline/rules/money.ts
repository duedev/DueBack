import type { BBox, OcrLine } from "../../types.ts";
import { parseAmount } from "../../util/money.ts";
import { sliceBBox } from "./text.ts";

// Money tokens: what counts as an amount on a receipt line, and where it sits.

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
export const MONEY_SRC =
  "(?:[$£€¥]\\s?)?\\d{1,3}(?:,\\d{3})+(?:\\.\\d{2})?(?!\\d)" + // US grouped
  "|(?:[$£€¥]\\s?)?\\d{1,3}(?:\\.\\d{3})+,\\d{2}(?!\\d)" + //     EU grouped + cents
  "|(?:[$£€¥]\\s?)?\\d+[.,]\\d{2}(?![.,]?\\d)" + //               decimal cents
  "|[$£€¥]\\s?\\d+(?![\\d.,])"; //                                symbol + whole
export const MONEY_RE = new RegExp(MONEY_SRC);

// Used only on lines we already know are labeled totals/taxes, so a whole-number
// amount ("TOTAL 9") is still picked up without risking false positives.
const LENIENT_MONEY_RE = /-?[$£€¥]?\s?\d[\d.,]*/g;

// A money token printed NEGATIVE on its own line: a leading "-" (either side
// of the currency symbol), an accounting "(12.00)", or a trailing "-" / "CR"
// (credit). Return/refund slips print their totals this way; the chosen
// amount keeps its magnitude and the sign only gates review. "TOTAL 12.00
// (2 items)", "CREDIT CARD" and a "03-14-26" date deliberately don't match.
export const SIGNED_MONEY_RE =
  /(?:^|[\s:])(?:-\s?[$£€¥]?|[$£€¥]\s?-)\s?\d[\d,]*(?:[.,]\d{2})?(?![\d.,])|(?:^|[\s:])\(\s?[$£€¥]?\s?\d[\d,]*(?:[.,]\d{2})?\s?\)|\d[.,]\d{2}\s?(?:-(?!\w)|CR\b)/i;

export function looksLikeMoney(s: string): boolean {
  return MONEY_RE.test(s);
}

export interface MoneyHit {
  value: number;
  bbox?: BBox;
}

/** Pull money tokens from a line, with precise word boxes where possible. */
export function moneyHitsFromLine(line: OcrLine, lenient = false): MoneyHit[] {
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
export function rightmostAmount(line: OcrLine, lenient = false): MoneyHit | null {
  const hits = moneyHitsFromLine(line, lenient).filter((h) => h.value >= 0);
  if (hits.length === 0) return null;
  return hits.reduce((best, h) =>
    (h.bbox?.x ?? 1) >= (best.bbox?.x ?? 0) ? h : best,
  );
}
