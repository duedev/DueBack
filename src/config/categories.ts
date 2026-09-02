import type { Category } from "../types.ts";
import { matchVendor, wordBoundaryMatcher, type VendorMatch } from "./vendors.ts";

// Category taxonomy + classification (§5 step 3). Deterministic and free.
//
// Classification is two-tiered:
//   1. Known-vendor match (vendors.ts) — a recognized brand both *names* the
//      vendor and gives its category in one pass.
//   2. Generic, non-brand keyword rules (below) — for merchants not in the brand
//      DB. Matching is **word-bounded** (adapted from the original app's
//      `_kw_pattern`) so short tokens like "inn" or "ink" can't fire inside
//      "dinner"/"drink", which the previous padded-substring approach risked.

// Report order: Fuel and Materials lead (the original app's taxonomy the
// user's office expects), Other ("Miscellaneous" in the workbook) closes.
export const CATEGORIES: Category[] = [
  "Fuel",
  "Materials",
  "Meals",
  "Travel",
  "Lodging",
  "Ground Transportation",
  "Office Supplies",
  "Software & Subscriptions",
  "Utilities & Phone",
  "Shipping & Postage",
  "Professional Services",
  "Other",
];

/** Display metadata used by the board chips and the workbook theming. */
export const CATEGORY_META: Record<Category, { color: string; emoji: string }> =
  {
    "Meals": { color: "FFF97316", emoji: "🍽️" },
    Travel: { color: "FF0EA5E9", emoji: "✈️" },
    Lodging: { color: "FFDB2777", emoji: "🏨" },
    "Ground Transportation": { color: "FF06B6D4", emoji: "🚕" },
    Fuel: { color: "FFEF4444", emoji: "⛽" },
    Materials: { color: "FFD97706", emoji: "🧱" },
    "Office Supplies": { color: "FFEAB308", emoji: "📎" },
    "Software & Subscriptions": { color: "FF9F1239", emoji: "💻" },
    "Utilities & Phone": { color: "FF14B8A6", emoji: "📶" },
    "Shipping & Postage": { color: "FF65A30D", emoji: "📦" },
    "Professional Services": { color: "FF64748B", emoji: "🧾" },
    Other: { color: "FF94A3B8", emoji: "🗂️" },
  };

interface Rule {
  category: Category;
  /** Lowercase generic descriptors (NOT brand names — those live in vendors.ts).
   *  A RegExp entry is matched as-is (against the lowercased haystack) for the
   *  few keywords that need a negative lookahead. */
  keywords: (string | RegExp)[];
}

// Order matters: earlier rules win on ties. Materials sits right after Fuel
// and Meals before Travel on purpose — this is a construction-reimbursement
// taxonomy, and the generic product words are exactly what supply-house
// receipts print: with Utilities ("electric", "cable") and Meals ("kitchen")
// ahead of Materials, an electrical-supply house filed as a phone bill and
// a "FLIGHT OF 4" taproom line or an "AIRPORT BLVD" address filed as Travel.
const RULES: Rule[] = [
  {
    category: "Lodging",
    keywords: ["hotel", "motel", "inn", "lodge", "resort", "hostel", "suites", "bed and breakfast"],
  },
  {
    category: "Ground Transportation",
    keywords: [
      "taxi",
      // "cab" is also the universal wine abbreviation and a cabinet SKU prefix.
      /(?<![a-z0-9])cab(?![a-z0-9])(?!\s*(?:sauv|sav|franc|hinge|pull|knob|door|hdw|hardware))/,
      "rideshare", "parking", "garage",
      // "toll" fires on the "Toll Free 1-800…" line countless headers print.
      /(?<![a-z0-9])tolls?(?![a-z0-9])(?![\s-]*free)/,
      "transit",
      // Reachable only because vendors.ts masks "subway fare" before the brand
      // passes — the sandwich alias otherwise claims every transit ticket.
      "subway fare", "car rental", "rental car", "light rail",
    ],
  },
  {
    category: "Fuel",
    // EV charging is the same expense as a tank of gas. "kwh" and "charging
    // session" are the generic descriptors that survive when a charging
    // receipt's brand line is a logo the OCR can't spell.
    keywords: [
      "gas station", "gasoline", "unleaded", "diesel", "petrol",
      // …but a "FUEL SURCHARGE" line on a freight/service invoice is not fuel.
      /(?<![a-z0-9])fuel(?![a-z0-9])(?!\s*surcharge)/,
      "per gallon", "price/gal",
      "kwh", "charging session", "ev charging", "charging station",
      "supercharging", "supercharger",
    ],
  },
  {
    category: "Materials",
    // Supply houses are named in both singular and plural ("Building
    // Supplies"); the plural used to fall through to Office Supplies via its
    // bare "supplies" keyword.
    keywords: [
      "hardware", "lumber", "building supply", "building supplies",
      "building materials", "paint", "drywall", "concrete", "masonry", "rebar",
      "plumbing supply", "plumbing supplies", "electrical supply",
      "electrical supplies", "electric supply", "supply house", "romex",
      "contractor supply", "contractor supplies", "roofing supply",
      "roofing supplies", "hvac supply", "hvac supplies", "welding supply",
      "welding supplies",
      "kitchen & bath", "kitchen and bath", "tool rental",
    ],
  },
  {
    category: "Meals",
    keywords: [
      "restaurant", "cafe", "café", "coffee", "bakery", "deli", "bistro", "diner",
      "grill", "kitchen", "tavern", "brewery", "brewing", "winery", "catering",
      "steakhouse", "sushi", "pizza", "burger", "pub",
    ],
  },
  {
    category: "Travel",
    keywords: ["airline", "airlines", "airways", "airport", "boarding pass", "baggage", "flight"],
  },
  {
    category: "Software & Subscriptions",
    // Bill-shaped "license" only: contractor invoices print "Contractor
    // License #…" (required in many states) and bars print "Liquor License".
    keywords: [
      "subscription", "saas", "software license", "site license", "license key",
      "license renewal", "domain", "hosting", "web services", "cloud",
    ],
  },
  {
    category: "Utilities & Phone",
    // Bill-shaped only: bare "electric"/"cable" filed electrical-supply
    // houses and ROMEX cable line items under the phone bill.
    keywords: [
      "electric bill", "electric service", "electric company", "electricity",
      "power bill", "water bill", "internet", "wireless", "phone bill", "utility",
      "broadband", "cable tv", "cable bill", "cable service", "cable internet",
    ],
  },
  {
    category: "Shipping & Postage",
    keywords: ["postage", "shipping", "courier", "post office", "freight", "parcel"],
  },
  {
    category: "Office Supplies",
    keywords: ["stationery", "printer", "ink", "toner", "supplies"],
  },
  {
    category: "Professional Services",
    keywords: ["consulting", "legal", "attorney", "accounting", "notary", "law office", "clinic", "agency", "associates"],
  },
];

// Precompile word-boundary matchers for every keyword, once.
const RULE_PATTERNS: { category: Category; res: RegExp[] }[] = RULES.map((r) => ({
  category: r.category,
  res: r.keywords.map((k) => (typeof k === "string" ? wordBoundaryMatcher(k) : k)),
}));

/**
 * Classify a vendor/receipt text into a category. Deterministic, free.
 * @param vendor the extracted vendor name (may be empty)
 * @param hintText additional text (e.g. first OCR lines) to widen the net
 * @param known an already-computed known-vendor match; pass `null` to force the
 *   keyword path, or omit to let this function run the brand lookup itself.
 * @returns the best category and whether it was confidently matched
 */
export function categorize(
  vendor: string,
  hintText = "",
  known: VendorMatch | null = matchVendor(`${vendor} ${hintText}`),
): { category: Category; matched: boolean } {
  if (known) return { category: known.category, matched: true };
  const hay = `${vendor} ${hintText}`.toLowerCase();
  for (const rule of RULE_PATTERNS) {
    for (const re of rule.res) {
      if (re.test(hay)) return { category: rule.category, matched: true };
    }
  }
  return { category: "Other", matched: false };
}
