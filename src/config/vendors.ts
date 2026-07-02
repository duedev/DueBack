import type { Category } from "../types.ts";
import EXTRA_BRANDS from "../data/vendorDb.extra.json";

// Known-vendor recognition — adapted from the original local app's `vendor_db.py`.
//
// The lesson it earned (verbatim from that module): *"The naive 'first text line'
// heuristic frequently grabbed the store address instead of the business name.
// This module cross-references the OCR text against a curated list of real brands
// so a known vendor is named (and categorised) correctly."* The online app's
// `findVendor()` had exactly that naive weakness, so we port the fix.
//
// Two ideas come across:
//   1. A curated brand → {canonical name, category, aliases} table. When any alias
//      is present in the OCR text we *name the brand* (not the address) and get its
//      category for free — one deterministic, $0 step.
//   2. Robust **word-boundary** matching with a numeric guard (`_kw_pattern`):
//      plain substring matching misfired badly — "76" matched any price ending in
//      ".76", "gas" matched "Las Vegas", "bp" matched inside other words. Matching
//      on word boundaries (and forbidding numeric aliases from touching digits /
//      `.`, `,`, `#`, `$`) removes that whole class of false positives.

/**
 * Word-boundary matcher for one alias against *lowercased* text.
 *
 * Port of the original `_kw_pattern` / `_boundary_pattern`. A purely numeric alias
 * additionally must not touch digits, `.`, `,`, `#` or `$`, so prices, store
 * numbers, addresses and zip codes never read as a brand sighting.
 */
export function wordBoundaryMatcher(alias: string): RegExp {
  const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/^\d+$/.test(alias)) {
    return new RegExp(`(?<![a-z0-9.,#$])${esc}(?![a-z0-9.,])`);
  }
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`);
}

export interface KnownVendor {
  /** Canonical display name used as the vendor value when an alias is found. */
  name: string;
  /** Category this brand maps to in the app's taxonomy. */
  category: Category;
  /** Lowercased aliases as they appear in OCR text. Longest match wins. */
  aliases: string[];
  /** Printed taglines for logo-heavy brands ("how doers get more done" → The
   *  Home Depot). Matched like long aliases, but excluded from fuzzy matching. */
  slogans?: string[];
}

// Curated brand table in the app's taxonomy. Brand names live here (not in the
// keyword rules in categories.ts) so a recognized merchant both *names* the
// vendor and *classifies* it in one pass. Generic, non-brand descriptors
// ("restaurant", "parking", "fuel"…) stay in categories.ts.
//
// Fuel / hardware / retail brands are adapted from the original `vendor_db.py`
// (remapped from its fuel/mats/misc taxonomy); travel, lodging, rideshare,
// software and telecom brands are the online app's own domain.
export const KNOWN_VENDORS: KnownVendor[] = [
  // ── Fuel / gas stations ──────────────────────────────────────────────────
  { name: "Shell", category: "Fuel", aliases: ["shell"] },
  { name: "Chevron", category: "Fuel", aliases: ["chevron"] },
  { name: "ARCO", category: "Fuel", aliases: ["arco"] },
  { name: "Mobil", category: "Fuel", aliases: ["mobil"] },
  { name: "Exxon", category: "Fuel", aliases: ["exxon", "exxonmobil"] },
  { name: "BP", category: "Fuel", aliases: ["bp"] },
  { name: "76", category: "Fuel", aliases: ["76 gas", "phillips 76", "union 76"] },
  { name: "Valero", category: "Fuel", aliases: ["valero"] },
  { name: "Marathon", category: "Fuel", aliases: ["marathon"] },
  { name: "Speedway", category: "Fuel", aliases: ["speedway"] },
  { name: "Sunoco", category: "Fuel", aliases: ["sunoco"] },
  { name: "Citgo", category: "Fuel", aliases: ["citgo"] },
  { name: "Texaco", category: "Fuel", aliases: ["texaco"] },
  { name: "Pilot", category: "Fuel", aliases: ["pilot flying j", "pilot"] },
  { name: "Flying J", category: "Fuel", aliases: ["flying j"] },
  { name: "Love's", category: "Fuel", aliases: ["love's travel", "love's", "loves"] },
  { name: "Casey's", category: "Fuel", aliases: ["casey's", "caseys", "casey"] },
  { name: "Kwik Trip", category: "Fuel", aliases: ["kwik trip"] },
  { name: "QuikTrip", category: "Fuel", aliases: ["quiktrip", "quik trip"] },
  { name: "Wawa", category: "Fuel", aliases: ["wawa"] },
  { name: "Circle K", category: "Fuel", aliases: ["circle k"] },
  { name: "AMPM", category: "Fuel", aliases: ["ampm", "am/pm"] },
  { name: "Buc-ee's", category: "Fuel", aliases: ["buc-ee's", "buc-ee", "bucees"] },
  { name: "RaceTrac", category: "Fuel", aliases: ["racetrac", "racetrack"] },
  { name: "Cenex", category: "Fuel", aliases: ["cenex"] },
  { name: "Sinclair", category: "Fuel", aliases: ["sinclair"] },
  { name: "Murphy USA", category: "Fuel", aliases: ["murphy usa", "murphy"] },
  { name: "Sheetz", category: "Fuel", aliases: ["sheetz"] },
  { name: "Gulf", category: "Fuel", aliases: ["gulf"] },
  { name: "Hess", category: "Fuel", aliases: ["hess"] },
  { name: "Conoco", category: "Fuel", aliases: ["conoco"] },
  { name: "Phillips 66", category: "Fuel", aliases: ["phillips 66"] },
  { name: "GetGo", category: "Fuel", aliases: ["getgo"] },
  { name: "Kum & Go", category: "Fuel", aliases: ["kum & go", "kum and go"] },
  { name: "Thorntons", category: "Fuel", aliases: ["thorntons"] },
  { name: "Costco Gas", category: "Fuel", aliases: ["costco gas", "costco gasoline", "costco fuel"] },

  // ── Office / hardware / general retail → Office Supplies ──────────────────
  { name: "The Home Depot", category: "Office Supplies", aliases: ["the home depot", "home depot", "homedepot"] },
  { name: "Lowe's", category: "Office Supplies", aliases: ["lowe's", "lowes"] },
  { name: "Menards", category: "Office Supplies", aliases: ["menards"] },
  { name: "Ace Hardware", category: "Office Supplies", aliases: ["ace hardware"] },
  { name: "True Value", category: "Office Supplies", aliases: ["true value"] },
  { name: "Harbor Freight", category: "Office Supplies", aliases: ["harbor freight"] },
  { name: "Fastenal", category: "Office Supplies", aliases: ["fastenal"] },
  { name: "Grainger", category: "Office Supplies", aliases: ["w.w. grainger", "grainger"] },
  { name: "Northern Tool", category: "Office Supplies", aliases: ["northern tool"] },
  { name: "Sherwin-Williams", category: "Office Supplies", aliases: ["sherwin-williams", "sherwin williams"] },
  { name: "Staples", category: "Office Supplies", aliases: ["staples"] },
  { name: "Office Depot", category: "Office Supplies", aliases: ["office depot", "officemax", "office max"] },
  { name: "Best Buy", category: "Office Supplies", aliases: ["best buy"] },
  { name: "Walmart", category: "Office Supplies", aliases: ["walmart", "wal-mart"] },
  { name: "Target", category: "Office Supplies", aliases: ["target"] },
  { name: "Costco", category: "Office Supplies", aliases: ["costco wholesale", "costco"] },
  { name: "Sam's Club", category: "Office Supplies", aliases: ["sam's club", "sams club"] },
  { name: "Amazon", category: "Office Supplies", aliases: ["amazon.com", "amazon", "amzn"] },

  // ── Meals & Entertainment ────────────────────────────────────────────────
  { name: "Starbucks", category: "Meals & Entertainment", aliases: ["starbucks"] },
  { name: "McDonald's", category: "Meals & Entertainment", aliases: ["mcdonald's", "mcdonalds"] },
  { name: "Chipotle", category: "Meals & Entertainment", aliases: ["chipotle"] },
  { name: "Panera Bread", category: "Meals & Entertainment", aliases: ["panera bread", "panera"] },
  { name: "Dunkin'", category: "Meals & Entertainment", aliases: ["dunkin donuts", "dunkin'", "dunkin"] },
  { name: "DoorDash", category: "Meals & Entertainment", aliases: ["doordash"] },
  { name: "Grubhub", category: "Meals & Entertainment", aliases: ["grubhub"] },
  { name: "Uber Eats", category: "Meals & Entertainment", aliases: ["uber eats", "ubereats"] },
  { name: "Olive Garden", category: "Meals & Entertainment", aliases: ["olive garden"] },
  { name: "Applebee's", category: "Meals & Entertainment", aliases: ["applebee's", "applebees"] },
  { name: "Chili's", category: "Meals & Entertainment", aliases: ["chili's", "chilis"] },
  { name: "Denny's", category: "Meals & Entertainment", aliases: ["denny's", "dennys"] },
  { name: "IHOP", category: "Meals & Entertainment", aliases: ["ihop"] },
  { name: "Subway", category: "Meals & Entertainment", aliases: ["subway"] },
  { name: "Taco Bell", category: "Meals & Entertainment", aliases: ["taco bell"] },
  { name: "Wendy's", category: "Meals & Entertainment", aliases: ["wendy's", "wendys"] },
  { name: "Burger King", category: "Meals & Entertainment", aliases: ["burger king"] },
  { name: "KFC", category: "Meals & Entertainment", aliases: ["kfc"] },
  { name: "Pizza Hut", category: "Meals & Entertainment", aliases: ["pizza hut"] },
  { name: "Domino's", category: "Meals & Entertainment", aliases: ["domino's", "dominos"] },

  // ── Lodging ──────────────────────────────────────────────────────────────
  { name: "Marriott", category: "Lodging", aliases: ["marriott"] },
  { name: "Hilton", category: "Lodging", aliases: ["hilton"] },
  { name: "Hyatt", category: "Lodging", aliases: ["hyatt"] },
  { name: "Sheraton", category: "Lodging", aliases: ["sheraton"] },
  { name: "Westin", category: "Lodging", aliases: ["westin"] },
  { name: "Holiday Inn", category: "Lodging", aliases: ["holiday inn"] },
  { name: "Hampton Inn", category: "Lodging", aliases: ["hampton inn"] },
  { name: "Courtyard by Marriott", category: "Lodging", aliases: ["courtyard by marriott", "courtyard"] },
  { name: "Ramada", category: "Lodging", aliases: ["ramada"] },
  { name: "Best Western", category: "Lodging", aliases: ["best western"] },
  { name: "Days Inn", category: "Lodging", aliases: ["days inn"] },
  { name: "La Quinta", category: "Lodging", aliases: ["la quinta"] },
  { name: "Comfort Inn", category: "Lodging", aliases: ["comfort inn"] },
  { name: "Embassy Suites", category: "Lodging", aliases: ["embassy suites"] },
  { name: "Airbnb", category: "Lodging", aliases: ["airbnb"] },

  // ── Ground Transportation ────────────────────────────────────────────────
  { name: "Uber", category: "Ground Transportation", aliases: ["uber"] },
  { name: "Lyft", category: "Ground Transportation", aliases: ["lyft"] },
  { name: "Hertz", category: "Ground Transportation", aliases: ["hertz"] },
  { name: "Avis", category: "Ground Transportation", aliases: ["avis"] },
  { name: "Enterprise Rent-A-Car", category: "Ground Transportation", aliases: ["enterprise rent-a-car", "enterprise rent"] },
  { name: "Budget Rent a Car", category: "Ground Transportation", aliases: ["budget rent"] },
  { name: "Zipcar", category: "Ground Transportation", aliases: ["zipcar"] },
  { name: "Amtrak", category: "Ground Transportation", aliases: ["amtrak"] },

  // ── Travel (airlines & booking) ──────────────────────────────────────────
  { name: "Delta Air Lines", category: "Travel", aliases: ["delta air lines", "delta airlines", "delta air"] },
  { name: "United Airlines", category: "Travel", aliases: ["united airlines"] },
  { name: "American Airlines", category: "Travel", aliases: ["american airlines"] },
  { name: "Southwest Airlines", category: "Travel", aliases: ["southwest airlines"] },
  { name: "JetBlue", category: "Travel", aliases: ["jetblue"] },
  { name: "Alaska Airlines", category: "Travel", aliases: ["alaska airlines"] },
  { name: "Frontier Airlines", category: "Travel", aliases: ["frontier airlines"] },
  { name: "Spirit Airlines", category: "Travel", aliases: ["spirit airlines"] },
  { name: "Expedia", category: "Travel", aliases: ["expedia"] },
  { name: "Booking.com", category: "Travel", aliases: ["booking.com"] },
  { name: "Kayak", category: "Travel", aliases: ["kayak"] },
  { name: "Priceline", category: "Travel", aliases: ["priceline"] },

  // ── Software & Subscriptions ─────────────────────────────────────────────
  { name: "Amazon Web Services", category: "Software & Subscriptions", aliases: ["amazon web services", "aws"] },
  { name: "Google", category: "Software & Subscriptions", aliases: ["google"] },
  { name: "Microsoft", category: "Software & Subscriptions", aliases: ["microsoft"] },
  { name: "Adobe", category: "Software & Subscriptions", aliases: ["adobe"] },
  { name: "GitHub", category: "Software & Subscriptions", aliases: ["github"] },
  { name: "Atlassian", category: "Software & Subscriptions", aliases: ["atlassian"] },
  { name: "Slack", category: "Software & Subscriptions", aliases: ["slack"] },
  { name: "Zoom", category: "Software & Subscriptions", aliases: ["zoom"] },
  { name: "Dropbox", category: "Software & Subscriptions", aliases: ["dropbox"] },
  { name: "Notion", category: "Software & Subscriptions", aliases: ["notion"] },
  { name: "Figma", category: "Software & Subscriptions", aliases: ["figma"] },
  { name: "OpenAI", category: "Software & Subscriptions", aliases: ["openai"] },
  { name: "Anthropic", category: "Software & Subscriptions", aliases: ["anthropic"] },
  { name: "DigitalOcean", category: "Software & Subscriptions", aliases: ["digitalocean"] },
  { name: "Heroku", category: "Software & Subscriptions", aliases: ["heroku"] },
  { name: "Netlify", category: "Software & Subscriptions", aliases: ["netlify"] },
  { name: "Vercel", category: "Software & Subscriptions", aliases: ["vercel"] },

  // ── Utilities & Phone ────────────────────────────────────────────────────
  { name: "AT&T", category: "Utilities & Phone", aliases: ["at&t"] },
  { name: "Verizon", category: "Utilities & Phone", aliases: ["verizon"] },
  { name: "T-Mobile", category: "Utilities & Phone", aliases: ["t-mobile"] },
  { name: "Comcast", category: "Utilities & Phone", aliases: ["comcast"] },
  { name: "Xfinity", category: "Utilities & Phone", aliases: ["xfinity"] },
  { name: "Spectrum", category: "Utilities & Phone", aliases: ["spectrum"] },
  { name: "Cox Communications", category: "Utilities & Phone", aliases: ["cox communications"] },
  { name: "CenturyLink", category: "Utilities & Phone", aliases: ["centurylink"] },

  // ── Shipping & Postage ───────────────────────────────────────────────────
  { name: "FedEx", category: "Shipping & Postage", aliases: ["fedex office", "fedex"] },
  { name: "The UPS Store", category: "Shipping & Postage", aliases: ["the ups store", "ups store"] },
  { name: "UPS", category: "Shipping & Postage", aliases: ["ups"] },
  { name: "USPS", category: "Shipping & Postage", aliases: ["usps"] },
  { name: "DHL", category: "Shipping & Postage", aliases: ["dhl"] },

  // ── Recognized merchants without a finer bucket → named, category "Other" ─
  { name: "Walgreens", category: "Other", aliases: ["walgreens"] },
  { name: "CVS", category: "Other", aliases: ["cvs pharmacy", "cvs"] },
  { name: "Kroger", category: "Other", aliases: ["kroger"] },
  { name: "Safeway", category: "Other", aliases: ["safeway"] },
  { name: "Albertsons", category: "Other", aliases: ["albertsons"] },
  { name: "Trader Joe's", category: "Other", aliases: ["trader joe's", "trader joe"] },
  { name: "Whole Foods", category: "Other", aliases: ["whole foods"] },
  { name: "AutoZone", category: "Other", aliases: ["autozone"] },
  { name: "O'Reilly Auto Parts", category: "Other", aliases: ["o'reilly auto", "o'reilly", "oreilly"] },
  { name: "NAPA Auto Parts", category: "Other", aliases: ["napa auto", "napa"] },
];

// ── Merge in the exported original-app database ─────────────────────────────
// src/data/vendorDb.extra.json is generated by scripts/export_vendor_db.py from
// the original local app's vendor_db.py (~300 brands). The curated table above
// is authoritative: on a name collision its category/name win and the export
// only contributes extra aliases; brand-new names are appended.

const APP_CATEGORIES = new Set<string>([
  "Meals & Entertainment", "Travel", "Lodging", "Ground Transportation",
  "Fuel", "Office Supplies", "Software & Subscriptions", "Utilities & Phone",
  "Shipping & Postage", "Professional Services", "Other",
]);

const MERGED: KnownVendor[] = (() => {
  const byName = new Map<string, KnownVendor>();
  for (const v of KNOWN_VENDORS) {
    byName.set(v.name.toLowerCase(), { ...v, aliases: [...v.aliases] });
  }
  for (const raw of EXTRA_BRANDS as {
    name: string;
    category: string;
    aliases: string[];
    slogans?: string[];
  }[]) {
    if (!raw?.name || !Array.isArray(raw.aliases)) continue;
    const category = (
      APP_CATEGORIES.has(raw.category) ? raw.category : "Other"
    ) as Category;
    const existing = byName.get(raw.name.toLowerCase());
    if (existing) {
      for (const a of raw.aliases) {
        if (!existing.aliases.includes(a)) existing.aliases.push(a);
      }
      if (raw.slogans?.length) {
        existing.slogans = [...new Set([...(existing.slogans ?? []), ...raw.slogans])];
      }
    } else {
      const entry: KnownVendor = { name: raw.name, category, aliases: [...raw.aliases] };
      if (raw.slogans?.length) entry.slogans = [...raw.slogans];
      byName.set(raw.name.toLowerCase(), entry);
    }
  }
  return [...byName.values()];
})();

/** The full brand table (curated + exported original DB), for UI/tests. */
export const ALL_VENDORS: KnownVendor[] = MERGED;

// ── Glyph normalization (port of _normalize_ocr_strict) ─────────────────────
// A tiny set of letter OCR confusions folded identically into the text and the
// aliases, so a stylized font that turns "7-ELEVEN" into "7-ELEUEN" (V read as
// U) still resolves. Letters ONLY — digits are never folded here, protecting
// numeric brands like "76".

const OCR_MULTI_FOLDS: [string, string][] = [
  ["rn", "m"],
  ["vv", "w"],
  ["cl", "d"],
];
const OCR_SINGLE_FOLDS: [string, string][] = [["u", "v"]];

export function normalizeGlyphs(s: string): string {
  if (!s) return "";
  let out = s.toLowerCase();
  for (const [a, b] of OCR_MULTI_FOLDS) out = out.split(a).join(b);
  for (const [a, b] of OCR_SINGLE_FOLDS) out = out.split(a).join(b);
  return out
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface AliasPattern {
  name: string;
  category: Category;
  alias: string;
  re: RegExp;
}

function buildPatterns(normalize: boolean): AliasPattern[] {
  const out: AliasPattern[] = [];
  for (const v of MERGED) {
    for (const alias of [...v.aliases, ...(v.slogans ?? [])]) {
      // Digit-only aliases ("76") are excluded from the glyph pass: letters are
      // what gets folded, so they can only match there via punctuation
      // stripping — which would turn a price ending ".76" into a brand hit.
      if (normalize && /^\d+$/.test(alias)) continue;
      const key = normalize ? normalizeGlyphs(alias) : alias;
      if (!key) continue;
      out.push({
        name: v.name,
        category: v.category,
        alias,
        re: wordBoundaryMatcher(key),
      });
    }
  }
  return out;
}

// Patterns for the EXACT pass (raw lowercased text) and the GLYPH pass
// (normalized text). Both keep the ORIGINAL alias so ranking is by the real
// alias length and callers can locate the source line.
const ALIAS_PATTERNS: AliasPattern[] = buildPatterns(false);
const ALIAS_PATTERNS_NORM: AliasPattern[] = buildPatterns(true);

export interface VendorMatch {
  name: string;
  category: Category;
  /** The alias that matched — lets callers locate the line it came from. */
  alias: string;
  /** Which pass matched: exact (raw text) or glyph (OCR-confusion-folded). */
  via: "exact" | "glyph";
}

function searchPatterns(
  low: string,
  patterns: AliasPattern[],
): AliasPattern | null {
  let best: { len: number; pos: number; p: AliasPattern } | null = null;
  for (const p of patterns) {
    const m = p.re.exec(low);
    if (!m) continue;
    const len = p.alias.length;
    const pos = m.index;
    if (
      !best ||
      len > best.len ||
      (len === best.len && pos < best.pos) ||
      (len === best.len && pos === best.pos && p.name > best.p.name)
    ) {
      best = { len, pos, p };
    }
  }
  return best?.p ?? null;
}

/**
 * Cross-reference OCR text against the known-vendor database. Port of the
 * original `match_vendor`, now two-pass:
 *
 * 1. **Exact** — word-bounded match on the raw lowercased text (the original,
 *    long-standing behaviour; runs first so it is byte-for-byte unchanged).
 * 2. **Glyph-normalized** — only when the exact pass misses, text + aliases are
 *    folded through {@link normalizeGlyphs} so common OCR letter confusions
 *    still resolve deterministically.
 *
 * The most specific (longest) alias wins, so a multi-word brand beats a generic
 * word it contains ("home depot" beats a stray "depot", "amazon web services"
 * beats "amazon"); ties break to the earliest position in the text.
 */
export function matchVendor(text: string): VendorMatch | null {
  if (!text) return null;
  const low = text.toLowerCase();
  const exact = searchPatterns(low, ALIAS_PATTERNS);
  if (exact) {
    return { name: exact.name, category: exact.category, alias: exact.alias, via: "exact" };
  }
  const norm = normalizeGlyphs(text);
  if (!norm) return null;
  const glyph = searchPatterns(norm, ALIAS_PATTERNS_NORM);
  if (glyph) {
    return { name: glyph.name, category: glyph.category, alias: glyph.alias, via: "glyph" };
  }
  return null;
}

// ── Bounded fuzzy backstop (port of _fuzzy_match_vendor) ────────────────────
// A tight similarity backstop that only ever runs on a SHORT vendor-name
// candidate (never the whole receipt), after exact + glyph both miss. Digit ↔
// letter confusions are folded ONLY here (not in normalizeGlyphs, which
// protects numeric brands).

const FUZZY_MIN_LEN = 5;
export const FUZZY_RATIO = 0.88;
/** At/above this ratio the canonical name may replace the OCR'd vendor text. */
export const FUZZY_RENAME_RATIO = 0.93;

const DIGIT_FOLDS: Record<string, string> = { "0": "o", "1": "l", "5": "s", "8": "b" };

function foldFull(s: string): string {
  let out = normalizeGlyphs(s);
  out = out.replace(/[0158]/g, (c) => DIGIT_FOLDS[c] ?? c);
  return out.replace(/ /g, "");
}

const FUZZY_ALIASES: { folded: string; name: string; category: Category }[] =
  MERGED.flatMap((v) =>
    v.aliases
      .filter((a) => a.length >= FUZZY_MIN_LEN)
      .map((a) => ({ folded: foldFull(a), name: v.name, category: v.category }))
      .filter((x) => x.folded.length >= FUZZY_MIN_LEN),
  );

/** Similarity in the spirit of difflib's ratio: 2·common/(len_a+len_b), with
 *  the common length computed as the longest common subsequence. */
export function similarityRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const n = a.length;
  const m = b.length;
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      cur[j] =
        ca === b.charCodeAt(j - 1)
          ? (prev[j - 1] ?? 0) + 1
          : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0);
    }
    [prev, cur] = [cur, prev];
  }
  const lcs = prev[m] ?? 0;
  return (2 * lcs) / (n + m);
}

export interface FuzzyVendorMatch {
  name: string;
  category: Category;
  ratio: number;
}

/**
 * Tight fuzzy match for a SHORT vendor-name candidate. Returns the best brand
 * whose similarity clears {@link FUZZY_RATIO}, or null. Callers should only
 * rename the vendor to the canonical brand when `ratio ≥ FUZZY_RENAME_RATIO`;
 * below that the hit is a category *hint*.
 */
export function fuzzyMatchVendor(candidate: string): FuzzyVendorMatch | null {
  if (!candidate) return null;
  const cand = candidate.trim();
  // Guard: only ever a short vendor-name candidate, not the whole receipt.
  if (cand.length > 40 || cand.split(/\s+/).length > 6) return null;
  const folded = foldFull(cand);
  if (folded.length < FUZZY_MIN_LEN) return null;
  let best: FuzzyVendorMatch & { len: number } | null = null;
  for (const fa of FUZZY_ALIASES) {
    if (Math.abs(fa.folded.length - folded.length) > 3) continue; // cheap gate
    const r = similarityRatio(fa.folded, folded);
    if (r < FUZZY_RATIO) continue;
    if (
      !best ||
      r > best.ratio ||
      (r === best.ratio && fa.folded.length > best.len)
    ) {
      best = { name: fa.name, category: fa.category, ratio: r, len: fa.folded.length };
    }
  }
  return best ? { name: best.name, category: best.category, ratio: best.ratio } : null;
}
