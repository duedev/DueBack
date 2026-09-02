import { test } from "node:test";
import assert from "node:assert/strict";
import { matchVendor, wordBoundaryMatcher } from "../src/config/vendors.ts";
import { categorize } from "../src/config/categories.ts";
import { parseReceipt } from "../src/pipeline/extract.ts";
import type { OcrResult, OcrLine } from "../src/types.ts";

function ocr(lines: string[], confidence = 88): OcrResult {
  const ocrLines: OcrLine[] = lines.map((text, i) => ({
    text,
    confidence,
    bbox: { x: 0, y: i / lines.length, w: 1, h: 1 / lines.length },
    words: [],
  }));
  return { text: lines.join("\n"), confidence, lines: ocrLines, words: [] };
}

// ── matchVendor: known brand → canonical name + category ───────────────────────

test("matches a known brand and its category", () => {
  const shell = matchVendor("SHELL\n123 Main St\nTOTAL $45.20");
  assert.equal(shell?.name, "Shell");
  assert.equal(shell?.category, "Fuel");

  const hd = matchVendor("THE HOME DEPOT #1234");
  assert.equal(hd?.name, "The Home Depot");
  assert.equal(hd?.category, "Materials");

  const wm = matchVendor("WALMART SUPERCENTER");
  assert.equal(wm?.name, "Walmart");
});

test("longest alias wins over a generic word it contains", () => {
  // "home depot" must beat a bare "depot"-like hit.
  assert.equal(matchVendor("WELCOME TO HOME DEPOT")?.name, "The Home Depot");
  // "amazon web services" must beat "amazon".
  const aws = matchVendor("AMAZON WEB SERVICES INVOICE");
  assert.equal(aws?.name, "Amazon Web Services");
  assert.equal(aws?.category, "Software & Subscriptions");
  // plain Amazon still resolves to the retail mapping.
  assert.equal(matchVendor("AMAZON.COM ORDER")?.name, "Amazon");
  // "uber eats" must beat "uber".
  assert.equal(matchVendor("UBER EATS ORDER")?.category, "Meals");
  assert.equal(matchVendor("UBER TRIP")?.category, "Ground Transportation");
});

test("returns null when no known vendor is present", () => {
  assert.equal(matchVendor("JOE'S CORNER CAFE\nTOTAL $9.00"), null);
  assert.equal(matchVendor(""), null);
});

test("matching is word-bounded (no substring false positives)", () => {
  // "bp" must not match inside "subprime".
  assert.equal(matchVendor("SUBPRIME LENDING LLC"), null);
  // a price ending in .76 must not read as a fuel brand.
  assert.equal(matchVendor("ITEM TOTAL $45.76"), null);
  // "ups" inside "groups" / "startups" must not match The UPS Store / UPS.
  assert.equal(matchVendor("FOCUS GROUPS LLC"), null);
});

test("wordBoundaryMatcher: numeric guard rejects digit-adjacent hits", () => {
  const re = wordBoundaryMatcher("76");
  assert.equal(re.test("union 76 station"), true);
  assert.equal(re.test("$45.76"), false);
  assert.equal(re.test("store #76"), false);
  assert.equal(re.test("760 main"), false);
});

// ── categorize: brand precedence + word-bounded keyword fallback ───────────────

test("categorize prefers a known brand, else word-bounded keywords", () => {
  assert.deepEqual(categorize("Shell"), { category: "Fuel", matched: true });
  // generic keyword path for an unknown merchant.
  assert.deepEqual(categorize("Joe's Bistro", "fine dining"), {
    category: "Meals",
    matched: true,
  });
  // "inn" must not fire inside "dinner" (word-bounded keyword).
  assert.deepEqual(categorize("Dinner Club", ""), { category: "Other", matched: false });
  // but a standalone "Inn" is Lodging.
  assert.deepEqual(categorize("Seaside Inn", ""), { category: "Lodging", matched: true });
});

// ── integration through parseReceipt: brand named over the address ─────────────

test("offline parser prefers the known vendor over the store address", () => {
  const r = parseReceipt(
    ocr(["123 Main Street", "SHELL", "UNLEADED", "TOTAL $45.20", "05/01/2026"]),
  );
  assert.equal(r.vendor.value, "Shell"); // not "123 Main Street"
  assert.equal(r.category.value, "Fuel");
  assert.equal(r.amount.value, 45.2);
});

test("falls back to the business name when the vendor is unknown", () => {
  const r = parseReceipt(
    ocr(["456 Commerce Blvd", "ACME WIDGETS LLC", "TOTAL $30.00"]),
  );
  assert.match(r.vendor.value, /ACME WIDGETS/i); // address line skipped
  assert.equal(r.amount.value, 30);
});

test("Trader Joe's files under Meals (correction-log tuning, 2026-07-08)", () => {
  assert.equal(matchVendor("TRADER JOE'S #123")?.category, "Meals");
});

// ── EV charging: a session is the electric tank of gas → Fuel ─────────────────

test("Tesla charging receipts name Tesla and file under Fuel", () => {
  for (const line of [
    "TESLA, INC.",
    "Tesla Supercharger",
    "TESLA MOTORS",
    "Supercharging session",
  ]) {
    const m = matchVendor(line);
    assert.equal(m?.name, "Tesla", line);
    assert.equal(m?.category, "Fuel", line);
  }
  // Other charging networks land in the same bucket.
  assert.equal(matchVendor("ELECTRIFY AMERICA")?.category, "Fuel");
  assert.equal(matchVendor("CHARGEPOINT INC")?.name, "ChargePoint");
  assert.equal(matchVendor("EVGO FAST CHARGING")?.name, "EVgo");
});

test("a Tesla Supercharging receipt parses end to end", () => {
  const r = parseReceipt(
    ocr([
      "Tesla, Inc.",
      "3500 Deer Creek Road",
      "Supercharging Session",
      "04/12/2026",
      "38.42 kWh @ $0.36",
      "TOTAL $13.83",
    ]),
  );
  assert.equal(r.vendor.value, "Tesla"); // not the Deer Creek Road address
  assert.equal(r.category.value, "Fuel");
  assert.equal(r.amount.value, 13.83); // not the 38.42 kWh line
  assert.equal(r.date.value, "2026-04-12");
});

test("an unbranded charging receipt still classifies as Fuel", () => {
  // The brand line is a logo the OCR can't spell; the kWh line carries it.
  assert.deepEqual(categorize("", "charging session 42.1 kwh"), {
    category: "Fuel",
    matched: true,
  });
});

// ── Audit round (2026-09): matcher scoping, numeric guards, taxonomy ─────────
import { fuzzyMatchVendorLines, ALL_VENDORS, GENERIC_ALIASES } from "../src/config/vendors.ts";

test("digit-ending aliases can't continue as a decimal, and skip the glyph pass", () => {
  assert.equal(matchVendor("BURRITO SUPER 8.50"), null);
  assert.equal(matchVendor("SUPER 8 MOTEL\n123 MAIN")?.name, "Super 8");
  assert.equal(matchVendor("SUPER 8 MOTEL\n123 MAIN")?.category, "Lodging");
  const re = wordBoundaryMatcher("super 8");
  assert.equal(re.test("super 8, denver"), true);
  assert.equal(re.test("super 8.50"), false);
});

test("a bare numeric brand must own its line or precede fuel context", () => {
  assert.equal(matchVendor("MAIN ST BAKERY\n76 MAIN ST"), null);
  assert.equal(matchVendor("TABLE 76\nSERVER: AMY\nTOTAL $30.00"), null);
  assert.equal(matchVendor("GRAND FOLIO\nROOM 76\nAMOUNT 76"), null);
  assert.equal(matchVendor("76\n1234 HWY 5\nGALLONS 10.204\nTOTAL $45.00")?.name, "76");
  assert.equal(matchVendor("UNION 76 STATION")?.name, "76");
  const re = wordBoundaryMatcher("76");
  assert.equal(re.test("76 main st"), false);
  assert.equal(re.test("76"), true);
  assert.equal(re.test("union 76 station"), true);
  assert.equal(re.test("$45.76"), false);
  assert.equal(re.test("store #76"), false);
});

test("wallet tender phrases are stripped before the brand scan; slogans survive", () => {
  assert.equal(matchVendor("SHELL\nFUEL TOTAL 45.99\nGOOGLE PAY 45.99")?.name, "Shell");
  assert.equal(matchVendor("JOES DINER\nAMAZON PAY 24.05"), null);
  assert.equal(matchVendor("EXPECT MORE PAY LESS")?.name, "Target");
});

test("brand-exclusion phrases: a subway fare is transit, a Subway store is still Subway", () => {
  const r = parseReceipt(ocr(["MTA NEW YORK CITY TRANSIT", "SUBWAY FARE $2.90", "TOTAL $2.90"]));
  assert.equal(r.category.value, "Ground Transportation");
  assert.notEqual(r.vendor.value, "Subway");
  assert.equal(matchVendor("SUBWAY #12345")?.name, "Subway");
  assert.notEqual(fuzzyMatchVendorLines(["MTA NEW YORK CITY TRANSIT", "SUBWAY FARE $2.90"])?.name, "Subway");
});

test("keyword rules: toll-free, wine CAB, cabinet SKUs and fuel surcharges don't misfile", () => {
  assert.notEqual(categorize("Bella Pasta", "Toll Free 1-800-555-1234").category, "Ground Transportation");
  assert.notEqual(categorize("Bella Pasta", "call toll-free 800-555-1234").category, "Ground Transportation");
  assert.equal(categorize("", "toll plaza").category, "Ground Transportation");
  assert.equal(categorize("Vine Bar", "CAB SAUV 9.00 GRILL").category, "Meals");
  assert.equal(categorize("", "yellow cab").category, "Ground Transportation");
  assert.notEqual(categorize("ACME CABINETS", "CAB HINGE 2PK 4.99").category, "Ground Transportation");
  assert.equal(categorize("ACME Freight", "FUEL SURCHARGE").category, "Shipping & Postage");
  // kWh stays a Fuel keyword on purpose (logo-only EV charging receipts).
  assert.equal(categorize("", "42.31 kwh").category, "Fuel");
});

test("chains the exported DB filed as Other carry their real category via the curated table", () => {
  const want: [string, string][] = [
    ["CHICK-FIL-A", "Meals"], ["POPEYES LOUISIANA KITCHEN", "Meals"], ["FIVE GUYS", "Meals"],
    ["SUPER 8 MOTEL", "Lodging"], ["DOUBLETREE BY HILTON", "Lodging"],
    ["BOOST MOBILE", "Utilities & Phone"], ["NETFLIX", "Software & Subscriptions"],
    ["JETBLUE", "Travel"],
  ];
  for (const [text, cat] of want) assert.equal(matchVendor(text)?.category, cat, text);
  assert.equal(matchVendor("CINEMARK 16")?.category, matchVendor("AMC THEATRES")?.category);
});

test("keyword rule order and bill-shaped utility/software keywords", () => {
  const materials: [string, string][] = [
    ["Mayer Electric Supply", ""],
    ["ACME Electrical", "12/2 ROMEX CABLE 250FT"],
    ["Joe's Kitchen & Bath Plumbing Supply", ""],
    ["ACME Building Supplies", ""],
    ["ACME Plumbing Supplies", ""],
  ];
  for (const [v, h] of materials) {
    assert.deepEqual(categorize(v, h), { category: "Materials", matched: true }, v);
  }
  assert.equal(categorize("Hop Valley Brewery", "FLIGHT OF 4 8.00").category, "Meals");
  assert.equal(categorize("Skyline Diner", "5000 AIRPORT BLVD").category, "Meals");
  assert.notEqual(categorize("ACME Plumbing Inc", "Contractor License #123456").category, "Software & Subscriptions");
  assert.equal(categorize("Adobe Systems", "software license renewal").category, "Software & Subscriptions");
  assert.equal(categorize("Pacific Gas and Electric Company", "electric service statement").category, "Utilities & Phone");
  assert.equal(categorize("", "Airport Parking").category, "Ground Transportation");
  assert.equal(categorize("Office Supplies Warehouse", "").category, "Office Supplies");
  assert.equal(categorize("Joe's Kitchen", "").category, "Meals");
});

test("a bare PETRO header is the truck stop, not Petco", () => {
  assert.equal(matchVendor("PETRO\nTRUCK STOP")?.name, "Petro Stopping Centers");
  assert.equal(matchVendor("PETRO CANADA")?.name, "Petro-Canada");
  assert.equal(matchVendor("PETROLEUM CO"), null);
});

test("every generic alias exists in the merged table", () => {
  const all = new Set(ALL_VENDORS.flatMap((v) => v.aliases));
  for (const a of GENERIC_ALIASES) assert.ok(all.has(a), a);
});
