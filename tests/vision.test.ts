import { test } from "node:test";
import assert from "node:assert/strict";
import {
  visionToExtraction,
  parseVisionJson,
} from "../src/pipeline/vision/schema.ts";
import { usesFreeRouting, cloudApiKey } from "../src/pipeline/vision/endpoint.ts";
import { hasBuiltInOpenRouterKey, type CloudSettings } from "../src/pipeline/vision/config.ts";

// Tier 3 (vision LLM) JSON → Extraction mapping. The network call is provider
// code; this validates the normalization that every provider feeds into.

test("a clean model response maps to a high-confidence extraction", () => {
  const ex = visionToExtraction({
    vendor: "Blue Bottle Coffee",
    date: "2026-03-14",
    amount: 8.99,
    tax: 0.74,
    category: "Meals",
  });
  assert.equal(ex.vendor.value, "Blue Bottle Coffee");
  assert.equal(ex.amount.value, 8.99);
  assert.equal(ex.tax.value, 0.74);
  assert.equal(ex.date.value, "2026-03-14");
  assert.equal(ex.currency, "USD"); // USD-only app
  assert.equal(ex.category.value, "Meals");
  assert.ok(ex.confidence >= 0.8); // all fields present ⇒ auto-done
  assert.ok(!ex.flags.some((f) => f.code === "no_amount"));
});

test("a stray currency field from a model is ignored — extraction is USD-only", () => {
  // The schema no longer asks for a currency, but a model may still send one.
  const ex = visionToExtraction({
    vendor: "Cafe Berlin",
    date: "2026-03-14",
    amount: 19.9,
    tax: 0,
    currency: "EUR",
    category: "Meals",
  });
  assert.equal(ex.currency, "USD");
});

test("string amounts and non-ISO dates are coerced/flagged", () => {
  const ex = visionToExtraction({
    vendor: "Shell",
    date: "03/14/2026", // not ISO → dropped + flagged
    amount: "$42.10",
    tax: "3.20",
    category: "NotARealCategory", // invalid → falls back to keyword categorize
  });
  assert.equal(ex.amount.value, 42.1);
  assert.equal(ex.tax.value, 3.2);
  assert.equal(ex.date.value, "");
  assert.ok(ex.flags.some((f) => f.code === "no_date"));
  // "Shell" is a known fuel vendor → categorize recovers a sensible category.
  assert.equal(ex.category.value, "Fuel");
});

test("a missing total is an error and forces review", () => {
  const ex = visionToExtraction({
    vendor: "Corner Store",
    date: "2026-01-02",
    amount: 0,
    tax: 0,
    category: "Other",
  });
  assert.ok(ex.amount.value <= 0);
  assert.ok(ex.flags.some((f) => f.code === "no_amount" && f.severity === "error"));
  assert.ok(ex.confidence < 0.8);
});

test("parseVisionJson tolerates code fences and surrounding prose", () => {
  const text = 'Sure!\n```json\n{ "vendor": "X", "amount": 1.5 }\n```\nHope that helps.';
  const parsed = parseVisionJson(text);
  assert.ok(parsed);
  assert.equal(parsed!.vendor, "X");
  assert.equal(parsed!.amount, 1.5);
});

test("parseVisionJson returns null on junk", () => {
  assert.equal(parseVisionJson("no json here"), null);
});

test("OpenRouter free routing is detected for the router and :free models", () => {
  assert.equal(usesFreeRouting("openrouter/free"), true);
  assert.equal(usesFreeRouting("qwen/qwen2.5-vl-72b-instruct:free"), true);
  assert.equal(usesFreeRouting("anthropic/claude-haiku-4.5"), false);
  assert.equal(usesFreeRouting("google/gemini-2.5-flash"), false);
});

test("the built-in free key backs only the OpenRouter free router", () => {
  const cloud = (over: Partial<CloudSettings>): CloudSettings => ({
    provider: "openrouter",
    model: "openrouter/free",
    apiKey: "",
    ...over,
  });
  const BUILT_IN = "sk-built-in"; // injected; production value comes from the build env
  // Free router, no user key → built-in key.
  assert.equal(cloudApiKey(cloud({}), BUILT_IN), BUILT_IN);
  // A user's own key always wins.
  assert.equal(cloudApiKey(cloud({ apiKey: "sk-mine" }), BUILT_IN), "sk-mine");
  // A paid OpenRouter model never uses the built-in key.
  assert.equal(cloudApiKey(cloud({ model: "anthropic/claude-haiku-4.5" }), BUILT_IN), "");
  // Other providers never use the built-in key.
  assert.equal(cloudApiKey(cloud({ provider: "anthropic", model: "claude-haiku-4-5" }), BUILT_IN), "");
  // A keyless build (this test env) injects nothing and uses no built-in key.
  assert.equal(cloudApiKey(cloud({})), "");
  assert.equal(hasBuiltInOpenRouterKey(), false);
});

// ── Audit round (2026-09) ─────────────────────────────────────────────────────
import { parseVisionJson as parseVJ } from "../src/pipeline/vision/schema.ts";

test("parseVisionJson survives leaked think-blocks and prose with stray braces", () => {
  const json = `{"vendor":"Shell","amount":45.2,"date":"2026-03-14","category":"Fuel"}`;
  assert.deepEqual(parseVJ(`<think>the total {looks} like 45.20</think>\n${json}`), JSON.parse(json));
  assert.deepEqual(parseVJ(`Sure! Here is {your} receipt: ${json} — done.`), JSON.parse(json));
  assert.deepEqual(parseVJ("```json\n" + json + "\n```"), JSON.parse(json));
  assert.deepEqual(parseVJ(`{"a":1} trailing ${json}`), { a: 1 });
  assert.equal(parseVJ("no json here"), null);
  assert.equal(parseVJ("[1,2,3]"), null);
});

import { priceFor } from "../src/pipeline/vision/clients/anthropic.ts";

test("Anthropic pricing resolves dated snapshots and never prices an unknown model at $0", () => {
  assert.deepEqual(priceFor("claude-haiku-4-5"), { in: 1, out: 5 });
  assert.deepEqual(priceFor("claude-haiku-4-5-20251001"), { in: 1, out: 5 }); // a dated id a console lists
  assert.deepEqual(priceFor("claude-sonnet-4-6"), { in: 3, out: 15 });
  assert.deepEqual(priceFor("claude-sonnet-5"), { in: 2, out: 10 }); // not the 4-6 prefix
  assert.deepEqual(priceFor("claude-opus-5"), { in: 5, out: 25 });
  // Unknown → the top rate, so the spend cap engages instead of reading $0.00.
  assert.deepEqual(priceFor("claude-something-new"), { in: 10, out: 50 });
});

// ── Vendor vetting: the model's vendor must be the merchant ──────────────────
import { forcesManualReview, parseReceipt, vendorNameProblem } from "../src/pipeline/extract.ts";
import { vetVisionVendor } from "../src/pipeline/vision/schema.ts";
import type { OcrLine, OcrResult } from "../src/types.ts";

type Raw = [string, number, number, number, number, number];
const real = (rows: Raw[]): OcrLine[] =>
  rows.map(([text, confidence, x, y, w, h]) => ({ text, confidence, bbox: { x, y, w, h }, words: [] }));
const asOcr = (lines: OcrLine[]): OcrResult => ({
  text: lines.map((l) => l.text).join("\n"),
  confidence: lines.reduce((s, l) => s + l.confidence, 0) / lines.length,
  lines,
  words: [],
});
const answer = (vendor: string) => ({ vendor, date: "2026-03-13", amount: 107.38, tax: 0, category: "Fuel" });

// Real: fuel_03-13-26_american_express (page 15 of the owner's scan) — the
// header is worn ("5. Hg Springs hee"), the card network prints cleanly, and
// the model answered "AMERICAN EXPRESS".
const BANNING = real([
  ["5. Hg Springs hee", 51.6, 0.2741, 0.1312, 0.4332, 0.0238],
  ["Baring op gpg", 23.5, 0.3608, 0.1523, 0.2543, 0.0192],
  ["308 g, HIGHLAND SPRI", 68.6, 0.1662, 0.1988, 0.6506, 0.0277],
  ["SOBHy YOUSEF", 72.8, 0.169, 0.2177, 0.3963, 0.0231],
  ["KRARRK NHN 39", 0, 0.1705, 0.2365, 0.4233, 0.0238],
  ["BANNING , CA", 81.2, 0.1733, 0.255, 0.527, 0.0262],
  ["9222@", 24.1, 0.1747, 0.2738, 0.1676, 0.0146],
  ["83/13/2028 78883184", 72.3, 0.1776, 0.2927, 0.6236, 0.0254],
  ["05:31:99 AM", 72.6, 0.179, 0.3112, 0.3679, 0.0196],
  ["KEXRRRURR NY 285 7", 24.2, 0.1847, 0.3485, 0.4901, 0.0188],
  ["AM Express", 88.1, 0.1889, 0.3669, 0.3239, 0.0173],
  ["INVOICE 879212", 86.7, 0.1932, 0.3858, 0.4517, 0.0169],
  ["AUTH 8z925@", 61.7, 0.1875, 0.4042, 0.3551, 0.0146],
  ["PUMP# 14", 74.6, 0.1861, 0.4412, 0.7784, 0.0212],
  ["Regular 18.842G", 71.8, 0.1491, 0.4673, 0.7045, 0.0281],
  ["PRICE/GAL . $5.899", 47.1, 0.1747, 0.4935, 0.6804, 0.0208],
  ["= FUEL TOTAL $ 187.38", 64.4, 0.1108, 0.5277, 0.7457, 0.0215],
  ["TS TOTAL S & pr", 0, 0.0227, 0.5742, 0.8224, 0.0254],
  ["CREDIT $ 187.38", 79.6, 0.1634, 0.6173, 0.6761, 0.0169],
  ["Dustostr-activated Pacchse Capture", 32.9, 0.1619, 0.6588, 0.5909, 0.0281],
  ["Site #: 69%88RRR0TS4Y3 :", 9.3, 0.1619, 0.6858, 0.7955, 0.0169],
  ["Shaft Number : :", 62.1, 0.1605, 0.7038, 0.4773, 0.0208],
  ["Sequence Number 57823 Gg", 66.7, 0.1605, 0.7219, 0.5256, 0.0196],
  ["Contactless N", 60.6, 0.1591, 0.7396, 0.5781, 0.0181],
  ["AMERICAN EXPRESS", 67.2, 0.1605, 0.7585, 0.2699, 0.0115],
  ["Kode: Issuer", 55.7, 0.1577, 0.7769, 0.2031, 0.0112],
  ["AID: ABEREABA256188A1", 29.9, 0.1591, 0.795, 0.3466, 0.0108],
  ["TVR: 6688682860", 59.4, 0.1577, 0.8131, 0.2543, 0.0108],
]);

// Real: a Chevron-app page whose operator line sits in the header block.
const RIVERSIDE_APP = real([
  ["Receipt — 2025-05-15", 93.3, 0.0662, 0.0265, 0.2129, 0.0115],
  ["3390 La Sierra Ave.", 95.6, 0.0667, 0.0535, 0.1632, 0.0073],
  ["Riverside CA 92503", 96, 0.0925, 0.0812, 0.1567, 0.0073],
  ["3390 La Sierra Ave.", 95.6, 0.0667, 0.1365, 0.1632, 0.0073],
  ["Chevron Station Inc.", 95.5, 0.0662, 0.1504, 0.1726, 0.0073],
  ["00200734", 96.8, 0.0672, 0.1642, 0.0672, 0.0073],
  ["Riverside, CA", 95.5, 0.0662, 0.1785, 0.1139, 0.0088],
  ["05/15/2025 481996471", 96.2, 0.0672, 0.2192, 0.1731, 0.0088],
  ["11:27:41 AM", 96.3, 0.0672, 0.2338, 0.095, 0.0073],
  ["XXXXXXXXXXXX1009", 52.2, 0.0662, 0.2615, 0.1393, 0.0073],
  ["P97", 61.4, 0.0667, 0.2754, 0.0234, 0.0073],
  ["INVOICE 0000034100", 96.1, 0.0672, 0.2892, 0.1557, 0.0073],
  ["AUTH 159399", 94.7, 0.0652, 0.3035, 0.096, 0.0073],
  ["SITE ID: chevron0020-073", 91.6, 0.0667, 0.3173, 0.209, 0.0073],
  ["4", 95.1, 0.0667, 0.3312, 0.006, 0.0073],
  ["AmericanExpress Credit", 93.1, 0.0652, 0.345, 0.193, 0.0096],
  ["PUMP# 15", 93.6, 0.0667, 0.3723, 0.0682, 0.0085],
  ["UNLEAD REG 19.182G", 92.8, 0.0662, 0.4004, 0.2104, 0.0073],
  ["PRICE/GAL $4.999", 91.6, 0.0667, 0.4135, 0.2095, 0.0092],
  ["FUEL TOTAL $ 95.89", 92.3, 0.0667, 0.4419, 0.2095, 0.0088],
  ["Total = $ 95.89", 88.1, 0.1368, 0.4973, 0.1393, 0.0088],
  ["CREDIT $ 95.89", 91.2, 0.0662, 0.525, 0.21, 0.0088],
  ["THANK YOU FOR BEING", 96.1, 0.0662, 0.5677, 0.1667, 0.0069],
  ["A REWARDS MEMBER", 95.8, 0.0657, 0.5815, 0.1408, 0.0069],
  ["Thank you for", 95.7, 0.1104, 0.6227, 0.1129, 0.0096],
  ["Shopping Chevron", 95.7, 0.102, 0.6504, 0.1393, 0.0096],
  ["Customer Copy", 96, 0.1104, 0.7065, 0.1134, 0.0092],
]);

test("a card-network vendor from the model is blanked and forces review (real Banning, CA slip)", () => {
  const draft = parseReceipt(asOcr(BANNING));
  const ex = visionToExtraction(answer("AMERICAN EXPRESS"), { draft, lines: BANNING });
  assert.equal(ex.vendor.value, "");
  assert.deepEqual(
    ex.flags.filter((f) => f.code === "vendor_unclear"),
    [
      {
        code: "vendor_unclear",
        severity: "warn",
        message:
          'The AI named a card network/payment processor ("AMERICAN EXPRESS"), not the merchant — enter the vendor.',
      },
    ],
  );
  assert.ok(!ex.flags.some((f) => f.code === "no_vendor"), "the flag says why, once");
  assert.equal(forcesManualReview(ex.flags), true);
  assert.equal(ex.category.value, "Fuel", "the model's category stands");
  // The city the address block prints is the same mistake — bare, or with its state.
  for (const city of ["Banning", "BANNING CA", "Banning, CA"]) {
    const c = visionToExtraction(answer(city), { draft, lines: BANNING });
    assert.equal(c.vendor.value, "", city);
    assert.match(c.flags.find((f) => f.code === "vendor_unclear")!.message, /the city printed on the receipt/);
  }
  // Without context (the settings probe) a card network is still never accepted.
  assert.equal(visionToExtraction(answer("American Express")).vendor.value, "");
  assert.equal(visionToExtraction(answer("Chase Visa")).vendor.value, "");
});

test("a rejected model vendor falls back to the brand the OCR prints", (t) => {
  // The answer is dated 2026-03-13: pin the clock so the "more than two
  // years old" date_suspect (dateFlags) can't force review as the calendar moves on.
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 23) });
  // Header brand ("Chevron Station Inc." on line 5): adopted silently, boxed on its line.
  const ex = visionToExtraction(answer("AmericanExpress Credit"), { draft: null, lines: RIVERSIDE_APP });
  assert.equal(ex.vendor.value, "Chevron");
  assert.equal(ex.vendor.bbox?.y, RIVERSIDE_APP[4]!.bbox.y);
  assert.ok(!forcesManualReview(ex.flags), JSON.stringify(ex.flags));
  // The site ID vouches for a brand printed only at the foot ("Shopping
  // Chevron") — still silent, outlined on the ID.
  const app = RIVERSIDE_APP.filter((l) => l.text !== "Chevron Station Inc.");
  const viaId = visionToExtraction(answer("Riverside, CA"), { lines: app });
  assert.equal(viaId.vendor.value, "Chevron");
  assert.equal(viaId.vendor.bbox?.y, app.find((l) => /^SITE ID/.test(l.text))!.bbox.y);
  assert.ok(!viaId.flags.some((x) => x.code === "vendor_unclear"), JSON.stringify(viaId.flags));
  // A brand printed only further down could be a footer ad: used, but flagged.
  const footer = app.filter((l) => !/^SITE ID/.test(l.text));
  const f = visionToExtraction(answer("VISA"), { lines: footer });
  assert.equal(f.vendor.value, "Chevron");
  assert.match(f.flags.find((x) => x.code === "vendor_unclear")!.message, /"VISA".*used "Chevron", printed further down/);
  assert.equal(forcesManualReview(f.flags), true);
});

test("a cleanly-read rules header is kept for a rejected model vendor, flagged", () => {
  const lines = real([
    ["JOES DINER", 92, 0.2, 0.05, 0.6, 0.04],
    ["VISA 24.05", 92, 0.2, 0.5, 0.6, 0.04],
  ]);
  const draft = parseReceipt(asOcr(lines));
  const ex = visionToExtraction(answer("Visa"), { draft, lines });
  assert.equal(ex.vendor.value, "JOES DINER");
  assert.equal(ex.vendor.bbox, undefined, "anchoring re-finds it on the lines (provenance.ts)");
  assert.match(ex.flags.find((f) => f.code === "vendor_unclear")!.message, /kept the printed header "JOES DINER"/);
  assert.equal(forcesManualReview(ex.flags), true);
  // A weak rules read (under 0.8) is not trusted in its place.
  const weak = parseReceipt(asOcr(lines.map((l) => ({ ...l, confidence: 60 }))));
  assert.equal(visionToExtraction(answer("Visa"), { draft: weak, lines }).vendor.value, "");
});

test("real merchants pass untouched: shared processor words, state-shaped tails; a processor prefix is stripped", () => {
  for (const name of ["Clover Food Lab", "Panda Express", "Square One Pizza", "ACME CO", "FASTENAL CO", "PHO CA", "JACK IN", "Chase"]) {
    const ex = visionToExtraction(answer(name), { lines: BANNING });
    assert.equal(ex.vendor.value, name);
    assert.ok(!ex.flags.some((f) => f.code === "vendor_unclear"), name);
  }
  const sq = visionToExtraction(answer("SQ *JOES COFFEE"));
  assert.equal(sq.vendor.value, "JOES COFFEE");
  assert.ok(!sq.flags.some((f) => f.code === "vendor_unclear"));
  // A city only by evidence: "ANAHEIM CA" is the city when the slip prints it.
  const anaheim = real([["Anaheim CA", 95, 0.1, 0.1, 0.4, 0.02]]);
  assert.deepEqual(vetVisionVendor("ANAHEIM CA", { lines: anaheim }).field, { value: "", confidence: 0 });
  assert.equal(vetVisionVendor("ANAHEIM CA").field.value, "ANAHEIM CA");
});

test("a \", CO\" company suffix from the model is kept in any case; a Colorado address still reads as the city", () => {
  const lumber = real([
    ["JOHNSON LUMBER, CO.", 92, 0.2, 0.05, 0.6, 0.04],
    ["4410 VAN BUREN BLVD", 90, 0.2, 0.1, 0.6, 0.03],
    ["RIVERSIDE, CA 92503", 90, 0.2, 0.14, 0.6, 0.03],
    ["TOTAL 107.38", 90, 0.2, 0.5, 0.6, 0.03],
  ]);
  for (const name of ["Johnson Lumber, Co.", "JOHNSON LUMBER, CO.", "Johnson Lumber, Co", "johnson lumber, co."]) {
    const ex = visionToExtraction(answer(name), { lines: lumber });
    assert.equal(ex.vendor.value, name);
    assert.ok(!ex.flags.some((f) => f.code === "vendor_unclear"), name);
    assert.equal(vendorNameProblem(name), null, `${name}: the comma'd shape alone`);
  }
  // Nor does a printed header in the same shape make it an address echo.
  const header = real([
    ["FASTENAL CO", 92, 0.2, 0.05, 0.6, 0.04],
    ["TOTAL 107.38", 90, 0.2, 0.5, 0.6, 0.03],
  ]);
  assert.equal(vendorNameProblem("FASTENAL CO", header), null);
  assert.equal(vendorNameProblem("FASTENAL", header), null);
  // A Colorado address still condemns: a ZIP on the name, or an echo of an
  // address line the slip prints (ZIP on it, or inside an address block).
  assert.equal(vendorNameProblem("DENVER, CO 80202"), "city");
  const withZip = real([
    ["KING SOOPERS", 92, 0.2, 0.05, 0.6, 0.04],
    ["1155 E 9TH AVE", 90, 0.2, 0.1, 0.6, 0.03],
    ["DENVER, CO 80218", 90, 0.2, 0.14, 0.6, 0.03],
  ]);
  const block = real([
    ["KING SOOPERS", 92, 0.2, 0.05, 0.6, 0.04],
    ["1155 E 9TH AVE", 90, 0.2, 0.1, 0.6, 0.03],
    ["DENVER, CO", 90, 0.2, 0.14, 0.6, 0.03],
    ["80218", 90, 0.2, 0.18, 0.6, 0.03],
  ]);
  for (const lines of [withZip, block]) {
    for (const name of ["DENVER, CO", "Denver"]) assert.equal(vendorNameProblem(name, lines), "city", name);
  }
  // Every other state keeps the comma'd shape as proof on its own, any case.
  for (const city of ["Cabazon, Ca", "Anaheim, ca", "Irvine, cA", "Banning, CA"]) {
    assert.equal(vendorNameProblem(city), "city", city);
  }
});

test("the model's date gets the rules' plausibility flags: over two years old is suspect, not stale", () => {
  const ex = visionToExtraction({ vendor: "PrintMyStuff", date: "2012-12-12", amount: 28.5, tax: 0, category: "Office Supplies" });
  const dateFlagsOf = ex.flags.filter((f) => /date/.test(f.code));
  assert.deepEqual(dateFlagsOf, [
    { code: "date_suspect", severity: "warn", message: "Dated 2012-12-12 — more than two years old; check the year." },
  ]);
  assert.equal(forcesManualReview(ex.flags), true);
  assert.ok(ex.confidence < 0.9);
});

test("the model's vendor is cut on a code point and never keeps a lone surrogate", () => {
  // An emoji straddling the 80-unit cut, and a model's broken "\ud83d" escape:
  // either lone surrogate made Postgres refuse the receipts upsert on every push.
  const straddle = visionToExtraction({ vendor: "A".repeat(79) + "\u{1F600}tail", date: "", amount: 1 }).vendor.value;
  assert.ok(straddle.isWellFormed(), JSON.stringify(straddle));
  assert.ok(straddle.startsWith("A".repeat(79)));
  const broken = visionToExtraction({ vendor: "Corner Cafe \ud83d", date: "", amount: 1 }).vendor.value;
  assert.ok(broken.isWellFormed(), JSON.stringify(broken));
  assert.match(broken, /^Corner Cafe/);
});
