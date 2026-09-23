import { GENERIC_ALIASES, matchVendor, normalizeGlyphs, wordBoundaryMatcher, type VendorMatch } from "../../config/vendors.ts";
import type { BBox, Field, OcrLine } from "../../types.ts";
import { parseDatesInLine } from "./date.ts";
import { ENERGY_QTY_RE, FUEL_RATE_RE, FUEL_UNIT_RE, QTY_AFTER_RE, QTY_BEFORE_RE } from "./fuel.ts";
import { DATE_LABEL_RE, PAYMENT_RE } from "./labels.ts";
import { MONEY_RE } from "./money.ts";
import { sliceBBox } from "./text.ts";

// The merchant: the vendor-line heuristic, brand-scan scoping for generic
// aliases, and locating an alias on the OCR lines.

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
export const VENDOR_STOPWORD_RE = /^(the|a|an|and|of|at|el|la|le|los|las)$/;
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
export function fuzzyHeaderLines(lines: OcrLine[]): string[] {
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
export function lineBBoxForAlias(lines: OcrLine[], alias: string): BBox | undefined {
  return findAliasOnLines(lines, alias)?.bbox;
}

/** Locate a brand alias (or a vendor probe) on the OCR lines the way the brand
 *  matcher does — word-bounded, then glyph-folded — so the review marker and
 *  the correction locator can't drift apart. */
export function findAliasOnLines(
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

export function findVendor(lines: OcrLine[]): Field<string> | null {
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
