import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReceipt } from "../src/pipeline/extract.ts";
import type { OcrResult, OcrLine } from "../src/types.ts";

// Build a synthetic OCR result from text lines (words left empty; the extractor
// falls back to per-line text scanning, which is what we exercise here).
function ocr(lines: string[], confidence = 88): OcrResult {
  const ocrLines: OcrLine[] = lines.map((text, i) => ({
    text,
    confidence,
    bbox: { x: 0, y: i / lines.length, w: 1, h: 1 / lines.length },
    words: [],
  }));
  return { text: lines.join("\n"), confidence, lines: ocrLines, words: [] };
}

test("restaurant receipt → vendor, date, total, tax, category", () => {
  const r = parseReceipt(
    ocr([
      "BLUE BOTTLE COFFEE",
      "123 Main St, San Francisco CA",
      "Date: 03/14/2026",
      "Latte           4.50",
      "Croissant        3.75",
      "Subtotal         8.25",
      "Sales Tax        0.74",
      "TOTAL            8.99",
    ]),
  );
  assert.equal(r.amount.value, 8.99);
  assert.equal(r.tax.value, 0.74);
  assert.equal(r.date.value, "2026-03-14");
  assert.match(r.vendor.value, /BLUE BOTTLE/i);
  assert.equal(r.category.value, "Meals");
  assert.ok(r.confidence > 0.6, `confidence ${r.confidence}`);
});

test("prefers grand total over subtotal and reconciles", () => {
  const r = parseReceipt(
    ocr([
      "Office Depot",
      "Subtotal     100.00",
      "Tax            8.00",
      "GRAND TOTAL  108.00",
    ]),
  );
  assert.equal(r.amount.value, 108);
  assert.equal(r.category.value, "Office Supplies");
  // 100 + 8 == 108 → no total_mismatch flag
  assert.ok(!r.flags.some((f) => f.code === "total_mismatch"));
});

test("flags a footing mismatch", () => {
  const r = parseReceipt(
    ocr(["Shop", "Subtotal 100.00", "Tax 8.00", "TOTAL 120.00"]),
  );
  assert.equal(r.amount.value, 120);
  assert.ok(r.flags.some((f) => f.code === "total_mismatch"));
});

test("missing total → no_amount error + needs review", () => {
  const r = parseReceipt(ocr(["Some Vendor", "Thanks for visiting"]));
  assert.equal(r.amount.value, 0);
  assert.ok(r.flags.some((f) => f.code === "no_amount" && f.severity === "error"));
});

test("European date and amount", () => {
  const r = parseReceipt(
    ocr(["Café Berlin", "Datum 14.03.2026", "Summe  19,90 EUR"]),
  );
  assert.equal(r.currency, "EUR");
  assert.equal(r.amount.value, 19.9);
  assert.equal(r.date.value, "2026-03-14");
});

test("future date is flagged", () => {
  const r = parseReceipt(ocr(["Vendor", "Date 01/01/2099", "Total 5.00"]));
  assert.ok(r.flags.some((f) => f.code === "future_date"));
});

test("rideshare categorized as ground transportation", () => {
  const r = parseReceipt(
    ocr(["Uber", "Trip fare", "Total $23.40", "01/05/2026"]),
  );
  assert.equal(r.category.value, "Ground Transportation");
  assert.equal(r.amount.value, 23.4);
});

test("unlabeled receipt falls back to largest amount", () => {
  const r = parseReceipt(ocr(["Corner Store", "Item A 2.00", "Item B 19.95"]));
  assert.equal(r.amount.value, 19.95);
  // low confidence because there was no labeled total
  assert.ok(r.amount.confidence <= 0.6);
});

test("ignores savings/cash/change lines when picking the total", () => {
  const r = parseReceipt(
    ocr(["Mega Mart", "TOTAL SAVINGS 5.00", "TOTAL 42.00", "CASH 50.00", "CHANGE 8.00"]),
  );
  assert.equal(r.amount.value, 42);
  // cash tendered (50) is larger than the total but must not trip reconcile
  assert.ok(!r.flags.some((f) => f.code === "total_mismatch"));
});

test("typo'd month name still parses (jaunary)", () => {
  const r = parseReceipt(ocr(["Vendor", "Jaunary 5, 2026", "Total 5.00"]));
  assert.equal(r.date.value, "2026-01-05");
});

test("3-decimal quantities never become money (gas receipt)", () => {
  const r = parseReceipt(
    ocr([
      "SHELL",
      "06/12/2026 14:03",
      "GALLONS 11.204",
      "PRICE/GAL $3.499",
      "TOTAL $39.20",
      "CREDIT $39.20",
    ]),
  );
  assert.equal(r.amount.value, 39.2);
  // 11.204 / 3.499 must not register as larger amounts above the total.
  assert.ok(!r.flags.some((f) => f.code === "total_mismatch"), JSON.stringify(r.flags));
});

test("within a tier the largest total wins (FUEL TOTAL vs combined TOTAL)", () => {
  const r = parseReceipt(
    ocr([
      "CHEVRON",
      "FUEL TOTAL 30.00",
      "CAR WASH 9.20",
      "TOTAL 39.20",
      "06/01/2026",
    ]),
  );
  assert.equal(r.amount.value, 39.2);
});

test("label-only TOTAL line never grabs a date or register number below it", () => {
  const dateBelow = parseReceipt(
    ocr(["JOES DINER", "Burger 9.50", "TOTAL", "Date: 05/10/2026"]),
  );
  assert.equal(dateBelow.amount.value, 9.5); // falls back, never 2026

  const registerBelow = parseReceipt(
    ocr(["QUICK MART", "Item 4.25", "TOTAL", "STORE 0442 REG 2"]),
  );
  assert.equal(registerBelow.amount.value, 4.25); // never 2
});

test("label-only TOTAL still picks a strict money value on the next line", () => {
  const r = parseReceipt(ocr(["SHOP", "Item 12.00", "TOTAL", "$12.00"]));
  assert.equal(r.amount.value, 12);
});

test("lenient whole-number total on the label line still works", () => {
  const r = parseReceipt(ocr(["SHOP", "TOTAL 9", "05/01/2026"]));
  assert.equal(r.amount.value, 9);
});

test("vendor is never fabricated from an item line carrying a price", () => {
  const r = parseReceipt(
    ocr(["", "Wiper blades 34.99", "Shop towels 6.49", "TOTAL 41.48"]),
  );
  assert.equal(r.vendor.value, "");
  assert.ok(r.flags.some((f) => f.code === "no_vendor"));
});

// ── Regressions from real user receipts (review-modal screenshots) ──────────

test("real 7-Eleven slip: slogan names the brand when the logo font is unreadable", () => {
  // The stylized "7-ELEVEN" line OCRs to garbage beyond the glyph folds, but
  // the slogan line reads cleanly. Vendor must be the brand, not the slogan.
  const r = parseReceipt(
    ocr([
      "OH THANK HEAVEN",
      "FOR 7-ELEUEH", // mangled past u→v folding (N read as H)
      "TID : 00073852001",
      "09/17/2024 11:12:23",
      "Receipt # 2026875",
      "20625 VAN BUREN BLVD",
      "RIVERSIDE, CA",
      "STORE: 38520",
      "SALE",
      "AMEX",
      "AMOUNT $73.22",
    ]),
  );
  assert.equal(r.vendor.value, "7-Eleven");
  assert.equal(r.category.value, "Fuel");
  assert.equal(r.amount.value, 73.22);
  assert.equal(r.date.value, "2024-09-17");
});

test("real Home Depot receipt: qty@price never glues into the amount", () => {
  const r = parseReceipt(
    ocr([
      "A get more done.", // OCR ate "How doers" — fragment slogan must match
      "5755 MISSION AVENUE",
      "OCEANSIDE, CA 92057 (760)945-8686",
      "1018 00061 63802 09/05/23 12:00 PM",
      "SALE SELF CHECKOUT",
      "045242357741 M12M18CHG <A> 99.00",
      "1005-667-380 2 YR REPLACE <A,U> 12.00",
      "885911413763 DW 18GA 1\" B <A>",
      "2@19.28 38.56",
      "092097283077 75PK TAPCON <A> 29.47",
      "6@8.47 50.82",
      "SUBTOTAL 229.85",
      "SALES TAX 18.96",
      "TOTAL $248.81",
      "XXXXXXXXXXX1016 AMEX",
      "USD$ 248.81",
    ]),
  );
  assert.equal(r.amount.value, 248.81, `amount ${r.amount.value}`);
  assert.equal(r.vendor.value, "The Home Depot");
  assert.equal(r.date.value, "2023-09-05");
  // No glued qty@price monster may even appear as a larger-amount flag.
  assert.ok(!r.flags.some((f) => f.message.match(/2819|21928|819/)), JSON.stringify(r.flags));
});

test("real Mobil pump receipt: FUEL SALE is the total, $4.599/G never is", () => {
  const r = parseReceipt(
    ocr([
      "WELCOME TO",
      "MOBIL",
      "DATE 12/27/22 6:38",
      "TRAN#9014604",
      "PUMP# 01",
      "SERVICE LEVEL: SELF",
      "PRODUCT: Regular",
      "GALLONS: 6.927",
      "PRICE/G: $4.599",
      "FUEL SALE $31.86",
      "CREDIT $31.86",
    ]),
  );
  assert.equal(r.amount.value, 31.86, `amount ${r.amount.value}`);
  assert.ok(r.amount.confidence > 0.5, "FUEL SALE is a labeled total, not a guess");
  assert.equal(r.vendor.value, "Mobil");
  assert.equal(r.category.value, "Fuel");
  assert.equal(r.date.value, "2022-12-27");
});

// ── Pump-math reconciliation + vendor-line rejects (second test-set round) ──

test("pump math verifies a correct fuel total (real 7-Eleven pump block)", () => {
  const r = parseReceipt(
    ocr([
      "OH THANK HEAVEN",
      "FOR 7-ELEVEN",
      "09/17/2024 11:12:23",
      "PUMP 2",
      "GRADE RUL",
      "GALLONS 15.582",
      "PRICE/GAL $ 4.699",
      "TOTAL FUEL $ 73.22",
      "AMERICAN EXPRESS",
    ]),
  );
  assert.equal(r.amount.value, 73.22);
  assert.ok(r.amount.confidence >= 0.95, "pump math boosts confidence");
  assert.ok(!r.flags.some((f) => f.code === "total_mismatch"), JSON.stringify(r.flags));
});

test("pump math corrects a garbled fuel total ($3,188.00 class)", () => {
  const r = parseReceipt(
    ocr([
      "WELCOME TO",
      "MOBIL",
      "DATE 12/27/22 6:38",
      "GALLONS: 6.927",
      "PRICE/G: $4.599",
      "FUEL SALE $3188.00", // OCR mangled 31.86
      "CREDIT $3188.00",
    ]),
  );
  assert.equal(r.amount.value, 31.86, `amount ${r.amount.value}`);
  assert.ok(r.flags.some((f) => /gallons × price/.test(f.message)), JSON.stringify(r.flags));
});

test("greeting lines never become the vendor (real Mobil Mart header)", () => {
  const r = parseReceipt(
    ocr([
      "WELCOME TO",
      "M0BIL MART", // brand line mangled past the glyph folds
      "1200 N St College",
      "Anaheim CA",
      "DATE 9/23/24 9:18",
      "GALLONS: 17.153",
      "PRICE/G: $4.699",
      "FUEL SALE $80.60",
      "CREDIT $80.60",
    ]),
  );
  assert.notEqual(r.vendor.value, "WELCOME TO");
  assert.equal(r.amount.value, 80.6);
  assert.equal(r.date.value, "2024-09-23");
});

test("an OCR-misspelled address suffix (Blvg) never becomes the vendor", () => {
  const r = parseReceipt(
    ocr([
      "", // unreadable logo
      "1131 N. State College Blvg",
      "Anaheim CA 92806",
      "Item 22.00",
      "TOTAL 24.05",
      "12/02/2022",
    ]),
  );
  assert.notEqual(r.vendor.value, "1131 N. State College Blvg");
  assert.equal(r.amount.value, 24.05);
});

// ── Footing math + date glyph recovery (from the user's live-run OCR dumps) ──

test("footing math corrects a glued qty@price total to the printed grand total", () => {
  // OCR read "2@19.28" as "2919.28" (@→9) — a well-formed money token no
  // regex can reject. SUBTOTAL + SALES TAX = 248.81 is printed; it wins.
  const r = parseReceipt(
    ocr([
      "How doers get more done.",
      "1018 00061 63802 09/05/23 12:00 PM",
      "885911413763 DW 18GA 1\" B <A>",
      "2919.28 38.56",
      "SUBTOTAL 229.85",
      "SALES TAX 18.96",
      "TOTAL $248.81",
    ]),
  );
  assert.equal(r.amount.value, 248.81, `amount ${r.amount.value}`);
});

test("footing math adopts subtotal + tax when the printed total is unreadable", () => {
  const r = parseReceipt(
    ocr([
      "SHOP",
      "2919.28 38.56",
      "SUBTOTAL 229.85",
      "SALES TAX 18.96",
      "ol USD$ 248. a", // grand total destroyed by OCR
    ]),
  );
  assert.equal(r.amount.value, 248.81, `amount ${r.amount.value}`);
  assert.ok(r.flags.some((f) => /foot/.test(f.message)), JSON.stringify(r.flags));
});

test("footing hit tolerance covers independent rounding (67.36 vs printed 67.38)", () => {
  const r = parseReceipt(
    ocr([
      "DINER",
      "TOTAL 38.00", // OCR lost the leading 6 of 67.38 elsewhere; wrong pick
      "SUBTOTAL 61.96",
      "TAX 5.40",
      "AMOUNT 67.38",
    ]),
  );
  assert.equal(r.amount.value, 67.38, `amount ${r.amount.value}`);
});

test("dot-matrix date glyphs recover: @2/01/2823 → 2023-02-01", () => {
  const r = parseReceipt(
    ocr([
      "Chevron",
      "3384 14th Street",
      "@2/01/2823 1 339856883",
      "FUEL TOTAL $ 108.30",
    ]),
  );
  assert.equal(r.date.value, "2023-02-01");
});

// ── Round 3: label glyphs, subtotal window, fuzzy brands, written dates ──────

test("digit-glyph labels (T0TAL/SUBT0TAL) still anchor the amount", () => {
  const r = parseReceipt(
    ocr([
      "SHOP",
      "2819.28 38.56", // glued qty@price monster
      "SUBT0TAL 229.85",
      "5ALES TAX 18.96",
      "T0TAL $248.81",
    ]),
  );
  assert.equal(r.amount.value, 248.81, `amount ${r.amount.value}`);
});

test("subtotal window rescues the total when the tax line is unreadable", () => {
  const r = parseReceipt(
    ocr([
      "SHOP",
      "2819.28 38.56",
      "SUBTOTAL 229.85",
      "XXLES XXX 1X.96", // tax line destroyed
      "XXTAL $248.81", // label destroyed, value alive
    ]),
  );
  assert.equal(r.amount.value, 248.81, `amount ${r.amount.value}`);
  assert.ok(r.flags.some((f) => /outside subtotal/.test(f.message)), JSON.stringify(r.flags));
});

test("fuzzy header sweep: one or two letters off resolves to the brand", () => {
  const mobtl = parseReceipt(
    ocr(["WELC0ME TO", "MOBTL", "DATE 12/27/22 6:38", "GALLONS: 6.927", "PRICE/G: $4.599", "FUEL SALE $31.86"]),
  );
  assert.equal(mobtl.vendor.value, "Mobil");
  assert.equal(mobtl.category.value, "Fuel");

  const ctater = parseReceipt(
    ocr(["CTATER ma r k et", "1131 N. State College Blvd.", "Item 22.00", "TOTAL 24.05", "12/02/2022"]),
  );
  assert.equal(ctater.vendor.value, "Stater Bros. Markets");

  const farmer = parseReceipt(
    ocr(["FARMER 80YS", "WED SEPTEMBER 11,2024", "CHECK #606564-1", "1 BIG CHEESE CMB $12.49", "TOTAL $67.38"]),
  );
  assert.equal(farmer.vendor.value, "Farmer Boys");
  assert.equal(farmer.category.value, "Meals");
});

test("garbled brand line M0BIL MART resolves via digit folds", () => {
  const r = parseReceipt(
    ocr(["WELCOME TO", "M0BIL MART", "1200 N St College", "GALLONS: 17.153", "PRICE/G: $4.699", "FUEL SALE $80.60"]),
  );
  assert.equal(r.vendor.value, "Mobil");
});

test("written-out dates parse, including a comma with no space", () => {
  const noSpace = parseReceipt(ocr(["Vendor", "WED SEPTEMBER 11,2024", "TOTAL 12.00"]));
  assert.equal(noSpace.date.value, "2024-09-11");
  const spaced = parseReceipt(ocr(["Vendor", "September 11, 2024", "TOTAL 12.00"]));
  assert.equal(spaced.date.value, "2024-09-11");
});

test("dot-matrix date glyphs beyond @: l2/O2/2@23 → 2023-12-02", () => {
  const r = parseReceipt(ocr(["Vendor", "l2/O2/2@23 04:15PM", "TOTAL 12.00"]));
  assert.equal(r.date.value, "2023-12-02");
});

test("pump structure alone categorizes as Fuel", () => {
  const r = parseReceipt(
    ocr(["UNREADABLE HEADER", "GALLONS: 10.000", "PRICE/G: $5.000", "FUEL SALE $50.00"]),
  );
  assert.equal(r.category.value, "Fuel");
});

test("date/amount markers are sliced to the match, not full-width", () => {
  const r = parseReceipt(
    ocr(["JOES DINER", "1018 00061 63802 09/05/23 12:00 PM", "TOTAL 24.05"]),
  );
  assert.ok(r.date.bbox && r.date.bbox.w < 0.5, `date box w=${r.date.bbox?.w}`);
});

// ── Round 4: live-board diagnostics (PRICEZG, ©-dates, split money tokens) ──

test("PRICEZG (slash read as Z) still counts as pump structure", () => {
  const r = parseReceipt(
    ocr(["WELCOME TO", "nob", "GALLONS: 17.153", "PRICEZG: $4.699", "FUEL SALE $80.60", "CREDIT $80.60"]),
  );
  assert.equal(r.category.value, "Fuel");
  assert.equal(r.amount.value, 80.6);
});

test("© and other stamp glyphs in dates fold to digits", () => {
  const r = parseReceipt(ocr(["Chevron", "©2/01/2©23 1 339856883", "FUEL TOTAL $ 108.30"]));
  assert.equal(r.date.value, "2023-02-01");
});

test("money token split by a space around the decimal is recovered", () => {
  const r = parseReceipt(
    ocr([
      "SHOP",
      "2819.28 38.56",
      "SUBTOTAL 229.85",
      "XXLES XXX",
      "XXTAL USD$ 248. 81", // OCR split the cents off the dot
    ]),
  );
  assert.equal(r.amount.value, 248.81, `amount ${r.amount.value}`);
});

// ── Adversarial-review findings: correction nets must not corrupt good reads ──

import { forcesManualReview } from "../src/pipeline/extract.ts";

test("fuel + car wash: the larger combined TOTAL survives pump math", () => {
  const r = parseReceipt(
    ocr([
      "CHEVRON",
      "05/03/2026 14:22",
      "GALLONS 6.927",
      "PRICE/GAL 4.599",
      "FUEL TOTAL 31.86",
      "CAR WASH 9.00",
      "TOTAL 40.86",
    ]),
  );
  assert.equal(r.amount.value, 40.86, `amount ${r.amount.value}`);
  assert.equal(r.category.value, "Fuel");
});

test("grocery with a GAL item and a per-gallon promo is NOT pump-corrected", () => {
  const r = parseReceipt(
    ocr([
      "KROGER",
      "123 Main St",
      "05/03/2026 14:22",
      "MILK 1 GAL 4.99",
      "BREAD 2.49",
      "GROUND BEEF 12.87",
      "SUBTOTAL 82.10",
      "TAX 5.13",
      "TOTAL 87.23",
    ]),
  );
  assert.equal(r.amount.value, 87.23, `amount ${r.amount.value}`);
});

test('"PRICE GOOD THRU" is not a per-gallon price', () => {
  const r = parseReceipt(
    ocr(["SAFEWAY", "WATER 1 GAL 1.89", "CHICKEN 9.99", "TOTAL 45.60", "PRICE GOOD THRU 7.15"]),
  );
  assert.equal(r.amount.value, 45.6, `amount ${r.amount.value}`);
});

test("a per-gallon DISCOUNT line can't donate the gallons quantity", () => {
  const r = parseReceipt(
    ocr([
      "SHELL",
      "PUMP 05",
      "DISCOUNT 1.00/GAL",
      "GALLONS: 12.062",
      "PRICE/GAL: 2.999",
      "FUEL TOTAL 36.18",
    ]),
  );
  assert.equal(r.amount.value, 36.18, `amount ${r.amount.value}`);
});

test("merged GALLONS…TOTAL OCR line: qty comes from beside the keyword", () => {
  const r = parseReceipt(
    ocr(["CHEVRON", "GALLONS: 6.927   TOTAL 31.86", "PRICE/GAL 4.599", "TOTAL 31.86"]),
  );
  assert.equal(r.amount.value, 31.86, `amount ${r.amount.value}`);
});

test("moderate pump-math disagreement keeps the printed total and forces review", () => {
  // Gallons digit misread (6.327 vs true 6.927) — the printed total is right.
  const r = parseReceipt(
    ocr(["MOBIL", "GALLONS: 6.327", "PRICE/G: 4.599", "FUEL SALE 31.86"]),
  );
  assert.equal(r.amount.value, 31.86, `amount ${r.amount.value}`);
  assert.ok(forcesManualReview(r.flags), JSON.stringify(r.flags));
});

test("restaurant tip: total above SUBTOTAL + TAX is not 'corrected' away", () => {
  const r = parseReceipt(
    ocr([
      "JOES DINER",
      "SUBTOTAL 50.00",
      "TAX 4.00",
      "AMOUNT 54.00",
      "TIP 10.00",
      "TOTAL 64.00",
    ]),
  );
  assert.equal(r.amount.value, 64, `amount ${r.amount.value}`);
});

test("merchant names ending in state-shaped words still win the vendor slot", () => {
  const r = parseReceipt(ocr(["SMITH SUPPLY CO", "TOTAL 12.00"]));
  assert.equal(r.vendor.value, "SMITH SUPPLY CO");
  const addr = parseReceipt(ocr(["Anaheim CA", "SOME SHOP", "TOTAL 12.00"]));
  assert.notEqual(addr.vendor.value, "Anaheim CA");
});

// ── Manual-review gates: one-offs must surface, not ship ─────────────────────

test("a garbled 3-letter vendor no table recognizes demands review", () => {
  const r = parseReceipt(
    ocr([
      "WELCOME TO",
      "nob",
      "GALLONS: 17.153",
      "PRICEZG: $4.699",
      "FUEL SALE $80.60",
      "CREDIT $80.60",
    ]),
  );
  assert.equal(r.vendor.value, "nob");
  assert.ok(
    r.flags.some((f) => f.code === "vendor_unclear"),
    JSON.stringify(r.flags),
  );
  assert.ok(forcesManualReview(r.flags));
});

test("total far above the printed subtotal (no tax read) demands review", () => {
  const r = parseReceipt(
    ocr(["SHOP", "2819.28 38.56", "SUBTOTAL 229.85", "XXLES XXX", "XXTAL 2819.28"]),
  );
  // Nothing printable sits in the subtotal window, so the amount stays — but
  // it must be flagged for a human.
  assert.ok(
    r.flags.some((f) => f.code === "total_suspect" && f.severity === "warn"),
    JSON.stringify(r.flags),
  );
  assert.ok(forcesManualReview(r.flags));
});

test("clean receipts do not force manual review", () => {
  const r = parseReceipt(
    ocr(["BLUE BOTTLE COFFEE", "Date: 03/14/2026", "Subtotal 8.25", "Tax 0.74", "TOTAL 8.99"]),
  );
  assert.equal(forcesManualReview(r.flags), false, JSON.stringify(r.flags));
});

test("a comma-for-dot per-gallon price ($4,599) never flags the total", () => {
  const r = parseReceipt(
    ocr([
      "MOBIL",
      "DATE 12/27/22 6:38",
      "GALLONS: 6.927",
      "PRICE/G: $4,599",
      "FUEL SALE $31.86",
      "CREDIT $31.86",
    ]),
  );
  assert.equal(r.amount.value, 31.86);
  assert.ok(
    !r.flags.some((f) => f.code === "total_mismatch"),
    JSON.stringify(r.flags),
  );
  assert.equal(forcesManualReview(r.flags), false);
});

// ── Round-5 adversarial-review findings ──────────────────────────────────────

test("tender line equal to the pump product corrects a garbled larger total", () => {
  // TOTAL is a single-digit garble; the CREDIT tender matches gallons × price.
  const r = parseReceipt(
    ocr(["SHELL STATION", "GALLONS: 6.927", "PRICE/GAL: 4.599", "TOTAL 37.86", "CREDIT $31.86"]),
  );
  assert.equal(r.amount.value, 31.86, `amount ${r.amount.value}`);
});

test("corroborated fuel + big-store total is kept for review, not slip-corrected", () => {
  const r = parseReceipt(
    ocr([
      "SHELL",
      "GALLONS: 2.500",
      "PRICE/GAL 4.000",
      "FUEL TOTAL 10.00",
      "SNACKS 90.00",
      "TOTAL 100.00",
      "VISA 100.00",
    ]),
  );
  assert.equal(r.amount.value, 100, `amount ${r.amount.value}`);
  assert.ok(forcesManualReview(r.flags), JSON.stringify(r.flags));
});

test("advisory reconcile warns no longer force review (tip + savings receipts)", () => {
  const tip = parseReceipt(
    ocr(["OLIVE GARDEN", "SUBTOTAL 20.00", "TAX 1.60", "TIP 4.00", "TOTAL 25.60", "VISA 25.60"]),
  );
  assert.equal(tip.amount.value, 25.6);
  assert.equal(forcesManualReview(tip.flags), false, JSON.stringify(tip.flags));

  const savings = parseReceipt(
    ocr(["WALGREENS", "Date: 03/14/2026", "TOTAL 4.99", "YOU SAVED TODAY 6.50"]),
  );
  assert.equal(savings.amount.value, 4.99);
  assert.equal(forcesManualReview(savings.flags), false, JSON.stringify(savings.flags));
});

test("generous tip with no tax line is accepted, not force-reviewed", () => {
  const r = parseReceipt(
    ocr(["BELLA TRATTORIA", "SUBTOTAL 20.00", "TIP 12.00", "TOTAL 32.00", "VISA 32.00"]),
  );
  assert.equal(r.amount.value, 32, `amount ${r.amount.value}`);
  assert.equal(forcesManualReview(r.flags), false, JSON.stringify(r.flags));
});

test("window net never adopts the TIP line's own value", () => {
  const r = parseReceipt(ocr(["CAFE", "SUBTOTAL 20.00", "TIP 25.00", "TOTAL 45.00"]));
  assert.equal(r.amount.value, 45, `amount ${r.amount.value}`);
  // Unverifiable with a tip: kept and queued for a human.
  assert.ok(forcesManualReview(r.flags), JSON.stringify(r.flags));
});

test("merchant headers with store numbers survive the pump-data vendor reject", () => {
  const r = parseReceipt(
    ocr(["PRICE CHOPPER #123", "456 Oak Ave", "GROCERIES 12.50", "TAX 1.00", "TOTAL 13.50"]),
  );
  assert.match(r.vendor.value, /PRICE CHOPPER/i, r.vendor.value);
});

test("keyword-less per-gallon rate line can't flag or out-rank the total", () => {
  const r = parseReceipt(
    ocr(["SHELL STATION", "GALLONS: 6.927", "UNL $4,599/GAL", "TOTAL 31.86", "CREDIT $31.86"]),
  );
  assert.equal(r.amount.value, 31.86);
  assert.equal(forcesManualReview(r.flags), false, JSON.stringify(r.flags));
  assert.ok(!r.flags.some((f) => f.code === "total_mismatch"), JSON.stringify(r.flags));
});
