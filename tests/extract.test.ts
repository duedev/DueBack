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
  assert.equal(r.category.value, "Meals & Entertainment");
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
