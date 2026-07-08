import type {
  OcrResult,
  OcrLine,
  BBox,
  Category,
  Field,
  Flag,
} from "../types.ts";
import { parseAmount, detectCurrency } from "../util/money.ts";
import { monthFromName, toIso, fromIso, daysBetween } from "../util/format.ts";
import { categorize } from "../config/categories.ts";
import {
  matchVendor,
  wordBoundaryMatcher,
  normalizeGlyphs,
  fuzzyMatchVendor,
  fuzzyMatchVendorLines,
  FUZZY_RENAME_RATIO,
  type FuzzyVendorMatch,
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
// change/savings/discount/points/item-count — is not the grand total. Adapted
// from the original app's _NON_GRAND_LINE_RE so these never win the amount.
const NON_GRAND_RE =
  /\b(sub[\s-]?total|tax|savings|discount|tender(?:ed)?|tend|cash|change|points|rewards?|items?|qty|quantity|count)\b/i;
// Payment/tender lines whose money value can exceed the total (cash given, card
// charged). Excluded when finding the largest plausible amount so they don't
// masquerade as the grand total or trip the reconcile "larger amount" check.
const PAYMENT_RE =
  /\b(cash|change|tender(?:ed)?|tend|card|visa|master\s*card|mastercard|amex|american\s*express|debit|credit|approval|auth|points|rewards?)\b/i;
const TAX_RE = /\b(sales\s*tax|tax|vat|gst|hst|tps|tvq)\b/i;

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

function findAmount(lines: OcrLine[]): {
  amount: Field<number> | null;
  subtotal: number | null;
  allMax: MoneyHit | null;
} {
  let best: { hit: MoneyHit; weight: number; conf: number } | null = null;
  let subtotal: number | null = null;
  let allMax: MoneyHit | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const text = labelFold(line.text);

    // Track the largest money value anywhere (used for reconciliation), but
    // skip payment/tender lines whose value can exceed the actual total.
    if (!PAYMENT_RE.test(text)) {
      for (const h of moneyHitsFromLine(line)) {
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
      let hit = rightmostAmount(line, true);
      if (!hit && lines[i + 1]) hit = rightmostAmount(lines[i + 1]!, false);
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
          best = { hit, weight: label.weight, conf };
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
    return { amount: field, subtotal, allMax };
  }

  // No labeled total — fall back to the largest money value on the receipt.
  if (allMax && allMax.value > 0) {
    const field: Field<number> = { value: allMax.value, confidence: 0.5 };
    if (allMax.bbox) field.bbox = allMax.bbox;
    return { amount: field, subtotal, allMax };
  }
  return { amount: null, subtotal, allMax };
}

function findTax(lines: OcrLine[]): Field<number> | null {
  for (const line of lines) {
    const folded = labelFold(line.text);
    if (TAX_RE.test(folded) && !SUBTOTAL_RE.test(folded)) {
      const hit = rightmostAmount(line, true);
      if (hit && hit.value >= 0) {
        const field: Field<number> = {
          value: hit.value,
          confidence: 0.8 * (line.confidence / 100 || 0.7),
        };
        if (hit.bbox) field.bbox = hit.bbox;
        return field;
      }
    }
  }
  return null;
}

interface DateHit {
  iso: string;
  ambiguous: boolean;
  bbox?: BBox;
  labeled: boolean;
}

/** Repair digit-glyph confusions INSIDE numeric-date-shaped tokens only
 *  ("l2/O2/2@23" → "12/02/2023") — month names elsewhere stay untouched. */
function fixDateGlyphs(t: string): string {
  const digitish = "[\\dOoIlSB@]";
  const re = new RegExp(
    `(?<![A-Za-z\\d])${digitish}{1,4}[-/.]${digitish}{1,2}[-/.]${digitish}{2,4}(?![A-Za-z\\d])`,
    "g",
  );
  return t.replace(re, (tok) =>
    tok
      .replace(/[Oo@]/g, "0")
      .replace(/[Il]/g, "1")
      .replace(/S/g, "5")
      .replace(/B/g, "8"),
  );
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
  // Month name DD, YYYY — the comma may arrive with no space ("11,2024").
  for (const m of t.matchAll(
    /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,\s*|\s+)(\d{2,4})\b/g,
  )) {
    const mo = monthFromName(m[1]!);
    if (mo) addHit(out, line, labeled, +m[3]!, mo, +m[2]!, false, box(m));
  }
  // DD Month YYYY
  for (const m of t.matchAll(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?(?:\s*,\s*|\s+)(\d{2,4})\b/g,
  )) {
    const mo = monthFromName(m[2]!);
    if (mo) addHit(out, line, labeled, +m[3]!, mo, +m[1]!, false, box(m));
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

function findDate(lines: OcrLine[]): Field<string> | null {
  const labeledHits: DateHit[] = [];
  const otherHits: DateHit[] = [];
  for (const line of lines) {
    const labeled = DATE_LABEL_RE.test(line.text);
    const hits = parseDatesInLine(line, labeled);
    (labeled ? labeledHits : otherHits).push(...hits);
  }
  const chosen = labeledHits[0] ?? otherHits[0];
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
// A short "City ST" line (the zip often sits on the NEXT line, dodging the
// state+zip guard) — "Anaheim CA" is an address, not a merchant.
const CITY_STATE_RE =
  /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\.?\s*$/;
const PHONE_RE = /(\+?\d[\d\s().-]{6,}\d)/;
// "Springfield, IL 62704" — a US state abbreviation followed by a ZIP code.
const STATE_ZIP_RE = /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/;
// "123 Main St", "1700 W 7th Ave" — a leading street number plus a street word.
const STREET_NUMBER_RE = /^\s*\d{1,6}\s+\w/;

function looksLikeVendorLine(line: OcrLine): boolean {
  const t = line.text.trim();
  if (t.length < 3) return false;
  const letters = (t.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 3) return false;
  if (letters / t.length < 0.4) return false; // mostly symbols/digits
  // A line carrying a money value is an item/total line, never the merchant
  // name — taking it fabricated vendors like "Wiper blades 34.99".
  if (MONEY_RE.test(t)) return false;
  if (DATE_LABEL_RE.test(t)) return false;
  if (PHONE_RE.test(t) && letters < 6) return false;
  if (STATE_ZIP_RE.test(t)) return false; // "..., IL 62704"
  if (STREET_NUMBER_RE.test(t) && ADDRESS_RE.test(t)) return false; // "123 Main St"
  if (ADDRESS_RE.test(t)) return false;
  if (/^(receipt|invoice|order|tel|phone|fax|www\.|http)/i.test(t)) return false;
  // "WELCOME TO" / "THANK YOU" headers are not the merchant — the name is
  // usually the line below.
  if (GREETING_RE.test(t)) return false;
  // "Anaheim CA" — a short city/state line from the address block.
  if (t.split(/\s+/).length <= 4 && CITY_STATE_RE.test(t)) return false;
  // Register boilerplate ("STORE #4821", "REG 2", "TRANS 0071") is not a
  // merchant name — a numbered store/register/transaction line must not win.
  if (/^(store|reg(?:ister)?|lane|till|terminal|cashier|clerk|trans(?:action)?)\b[\s#:.]*\d/i.test(t)) {
    return false;
  }
  return true;
}

/** Find the bbox of the first line containing a known-vendor alias, so the
 *  review UI can still draw an on-image marker for a brand-matched vendor. */
function lineBBoxForAlias(lines: OcrLine[], alias: string): BBox | undefined {
  const re = wordBoundaryMatcher(alias);
  for (const line of lines) {
    const m = re.exec(line.text.toLowerCase());
    if (m) return sliceBBox(line, m.index, m.index + alias.length);
  }
  // Glyph fallback: the alias may only surface after OCR-confusion folding
  // (e.g. the line reads "7-ELEUEN" but the alias is "7-eleven").
  const normAlias = normalizeGlyphs(alias);
  if (normAlias) {
    const nre = wordBoundaryMatcher(normAlias);
    for (const line of lines) {
      if (nre.test(normalizeGlyphs(line.text))) return line.bbox;
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
    if (!looksLikeVendorLine(line)) return;
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

const FUEL_QTY_RE = /\b(?:gallons?|gal|litres?|liters?)\b/i;
const FUEL_UNIT_RE = /(?:price\s*\/?\s*g(?:al(?:lon)?)?|per\s+gal(?:lon)?|\$\s*\/\s*g)/i;
const PLAIN_NUM_RE = /\d+\.\d{1,3}/g;

/** gallons × price/gal from the printed pump lines, or null. */
function pumpMathTotal(lines: OcrLine[]): number | null {
  let qty: number | null = null;
  let unit: number | null = null;
  for (const line of lines) {
    const nums = (line.text.match(PLAIN_NUM_RE) ?? []).map(Number);
    if (qty === null && FUEL_QTY_RE.test(line.text) && !FUEL_UNIT_RE.test(line.text)) {
      const v = nums.filter((n) => n > 0 && n < 300);
      if (v.length) qty = v[v.length - 1]!;
    } else if (unit === null && FUEL_UNIT_RE.test(line.text)) {
      const v = nums.filter((n) => n > 0.5 && n < 20);
      if (v.length) unit = v[v.length - 1]!;
    }
  }
  if (qty === null || unit === null) return null;
  const product = Math.round(qty * unit * 100) / 100;
  return product >= 1 && product <= 2000 ? product : null;
}

/** Closest money hit to `value` within `tol` (non-payment lines preferred). */
function findHitByValue(lines: OcrLine[], value: number, tol: number): MoneyHit | null {
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
  return best?.hit ?? null;
}

/** Cross-check/correct the amount with pump math. Returns flags plus whether
 *  the amount now agrees with gallons × price (which silences the noisy
 *  larger-amount reconcile warning — the math is stronger evidence). */
function applyPumpMath(
  lines: OcrLine[],
  amount: Field<number> | null,
): { amount: Field<number> | null; verified: boolean; isPump: boolean; flags: Flag[] } {
  const expected = pumpMathTotal(lines);
  if (expected === null) return { amount, verified: false, isPump: false, flags: [] };
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

  // The chosen amount disagrees with the pump math. Prefer a printed money
  // value that matches it (keeps an on-image box); else adopt the computed
  // product — the misread total is the thing we must not keep.
  const printed = findHitByValue(lines, expected, tol);
  const corrected: Field<number> = printed
    ? { value: printed.value, confidence: 0.92, ...(printed.bbox ? { bbox: printed.bbox } : {}) }
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
function applyFootingMath(
  lines: OcrLine[],
  amount: Field<number> | null,
  subtotal: number | null,
  tax: Field<number> | null,
): { amount: Field<number> | null; flags: Flag[] } {
  if (!amount || subtotal === null) return { amount, flags: [] };

  // Without a readable tax line, fall back to a WINDOW check: the grand total
  // sits in [subtotal, subtotal × 1.35]. An amount far outside it (the glued
  // "2@19.28" → $2,819 class) is replaced by the largest printed money value
  // inside the window from a non-subtotal/tax/payment line.
  if (!tax || tax.value <= 0) {
    const lo = subtotal - 0.01;
    const hi = subtotal * 1.35 + 0.5;
    if (amount.value >= lo && amount.value <= hi) return { amount, flags: [] };
    let bestInWindow: MoneyHit | null = null;
    for (const line of lines) {
      const folded = labelFold(line.text);
      if (SUBTOTAL_RE.test(folded) || TAX_RE.test(folded) || PAYMENT_RE.test(folded)) continue;
      for (const h of moneyHitsFromLine(line)) {
        if (h.value < lo || h.value > hi) continue;
        if (!bestInWindow || h.value > bestInWindow.value) bestInWindow = h;
      }
    }
    if (!bestInWindow) return { amount, flags: [] };
    return {
      amount: {
        value: bestInWindow.value,
        confidence: 0.9,
        ...(bestInWindow.bbox ? { bbox: bestInWindow.bbox } : {}),
      },
      flags: [
        {
          code: "total_mismatch",
          severity: "info",
          message: `Amount corrected: ${amount.value.toFixed(2)} is far outside subtotal (${subtotal.toFixed(2)}) — took the printed total.`,
        },
      ],
    };
  }

  const expected = Math.round((subtotal + tax.value) * 100) / 100;
  const tol = Math.max(0.02, expected * 0.005);
  if (Math.abs(amount.value - expected) <= tol) return { amount, flags: [] };
  // Subtotal and tax round independently, so the printed grand total can sit
  // a couple of cents off the sum — search ±3¢ and take the closest.
  const printed = findHitByValue(lines, expected, 0.03);
  const wildlyOff = Math.abs(amount.value - expected) > Math.max(1, expected * 0.35);
  if (!printed && !wildlyOff) return { amount, flags: [] };
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

export function parseReceipt(
  ocr: OcrResult,
  opts: { currencyDefault?: string } = {},
): Extraction {
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
  const tax = findTax(lines);
  // Fuel receipts carry their own ground truth: gallons × price/gal; other
  // receipts often carry SUBTOTAL + TAX, which must foot to the total.
  const pump = applyPumpMath(lines, found.amount);
  const footing = pump.verified
    ? { amount: pump.amount, flags: [] as Flag[] }
    : applyFootingMath(lines, pump.amount, subtotal, tax);
  const amount = footing.amount;
  const date = findDate(lines);
  const currency = detectCurrency(ocr.text, opts.currencyDefault ?? CURRENCY_DEFAULT);

  // Vendor: prefer a recognized brand (names the merchant, not the store address —
  // the lesson ported from the original app's vendor DB). Fall back to the
  // address-skipping line heuristic when no known brand is present.
  const known = matchVendor(ocr.text);
  let vendor = findVendor(lines);
  let fuzzy: FuzzyVendorMatch | null = null;
  if (known) {
    const field: Field<string> = { value: known.name, confidence: 0.92 };
    const bbox = lineBBoxForAlias(lines, known.alias);
    if (bbox) field.bbox = bbox;
    vendor = field;
  } else {
    // Fuzzy sweep over the header lines: a brand read one-or-two letters off
    // ("MOBTL", "CTATER", "FARMER 80YS") is assumed to be the brand.
    fuzzy = fuzzyMatchVendorLines(lines.slice(0, 6).map((l) => l.text));
    if (!fuzzy && vendor?.value) fuzzy = fuzzyMatchVendor(vendor.value);
    if (fuzzy && fuzzy.ratio >= 0.75) {
      vendor = {
        value: fuzzy.name,
        confidence: Math.max(vendor?.confidence ?? 0, 0.85),
        ...(vendor?.bbox ? { bbox: vendor.bbox } : {}),
      };
    } else if (fuzzy && vendor && fuzzy.ratio >= FUZZY_RENAME_RATIO) {
      vendor = { ...vendor, value: fuzzy.name, confidence: 0.85 };
    }
  }

  const hintText = lines.slice(0, 8).map((l) => l.text).join(" ");
  let cat = fuzzy
    ? { category: fuzzy.category, matched: true }
    : categorize(vendor?.value ?? "", hintText, known);
  // GALLONS + PRICE/GAL structure is definitionally a fuel receipt.
  if (!cat.matched && pump.isPump) {
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
