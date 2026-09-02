import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReceipt, locateValue, readValueInBox } from "../src/pipeline/extract.ts";
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
  assert.equal(r.currency, "USD"); // USD-only app — currency is never detected
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

// ── Tuning round from the user's ORIGINAL photos (TestSet.zip) ───────────────

test("Chevron pump-stamp dates: leading 0 read as B or p still parses", () => {
  // IMG_2087: "B2/08/2023 28261317" — the 0 of "02" read as B.
  const b = parseReceipt(ocr(["Chevron", "B2/08/2023 28261317", "FUEL TOTAL $ 104.23"]));
  assert.equal(b.date.value, "2023-02-08", `B-fold got ${b.date.value}`);
  // IMG_2085: "p2/01/2023 1 33985883" — the 0 read as a lowercase p.
  const p = parseReceipt(ocr(["Chevron", "p2/01/2023 1 33985883", "FUEL TOTAL & 108.30"]));
  assert.equal(p.date.value, "2023-02-01", `p-fold got ${p.date.value}`);
  // The year-side B fold ("2B23" → 2823 → 2023 recovery) still works.
  const y = parseReceipt(ocr(["SHOP", "12/02/2B23", "TOTAL 9.99"]));
  assert.equal(y.date.value, "2023-12-02", `year B got ${y.date.value}`);
});

test("month-name date with the comma read as a dot parses", () => {
  // IMG_0404: "WEL SEPTEMBER 11.2024" (printed "WED SEPTEMBER 11,2024").
  const r = parseReceipt(
    ocr(["FARMER BOYS", "WEL SEPTEMBER 11.2024", "SUB-TOTAL ; $61.96", "TAX : $5.42", "TOTAL $67.38"]),
  );
  assert.equal(r.date.value, "2024-09-11", `got ${r.date.value}`);
});

test("fuel structure without runnable pump math still categorizes as Fuel", () => {
  // IMG_0401: "GALLONS: 18153" lost its decimal — no math, but PRICE/G
  // proves the receipt class.
  const r = parseReceipt(
    ocr([
      "WELCOME TO",
      "nob]",
      "DATE 9/23/24 9:18",
      "PUMP# 03",
      "PRODUCT: Regular",
      "GALLONS: 18153",
      "PRICE/G: 4.699",
      "FUEL SALE FOR",
      "CREDIT 80.60",
      "UoD$80.60",
    ]),
  );
  assert.equal(r.category.value, "Fuel", `got ${r.category.value}`);
  assert.equal(r.amount.value, 80.6);
});

test("locateValue finds month-name and glyph-garbled dates via the parser", () => {
  const fb = locateValue(
    lines2(["FARMER BOYS", "WEL SEPTEMBER 11.2024", "TOTAL $67.38"]),
    "date",
    "2024-09-11",
  );
  assert.ok(fb && /SEPTEMBER/.test(fb.lineText), JSON.stringify(fb));
  const ch = locateValue(
    lines2(["Chevron", "B2/08/2023 28261317", "FUEL TOTAL $ 104.23"]),
    "date",
    "2023-02-08",
  );
  assert.ok(ch && /B2\/08/.test(ch.lineText), JSON.stringify(ch));
});

// ── EV charging: the kWh quantity is not a competing total ───────────────────

test("a kWh quantity above the total doesn't flag the receipt", () => {
  const r = parseReceipt(
    ocr([
      "TESLA",
      "SUPERCHARGER BARSTOW CA",
      "06/20/2026 09:14",
      "ENERGY 42.31 kWh",
      "RATE $0.36/kWh",
      "TOTAL $15.23",
    ]),
  );
  assert.equal(r.amount.value, 15.23);
  assert.deepEqual(
    r.flags.filter((f) => f.code === "total_mismatch"),
    [],
    "42.31 kWh must not read as a larger amount above the total",
  );
});

test("the dollar amount on a kWh line still counts", () => {
  // No TOTAL label at all: the charge shares the line with the quantity, so
  // only the quantity may be dropped from the money scan.
  const r = parseReceipt(
    ocr(["TESLA SUPERCHARGER", "05/02/2026", "Energy 38.42 kWh   $12.60"]),
  );
  assert.equal(r.amount.value, 12.6);
});

test("a genuine larger amount above the total still flags", () => {
  const r = parseReceipt(
    ocr(["JOES DINER", "05/02/2026", "ITEM 99.00", "TOTAL $22.10"]),
  );
  assert.ok(r.flags.some((f) => f.code === "total_mismatch"));
});

// ── Audit round: tax-line poisons + label-only-TOTAL tender grab ─────────────

test("a VAT registration number never becomes the tax or rewrites the total", () => {
  const r = parseReceipt(
    ocr([
      "CORNER SHOP LTD",
      "VAT No 123 4567 89",
      "Date: 03/14/2026",
      "SUBTOTAL 4.50",
      "VAT 0.90",
      "TOTAL 5.40",
    ]),
  );
  assert.equal(r.amount.value, 5.4, `amount ${r.amount.value}`);
  assert.equal(r.tax.value, 0.9, `tax ${r.tax.value}`);
  assert.ok(!r.flags.some((f) => f.code === "total_mismatch"), JSON.stringify(r.flags));
});

test("a TAX ID line never donates its digits as the tax", () => {
  const r = parseReceipt(
    ocr(["ACME SUPPLY", "TAX ID: 84-1234567", "SUBTOTAL 50.00", "SALES TAX 4.13", "TOTAL 54.13"]),
  );
  assert.equal(r.amount.value, 54.13, `amount ${r.amount.value}`);
  assert.equal(r.tax.value, 4.13, `tax ${r.tax.value}`);
});

test("a TAX INVOICE number never donates its digits as the tax", () => {
  const r = parseReceipt(
    ocr(["CITY BISTRO", "TAX INVOICE #123456", "SUBTOTAL 60.00", "GST 6.00", "TOTAL 66.00"]),
  );
  assert.equal(r.amount.value, 66, `amount ${r.amount.value}`);
  assert.equal(r.tax.value, 6, `tax ${r.tax.value}`);
});

test("TAX RATE / percentage lines are skipped; the real tax amount still wins", () => {
  const rate = parseReceipt(
    ocr(["GAS N GO", "TAX RATE 8.25%", "SUBTOTAL 20.00", "SALES TAX 1.65", "TOTAL 21.65"]),
  );
  assert.equal(rate.tax.value, 1.65, `tax ${rate.tax.value}`);
  assert.equal(rate.amount.value, 21.65, `amount ${rate.amount.value}`);

  // Keyword-less rate line: the chosen hit itself is percent-suffixed.
  const pct = parseReceipt(
    ocr(["GAS N GO", "TAX 8.25%", "SUBTOTAL 20.00", "SALES TAX 1.65", "TOTAL 21.65"]),
  );
  assert.equal(pct.tax.value, 1.65, `tax ${pct.tax.value}`);

  // A rate sharing the line with the amount still donates the AMOUNT.
  const inline = parseReceipt(
    ocr(["SHOPPE", "SUBTOTAL 42.00", "GST 5%: 2.10", "TOTAL 44.10"]),
  );
  assert.equal(inline.tax.value, 2.1, `tax ${inline.tax.value}`);
});

test("a garbled tax larger than the subtotal never rewrites the total", () => {
  const r = parseReceipt(ocr(["SHOP", "SUBTOTAL 40.00", "TAX 289.00", "TOTAL 43.20"]));
  assert.equal(r.amount.value, 43.2, `amount ${r.amount.value}`);
  assert.equal(r.tax.value, 0, "implausible tax is dropped");
});

test("label-only TOTAL never grabs a tender/change line below it", () => {
  const r = parseReceipt(
    ocr(["CORNER MARKET", "Item 12.99", "TOTAL", "CASH 20.00", "CHANGE 7.01", "05/01/2026"]),
  );
  assert.equal(r.amount.value, 12.99, `amount ${r.amount.value}`);
});

function lines2(texts: string[]): OcrLine[] {
  return texts.map((text, i) => ({
    text,
    confidence: 88,
    bbox: { x: 0, y: i / texts.length, w: 1, h: 1 / texts.length },
    words: [],
  }));
}

test("readValueInBox reads the OCR lines under a hand-drawn box", () => {
  const lines = [
    { text: "JOES DINER", confidence: 0.9, bbox: { x: 0.2, y: 0.05, w: 0.6, h: 0.04 }, words: [] },
    { text: "Date: 05/10/2026", confidence: 0.9, bbox: { x: 0.1, y: 0.4, w: 0.5, h: 0.03 }, words: [] },
    { text: "TOTAL   $24.11", confidence: 0.9, bbox: { x: 0.1, y: 0.6, w: 0.8, h: 0.03 }, words: [] },
  ];
  assert.equal(readValueInBox(lines, "vendor", { x: 0.1, y: 0.02, w: 0.8, h: 0.1 }), "JOES DINER");
  assert.equal(readValueInBox(lines, "date", { x: 0, y: 0.36, w: 1, h: 0.1 }), "2026-05-10");
  assert.equal(readValueInBox(lines, "amount", { x: 0, y: 0.56, w: 1, h: 0.1 }), 24.11);
  // A box over empty space autofills nothing (the box itself still stands).
  assert.equal(readValueInBox(lines, "amount", { x: 0, y: 0.85, w: 1, h: 0.1 }), null);
});

// ── Audit round (2026-09): silent-wrong-money and vendor-hijack regressions ───
import { matchKnownVendor } from "../src/pipeline/extract.ts";

test("a garbled tax below the subtotal never rewrites a printed total to subtotal + tax", () => {
  for (const tail of [["TOTAL 45.46", "VISA 45.46"], ["TOTAL 45.46"]]) {
    const r = parseReceipt(
      ocr(["ACE HARDWARE", "SCREWS 42.00", "SUBTOTAL 42.00", "TAX 34.60", ...tail]),
    );
    assert.equal(r.amount.value, 45.46, `amount ${r.amount.value}`);
    assert.ok(
      r.flags.some((f) => f.code === "total_suspect" && f.severity === "warn"),
      JSON.stringify(r.flags),
    );
    assert.ok(forcesManualReview(r.flags));
  }
  // A misread SUBTOTAL is the same class (it used to become $7.66 silently).
  const sub = parseReceipt(ocr(["SHOP", "SCREWS 42.00", "SUBTOTAL 4.20", "TAX 3.46", "TOTAL 45.46"]));
  assert.equal(sub.amount.value, 45.46);
  assert.ok(forcesManualReview(sub.flags));
  // A legitimately high tax (60%) is left alone.
  const legit = parseReceipt(ocr(["SHOP", "SUBTOTAL 100.00", "TAX 60.00", "TOTAL 160.00"]));
  assert.equal(legit.amount.value, 160);
  assert.equal(forcesManualReview(legit.flags), false);
});

test("fuzzy header hits: only merchant-shaped lines feed the sweep, keywords beat an edited brand", () => {
  const w = parseReceipt(
    ocr(["WINTZELL'S OYSTER HOUSE", "605 DAUPHIN ST", "MOBILE, AL 36602", "08/20/2026", "TOTAL 41.50"]),
  );
  assert.match(w.vendor.value, /WINTZELL/);
  const d = parseReceipt(ocr(["CITY OF DENVER", "PUBLIC PARKING", "08/20/2026", "TOTAL 8.00"]));
  assert.match(d.vendor.value, /DENVER/);
  assert.equal(d.category.value, "Ground Transportation");
  const c = parseReceipt(
    ocr(["CORNER CAFE", "123 MAIN", "08/20/2026", "BLACK COFFEE 2.50", "TOTAL 2.50"]),
  );
  assert.match(c.vendor.value, /CORNER CAFE/);
  assert.equal(c.category.value, "Meals");
  const b = parseReceipt(ocr(["BLACKWATER GRILL", "123 MAIN", "MILTON, FL 32570", "TOTAL 20.00"]));
  assert.match(b.vendor.value, /BLACKWATER/);
  assert.equal(b.category.value, "Meals");
  // The pinned garbles still resolve.
  assert.equal(
    parseReceipt(ocr(["WELC0ME TO", "MOBTL", "GALLONS 10.000", "PRICE/GAL 4.000", "TOTAL 40.00"])).vendor.value,
    "Mobil",
  );
  assert.equal(parseReceipt(ocr(["CTATER BROS", "TOTAL 40.00"])).vendor.value, "Stater Bros. Markets");
  assert.equal(parseReceipt(ocr(["FARMER 80YS", "TOTAL 12.00"])).vendor.value, "Farmer Boys");
});

test("a known non-fuel brand files as Fuel only when pump math verifies", () => {
  const costco = parseReceipt(
    ocr(["COSTCO WHOLESALE", "#1234 GAS STATION", "REGULAR", "GALLONS 12.345", "PRICE/GAL 3.899", "FUEL TOTAL 48.13"]),
  );
  assert.equal(costco.vendor.value, "Costco");
  assert.equal(costco.category.value, "Fuel");
  const paint = parseReceipt(
    ocr(["THE HOME DEPOT", "BEHR PAINT 5 GAL 149.00", "PRICE PER GALLON 29.80", "TOTAL 160.92"]),
  );
  assert.equal(paint.category.value, "Materials");
});

test("ordinary receipt words one edit from a short brand alias never rename the vendor", () => {
  const gloves = parseReceipt(ocr(["ABC INDUSTRIAL", "VERNON, CA 90058", "GLOVES NITRILE 12.99", "TOTAL 12.99"]));
  assert.notEqual(gloves.vendor.value, "Love's");
  assert.notEqual(gloves.category.value, "Fuel");
  const marco = parseReceipt(ocr(["MARCO ISLAND GRILL", "MARCO ISLAND FL", "TOTAL 20.00"]));
  assert.match(marco.vendor.value, /MARCO ISLAND GRILL/);
  assert.equal(marco.category.value, "Meals");
  assert.notEqual(parseReceipt(ocr(["ACME PAINT", "LOWEST PRICE GUARANTEE", "TOTAL 20.00"])).vendor.value, "Lowe's");
  const petro = parseReceipt(
    ocr(["PETRO", "TRUCK STOP", "GALLONS 80.000", "PRICE/GAL 3.899", "FUEL TOTAL 311.92"]),
  );
  assert.equal(petro.vendor.value, "Petro Stopping Centers");
  assert.equal(petro.category.value, "Fuel");
  const diner = parseReceipt(ocr(["JOES DINER", "REWARDS MEMBER #1234", "TOTAL 12.00"]));
  assert.equal(diner.vendor.value, "JOES DINER");
  assert.equal(diner.category.value, "Meals");
  const welding = parseReceipt(ocr(["MOBILE WELDING SUPPLY", "TOTAL 12.00"]));
  assert.equal(welding.vendor.value, "MOBILE WELDING SUPPLY");
  assert.equal(welding.category.value, "Materials");
});

test("a SUPER fuel-grade line never becomes Super 8, and pump structure still files as Fuel", () => {
  const r = parseReceipt(
    ocr(["JOE'S GAS", "SUPER 93 OCTANE", "GALLONS 10.000", "PRICE/GAL 4.199", "TOTAL 41.99"]),
  );
  assert.equal(r.vendor.value, "JOE'S GAS");
  assert.equal(r.category.value, "Fuel");
});

test("generic brand words on address, tender, footer, staff and item lines don't name the merchant", () => {
  const cases: [string[], RegExp][] = [
    [["CORNER CAFE", "123 MAIN ST", "THANK YOU! REVIEW US ON GOOGLE", "TOTAL 5.00"], /CORNER CAFE/],
    [["JOES DINER", "Burger 22.00", "TOTAL 24.05", "PAID WITH GOOGLE PAY"], /JOES DINER/],
    [["SUNSET DINER", "6000 GULF BLVD", "TOTAL 12.00"], /SUNSET DINER/],
    [["VINE BAR", "NAPA, CA 94559", "TOTAL 40.00"], /VINE BAR/],
    [["SALTY DOG CAFE", "HILTON HEAD ISLAND, SC", "TOTAL 40.00"], /SALTY DOG/],
    [["KEYS FISHERIES", "MARATHON, FL 33050", "TOTAL 40.00"], /KEYS FISHERIES/],
    [["TUCSON TACOS", "2545 E SPEEDWAY BLVD, TUCSON", "TOTAL 12.00"], /TUCSON TACOS/],
    [["JOES SHOP", "123 COURTYARD DR", "TOTAL 12.00"], /JOES SHOP/],
    [["JOES SHOP", "RACETRACK RD", "TOTAL 12.00"], /JOES SHOP/],
    [["JOES DINER", "YOUR SERVER WAS CASEY", "TOTAL 12.00"], /JOES DINER/],
    [["MURPHY'S PUB & GRILL", "TOTAL 12.00"], /MURPHY'S PUB/],
    [["TACO SPOT", "HARD SHELL TACO 3.50", "TOTAL 3.50"], /TACO SPOT/],
    [["JOES AUTO", "MOBIL 1 5W-30 QT 9.99", "TOTAL 9.99"], /JOES AUTO/],
    [["JOES OFFICE", "PILOT G2 PENS 4.99", "TOTAL 4.99"], /JOES OFFICE/],
    [["ADOBE GRILL, SANTA FE", "TOTAL 40.00"], /ADOBE GRILL/],
  ];
  for (const [lines, want] of cases) {
    const r = parseReceipt(ocr(lines));
    assert.match(r.vendor.value, want, `${lines.join(" | ")} → ${r.vendor.value}`);
  }
  // …while distinctive aliases, slogans and generic words on real header
  // lines still name the brand.
  const keep: [string[], string][] = [
    [["SHELL", "123 MAIN ST", "TOTAL 40.00"], "Shell"],
    [["ITEM 1.00", "TOTAL 1.00", "THANK YOU FOR SHOPPING AT WALMART"], "Walmart"],
    [["A", "B", "C", "D", "E", "F", "G", "H", "STARBUCKS.COM", "TOTAL 4.00"], "Starbucks"],
    [["SPEEDWAY #4321", "2545 E SPEEDWAY BLVD", "TOTAL 40.00"], "Speedway"],
    [["HILTON GARDEN INN", "TOTAL 140.00"], "Hilton"],
    [["Google LLC", "Google Workspace", "TOTAL 14.00"], "Google"],
    [["Adobe Inc.", "Creative Cloud", "TOTAL 54.99"], "Adobe"],
    [["How doers get more done.", "1234 CONTRACTOR BLVD", "TOTAL 88.12"], "The Home Depot"],
  ];
  for (const [lines, want] of keep) {
    assert.equal(parseReceipt(ocr(lines)).vendor.value, want, lines.join(" | "));
  }
  // The pipeline's logo-gate call uses the same scoped scan.
  const o = ocr(["SUNSET DINER", "6000 GULF BLVD", "TOTAL 12.00"]);
  assert.equal(matchKnownVendor(o.lines, o.text), null);
});

test("a total below the printed subtotal with nothing explaining it demands review", () => {
  const r = parseReceipt(
    ocr(["BLUE BOTTLE COFFEE", "Date: 03/14/2026", "Latte 4.50", "Muffin 3.75", "Bagel 13.75", "SUBTOTAL 22.00", "XAX 1.76", "GRAND TOTAL 4.05", "VISA 24.05"]),
  );
  assert.equal(r.amount.value, 4.05);
  assert.ok(r.flags.some((f) => f.code === "total_suspect" && f.severity === "warn"));
  assert.ok(forcesManualReview(r.flags));
  const coupon = parseReceipt(ocr(["SHOP", "SUBTOTAL 20.00", "COUPON -5.00", "TOTAL 15.00", "VISA 15.00"]));
  assert.equal(coupon.amount.value, 15);
  assert.equal(forcesManualReview(coupon.flags), false);
  const exempt = parseReceipt(ocr(["SHOP", "SUBTOTAL 20.00", "TOTAL 20.00"]));
  assert.equal(forcesManualReview(exempt.flags), false);
});

test("a wallet tender line never renames the merchant", () => {
  const r = parseReceipt(
    ocr(["JOES DINER", "123 Main St", "Date: 03/14/2026", "Burger 22.00", "TOTAL 24.05", "GOOGLE PAY 24.05"]),
  );
  assert.equal(r.vendor.value, "JOES DINER");
  assert.equal(r.category.value, "Meals");
  const lumber = parseReceipt(ocr(["ACME SUPPLY", "Invoice #123", "Lumber 400.00", "TOTAL 400.00"]));
  assert.notEqual(lumber.vendor.value, "84 Lumber");
});

test("a merchant header containing 'total' never donates its store number as the amount", () => {
  const r = parseReceipt(
    ocr(["TOTAL WINE & MORE #1234", "123 Main St", "Date: 03/14/2026", "Cabernet 45.99", "TOTAL 49.67", "VISA 49.67"]),
  );
  assert.equal(r.amount.value, 49.67, `amount ${r.amount.value}`);
  assert.equal(r.vendor.value, "TOTAL WINE & MORE");
  const noHash = parseReceipt(ocr(["TOTAL WINE & MORE STORE 1234", "Cabernet 45.99", "TOTAL", "$49.67"]));
  assert.equal(noHash.amount.value, 49.67);
  // The lenient integer read on a real label+value line survives, garbled label included.
  assert.equal(parseReceipt(ocr(["SHOP", "T0TAL 10", "05/01/2026"])).amount.value, 10);
});

test("pre-discount MERCHANDISE TOTAL / TOTAL BEFORE COUPONS never beat the real TOTAL", () => {
  for (const pre of ["MERCHANDISE TOTAL 60.00", "TOTAL BEFORE COUPONS 60.00", "ORIGINAL TOTAL 60.00"]) {
    const r = parseReceipt(
      ocr(["KOHLS", "Date: 03/14/2026", "SHIRT 60.00", pre, "COUPON -10.00", "TOTAL 50.00", "VISA 50.00"]),
    );
    assert.equal(r.amount.value, 50, pre);
  }
  const c = parseReceipt(ocr(["SHOP", "ITEM 12.00", "TOTAL COUPONS 10.00", "TOTAL 2.00", "CASH 2.00"]));
  assert.equal(c.amount.value, 2);
});

test("a no-tax window recovery equal to the subtotal gates review; one above it stays advisory", () => {
  const garble = parseReceipt(
    ocr(["BLUE BOTTLE COFFEE", "Date: 03/14/2026", "Widget 20.00", "SUBTOTAL 20.00", "XAX 1.60", "TOTAL 2160", "VISA 21.60"]),
  );
  assert.equal(garble.amount.value, 20);
  assert.ok(garble.flags.some((f) => f.code === "total_suspect" && f.severity === "warn"));
  assert.ok(forcesManualReview(garble.flags));
  const above = parseReceipt(
    ocr(["SHOP", "Widget 20.00", "SUBTOTAL 20.00", "XAX 1.60", "AMOUNT 21.60", "TOTAL 2160"]),
  );
  assert.equal(above.amount.value, 21.6);
  assert.equal(forcesManualReview(above.flags), false);
});

test("a multi-word city + state line inside an address block never becomes the vendor", () => {
  const multi = parseReceipt(
    ocr(["", "1200 N Main St", "SANTA ANA CA", "92701", "DATE 9/23/24", "Item 12.00", "TOTAL 12.00"]),
  );
  assert.notEqual(multi.vendor.value, "SANTA ANA CA");
  const zipBelow = parseReceipt(ocr(["", "SAN DIEGO CA", "92101", "TOTAL 12.00"]));
  assert.notEqual(zipBelow.vendor.value, "SAN DIEGO CA");
  assert.equal(parseReceipt(ocr(["GRILL IN LA", "TOTAL 12.00"])).vendor.value, "GRILL IN LA");
  assert.equal(parseReceipt(ocr(["SMITH SUPPLY CO", "Anaheim CA", "TOTAL 12.00"])).vendor.value, "SMITH SUPPLY CO");
});

test("a line that IS a date or timestamp never becomes the vendor", () => {
  const r = parseReceipt(
    ocr(["", "WED SEPTEMBER 11, 2024 12:30 PM", "CHECK #606564-1", "1 BIG CHEESE CMB $12.49", "TOTAL $12.49"]),
  );
  assert.equal(r.vendor.value, "");
  assert.ok(r.flags.some((f) => f.code === "no_vendor"));
  assert.equal(r.date.value, "2024-09-11");
  const named = parseReceipt(ocr(["JOE'S DINER", "WED SEPTEMBER 11, 2024 12:30 PM", "TOTAL $12.49"]));
  assert.equal(named.vendor.value, "JOE'S DINER");
  assert.notEqual(
    parseReceipt(ocr(["SHOP", "TUE SEP 11 12:30 PM", "TOTAL 12.00"])).vendor.value,
    "TUE SEP 11 12:30 PM",
  );
});

test("refund/return totals keep their magnitude and demand review", () => {
  const cases = [
    ["THE HOME DEPOT", "RETURN", "SUBTOTAL -99.00", "SALES TAX -8.17", "TOTAL -107.17", "REFUND TO AMEX 107.17"],
    ["SHOP", "TOTAL -12.00"],
    ["SHOP", "TOTAL 12.00-"],
    ["SHOP", "TOTAL 12.00 CR"],
    ["SHOP", "TOTAL (12.00)"],
    ["SHOP", "REFUND TOTAL 12.00"],
  ];
  for (const lines of cases) {
    const r = parseReceipt(ocr(lines));
    assert.ok(r.amount.value > 0, lines.join(" | "));
    assert.ok(
      r.flags.some((f) => f.code === "total_suspect" && f.severity === "warn"),
      lines.join(" | "),
    );
    assert.ok(forcesManualReview(r.flags), lines.join(" | "));
  }
  assert.equal(parseReceipt(ocr(cases[0]!)).amount.value, 107.17);
  const controls = [
    ["SHOP", "ITEM 12.00", "TOTAL 12.00", "RETURN POLICY DEFINITIONS"],
    ["SHOP", "ITEM 10.64", "COUPON -2.00", "TOTAL 8.64"],
    ["SHOP", "TOTAL 12.00 CREDIT CARD"],
    ["SHOP", "TOTAL 12.00 (2 items)"],
  ];
  for (const lines of controls) {
    const r = parseReceipt(ocr(lines));
    assert.equal(r.flags.some((f) => f.code === "total_suspect"), false, lines.join(" | "));
    assert.equal(forcesManualReview(r.flags), false, lines.join(" | "));
  }
});

test("component tax lines sum when the footing corroborates them; TOTAL TAX wins outright", () => {
  const printed = parseReceipt(
    ocr(["OFFICE DEPOT", "Date: 03/14/2026", "SUBTOTAL 100.00", "STATE TAX 6.00", "COUNTY TAX 1.00", "CITY TAX 1.25", "TOTAL TAX 8.25", "TOTAL 108.25", "VISA 108.25"]),
  );
  assert.equal(printed.tax.value, 8.25);
  assert.equal(printed.flags.some((f) => f.code === "total_mismatch"), false);
  assert.ok(printed.confidence >= 0.8, `confidence ${printed.confidence}`);
  const summed = parseReceipt(
    ocr(["OFFICE DEPOT", "Date: 03/14/2026", "SUBTOTAL 100.00", "STATE TAX 6.00", "COUNTY TAX 1.00", "CITY TAX 1.25", "TOTAL 108.25", "VISA 108.25"]),
  );
  assert.equal(summed.tax.value, 8.25);
  const walmart = parseReceipt(
    ocr(["WALMART", "SUBTOTAL 30.00", "TAX 1 7.000 % 2.10", "TAX 2 2.000 % 0.30", "TOTAL 32.40"]),
  );
  assert.equal(walmart.tax.value, 2.4);
  // A duplicated customer/merchant copy must not double the tax.
  const dup = parseReceipt(
    ocr(["OFFICE DEPOT", "SUBTOTAL 100.00", "TAX 8.25", "TOTAL 108.25", "SUBTOTAL 100.00", "TAX 8.25", "TOTAL 108.25"]),
  );
  assert.equal(dup.tax.value, 8.25);
});

test("a clock time never donates its hour as the year of a month-name date", () => {
  const r = parseReceipt(ocr(["SHOP", "TUE SEP 11 12:30 PM", "TOTAL 12.00"]));
  assert.equal(r.date.value, "");
  assert.ok(r.flags.some((f) => f.code === "no_date"));
  // ctime order recovers the trailing year.
  assert.equal(parseReceipt(ocr(["SHOP", "Wed Sep 11 12:30:45 PDT 2024", "TOTAL 12.00"])).date.value, "2024-09-11");
  assert.equal(parseReceipt(ocr(["SHOP", "WEL SEPTEMBER 11.2024", "TOTAL 12.00"])).date.value, "2024-09-11");
});

test("Due Date printed above Invoice Date never becomes the expense date", () => {
  const r = parseReceipt(
    ocr(["ACME SUPPLY", "Invoice #123", "Due Date: 04/15/2026", "Invoice Date: 03/14/2026", "Lumber 400.00", "TOTAL 500.00"]),
  );
  assert.equal(r.date.value, "2026-03-14");
  // A labeled deadline also ranks below an unlabeled printed date…
  const bare = parseReceipt(ocr(["ACME SUPPLY", "03/14/2026", "Due Date: 04/15/2026", "TOTAL 500.00"]));
  assert.equal(bare.date.value, "2026-03-14");
  // …but still dates the receipt when it is the only date on it.
  const only = parseReceipt(ocr(["ACME SUPPLY", "Due Date: 04/15/2026", "TOTAL 500.00"]));
  assert.equal(only.date.value, "2026-04-15");
});

test("trailing store numbers are dropped from heuristic vendor names; bare digits stay", () => {
  assert.equal(parseReceipt(ocr(["PRICE CHOPPER #123", "GALLONS 5.000", "TOTAL 20.00"])).vendor.value, "PRICE CHOPPER");
  assert.equal(parseReceipt(ocr(["TOTAL WINE & MORE #1234", "TOTAL 20.00"])).vendor.value, "TOTAL WINE & MORE");
  assert.equal(parseReceipt(ocr(["STUDIO 54", "TOTAL 20.00"])).vendor.value, "STUDIO 54");
});

test("locateValue/readValueInBox read a bare-integer labeled total the way findAmount does", () => {
  const lines = ocr(["SHOP", "TOTAL 9", "05/01/2026"]).lines;
  assert.equal(locateValue(lines, "amount", 9)?.lineText, "TOTAL 9");
  assert.equal(locateValue(ocr(["Total: 12"]).lines, "amount", 12)?.lineText, "Total: 12");
  assert.equal(locateValue(lines, "amount", 2026), null);
  assert.equal(locateValue(ocr(["TOTAL ITEMS 3"]).lines, "amount", 3), null);
  assert.equal(locateValue(ocr(["Item 9"]).lines, "amount", 9), null);
  assert.equal(readValueInBox(lines, "amount", { x: 0, y: 0, w: 1, h: 1 }), 9);
  assert.equal(readValueInBox(ocr(["TOTAL   $24.11"]).lines, "amount", { x: 0, y: 0, w: 1, h: 1 }), 24.11);
});

test("a garbled tax at or above the total is dropped even with no subtotal printed", () => {
  const r = parseReceipt(ocr(["SHOP", "Date: 03/14/2026", "TAX 289.00", "TOTAL 43.20"]));
  assert.equal(r.amount.value, 43.2);
  assert.equal(r.tax.value, 0, "implausible tax is dropped");
  const fuel = parseReceipt(
    ocr(["SHELL", "03/14/2026", "GALLONS 10.000", "PRICE/GAL 4.320", "TAX 289.00", "FUEL TOTAL 43.20"]),
  );
  assert.equal(fuel.amount.value, 43.2);
  assert.equal(fuel.tax.value, 0, "pump-verified total still sheds the garbled tax");
});
