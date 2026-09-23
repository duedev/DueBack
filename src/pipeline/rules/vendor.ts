import {
  FUZZY_HINT_RATIO,
  fuzzyMatchVendorLines,
  GENERIC_ALIASES,
  isPaymentBrandName,
  matchVendor,
  normalizeGlyphs,
  stripProcessorPrefix,
  wordBoundaryMatcher,
  type VendorMatch,
} from "../../config/vendors.ts";
import type { BBox, Field, OcrLine } from "../../types.ts";
import { parseDatesInLine } from "./date.ts";
import { ENERGY_QTY_RE, FUEL_RATE_RE, FUEL_UNIT_RE, QTY_AFTER_RE, QTY_BEFORE_RE } from "./fuel.ts";
import { DATE_LABEL_RE, PAYMENT_RE } from "./labels.ts";
import { MONEY_RE } from "./money.ts";
import { sliceBBox } from "./text.ts";

// The merchant: the vendor-line heuristic, brand-scan scoping for generic
// aliases, locating an alias on the OCR lines, the site-ID brand hint, and
// vetting a vendor that came from elsewhere (the AI assist's answer, a drawn
// review box) against what the receipt actually prints.

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
// OCR and e-receipts don't keep the state's case ("Anaheim, ca" on every
// Chevron-app receipt, "Irvine, cA 92618"): the comma'd and ZIP forms match
// any case; the bare form takes all-caps or all-lower only, because a
// title-case tail is a company suffix ("Acme Co"), not a state.
const US_STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
// "[Cc][Aa]": a state code in any case, for the shapes that already prove an address.
const US_STATES_ANYCASE = US_STATES.split("|")
  .map((s) => [...s].map((c) => `[${c}${c.toLowerCase()}]`).join(""))
  .join("|");
const CITY_STATE_RE = new RegExp(`,\\s*(?:${US_STATES_ANYCASE})\\.?\\s*$`);
const CITY_STATE_BARE_RE = new RegExp(
  `^\\s*[A-Z][A-Za-z.'-]+\\s+(?:${US_STATES}|${US_STATES.toLowerCase()})\\.?\\s*$`,
);
const PHONE_RE = /(\+?\d[\d\s().-]{6,}\d)/;
// "Springfield, IL 62704" — a US state abbreviation followed by a ZIP code
// (any two capitals, as before, or a real state code in any case).
const STATE_ZIP_RE = new RegExp(`\\b(?:[A-Z]{2}|${US_STATES_ANYCASE})\\s+\\d{5}(?:-\\d{4})?\\b`);
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
// A site/store ID line ("SITE ID: chevron0020-981", "Store Number: 0442",
// "MERCHANT #: 8812") — names the site, never the merchant.
const ID_LINE_RE = /^\s*(?:site|store|station|location|merchant)\s*(?:id\b|#|no\b|num(?:ber)?\b)/i;

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
  // An ID line names the site, never the merchant — a brand glued into it is
  // siteIdBrand's job.
  if (ID_LINE_RE.test(t)) return false;
  // Loyalty/account boilerplate ("REWARDS MEMBER #1234") is longer than the
  // real name above it and out-scored "JOES DINER".
  if (/^(?:rewards?|member(?:ship)?|loyalty|customer|acct|account)\b[\s#:.\w]*\d/i.test(t)) {
    return false;
  }
  // Tender, staff and social-footer lines are never the merchant — nor is a
  // line that IS a card network/processor ("AM Express", "Powered by Toast",
  // "MASTERCRD XXXX1234").
  if (VENDOR_TENDER_RE.test(t) || STAFF_LINE_RE.test(t) || SOCIAL_FOOTER_RE.test(t)) return false;
  if (isPaymentBrandName(t)) return false;
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

/** Locate a vendor VALUE (a review correction, a model's answer) on the OCR
 *  lines — `locateValue`'s vendor branch, here so the box reader below can
 *  ask "is the current value what this box shows?" without a cycle. */
export function locateVendorOnLines(
  lines: OcrLine[],
  value: string,
): { bbox: BBox; lineText: string } | null {
  const needle = value.trim().toLowerCase();
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

// ── Vendor evidence beyond the line heuristic ────────────────────────────────

// A brand glued to digits inside a site/store ID ("SITE ID: chevron0020-981"
// on every Chevron-app e-receipt): the word-bounded matcher can't see it, and
// on a slip whose only merchant-shaped line was the city ("Anaheim, ca") it is
// the one brand printed. Label-scoped (a SKU or card number never counts),
// and the token must BE a distinctive alias — a generic word ("shell",
// "pilot") or a 2–3 letter code glued into an ID proves nothing.
const SITE_ID_RE =
  /\b(?:site|store|station|location|merchant)\s*(?:id|#|no\.?|num(?:ber)?)\s*[:#.]?\s*([a-z][a-z'&.-]{2,}?)[-_]?\d/i;

export function siteIdBrand(lines: OcrLine[]): { match: VendorMatch; bbox: BBox } | null {
  for (const line of lines) {
    const m = SITE_ID_RE.exec(line.text);
    if (!m) continue;
    const token = m[1]!.toLowerCase();
    const hit = matchVendor(token);
    if (!hit || hit.via !== "exact" || hit.alias !== token) continue;
    if (GENERIC_ALIASES.has(hit.alias) || hit.alias.length < 4) continue;
    // The token is the last letter run before the ID's digits.
    const start = m.index + m[0].toLowerCase().lastIndexOf(token);
    return { match: hit, bbox: sliceBBox(line, start, start + token.length) ?? line.bbox };
  }
  return null;
}

/** The city (group 1) and state (group 2) of a printed address-block line:
 *  "BANNING , CA", "Anaheim Hills, CA", "Irvine, cA 92618", "ANAHEIM CA". */
const CITY_LINE_RE = /^\s*([A-Za-z][A-Za-z .'-]*?)\s*,?\s+([A-Za-z]{2})\.?(?:\s+\d{5}(?:-\d{4})?)?\s*$/;
const squashLetters = (s: string): string => s.toLowerCase().replace(/[^a-z]+/g, "");

/**
 * Why a vendor NAME from outside the line heuristic (the AI assist's answer)
 * can't be the merchant — judged on evidence, not word shape:
 *   • "payment": it IS a card network/processor/wallet (`isPaymentBrandName`);
 *   • "city": it has the address shape itself ("Anaheim, ca", "Irvine, CA
 *     92618"), or it echoes the city (or city + state) of an address line
 *     this receipt prints — a bare "BANNING" when "BANNING , CA" is printed.
 * Never the bare "WORD ST" form on its own: "ACME CO", "PHO CA" and "JACK
 * IN" are merchants, and blanking a correct answer is worse than the rules'
 * skipping one header line. Null when nothing is wrong with it.
 */
export function vendorNameProblem(
  name: string,
  lines: readonly { text: string }[] = [],
): "payment" | "city" | null {
  const t = name.trim();
  if (!t) return null;
  if (isPaymentBrandName(t)) return "payment";
  if ((t.split(/\s+/).length <= 4 && CITY_STATE_RE.test(t)) || STATE_ZIP_RE.test(t)) return "city";
  const key = squashLetters(t);
  if (key.length < 3) return null;
  for (const l of lines) {
    const text = l.text;
    if (!(CITY_STATE_RE.test(text) || STATE_ZIP_RE.test(text) || CITY_STATE_BARE_RE.test(text))) continue;
    const m = CITY_LINE_RE.exec(text);
    if (!m) continue;
    const city = squashLetters(m[1]!);
    if (city && (key === city || key === city + m[2]!.toLowerCase())) return "city";
  }
  return null;
}

/**
 * The brand the OCR lines themselves print, as a vendor field — the scoped
 * brand scan, then the site-ID hint. `header` says whether it is safe to
 * adopt silently: the alias sits on one of the top 8 lines, or the site ID
 * names it. A distinctive alias only further down may be a footer ad ("fill
 * up at Chevron with a Techron Advantage card") — usable, but only with a
 * review.
 */
export function brandFieldFromLines(
  lines: OcrLine[],
): { field: Field<string>; header: boolean } | null {
  const known = matchKnownVendor(lines, lines.map((l) => l.text).join("\n"));
  const id = siteIdBrand(lines);
  if (known) {
    const top = findAliasOnLines(lines.slice(0, 8), known.alias);
    // "Shopping Chevron" at the foot of a Chevron-app slip is vouched for by
    // its "SITE ID: chevron0020-073" — outline the ID, the higher evidence.
    const vouched = id?.match.name === known.name ? id.bbox : undefined;
    const bbox = top?.bbox ?? vouched ?? lineBBoxForAlias(lines, known.alias);
    return {
      field: { value: known.name, confidence: 0.85, ...(bbox ? { bbox: { ...bbox } } : {}) },
      header: !!top || !!vouched,
    };
  }
  return id
    ? { field: { value: id.match.name, confidence: 0.85, bbox: { ...id.bbox } }, header: true }
    : null;
}

/** A drawn vendor box autofills from a printed line only when OCR read that
 *  line at least this confidently (0..100 — both engines' line scale). The
 *  Costco logo line "——— WEFT SOLE" read at 9 and replaced a correct
 *  "Costco Wholesale"; clean print reads 80–97. */
export const BOX_VENDOR_MIN_CONFIDENCE = 60;

/**
 * The vendor a HAND-DRAWN box reads (locate.readValueInBox → the review
 * modal's autofill). A box is a question — "what is printed here?" — not an
 * order to rename, so:
 *   0. a box over the value already in the field (`current`) confirms it:
 *      null, the field is kept as typed — no rename, no correction logged;
 *   1. else the printed merchant line: one the vendor heuristic accepts (no
 *      address, city, ID, tender or card-network line) that OCR read at
 *      ≥ BOX_VENDOR_MIN_CONFIDENCE, AS PRINTED ("MOBIL MART", "Chevron
 *      Stations Inc" — the owner's own correction, never reverted to the
 *      canonical brand). A line naming a known brand outranks a plain one
 *      (COSTCO over the WHOLESALE under it), then most letters. Only a
 *      glyph/fuzzy read is renamed to its brand ("M0BIL" → Mobil);
 *   2. else, with no clean line, the brand the box prints (scoped scan, the
 *      site ID, the fuzzy header sweep at FUZZY_HINT_RATIO);
 *   3. else null — the box still stands; a garbled read never replaces the
 *      field.
 */
export function vendorFromBox(inBox: OcrLine[], current?: string): string | null {
  if (current?.trim() && locateVendorOnLines(inBox, current)) return null;
  let best: { name: string; brand: boolean; letters: number } | null = null;
  for (let i = 0; i < inBox.length; i++) {
    const l = inBox[i]!;
    if (!(l.confidence >= BOX_VENDOR_MIN_CONFIDENCE)) continue;
    if (!looksLikeVendorLine(l, inBox[i - 1], inBox[i + 1])) continue;
    let name = cleanVendorName(l.text);
    if (!name) continue;
    let brand = false;
    const hit = matchVendor(l.text);
    if (hit) {
      // A generic word ("shell", "target") ranks like any printed line.
      brand = !GENERIC_ALIASES.has(hit.alias);
      if (brand && hit.via !== "exact") name = hit.name;
    } else {
      const fuzzy = fuzzyMatchVendorLines(fuzzyHeaderLines([l]));
      if (fuzzy && fuzzy.ratio >= FUZZY_HINT_RATIO) {
        brand = true;
        name = fuzzy.name;
      }
    }
    const letters = (name.match(/[A-Za-z]/g) ?? []).length;
    if (!best || (brand && !best.brand) || (brand === best.brand && letters > best.letters)) {
      best = { name, brand, letters };
    }
  }
  if (best) return best.name;
  const printed = brandFieldFromLines(inBox);
  if (printed) return printed.field.value;
  const fuzzy = fuzzyMatchVendorLines(fuzzyHeaderLines(inBox));
  return fuzzy && fuzzy.ratio >= FUZZY_HINT_RATIO ? fuzzy.name : null;
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
  // "SQ *JOES COFFEE": the processor's descriptor prefix is not the name.
  return stripProcessorPrefix(raw)
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
