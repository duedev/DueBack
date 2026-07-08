import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCorrectionRecords } from "../src/train/corrections.ts";
import { locateValue } from "../src/pipeline/extract.ts";
import type { Receipt, OcrLine } from "../src/types.ts";

function lines(texts: string[]): OcrLine[] {
  return texts.map((text, i) => ({
    text,
    confidence: 90,
    bbox: { x: 0, y: i / texts.length, w: 1, h: 1 / texts.length },
    words: [],
  }));
}

function receipt(): Receipt {
  const now = 1_700_000_000_000;
  return {
    id: "r1",
    batchId: "b1",
    fileKey: "k",
    fileName: "fuel_12-27-22_mobil.jpg",
    mimeType: "image/jpeg",
    status: "needs_review",
    vendor: { value: "nob", confidence: 0.5 },
    date: { value: "", confidence: 0 },
    amount: { value: 3186, confidence: 0.6 },
    tax: { value: 0, confidence: 0 },
    currency: "USD",
    category: { value: "Other", confidence: 0.4 },
    confidence: 0.55,
    flags: [],
    methodUsed: "rules",
    cost: 0,
    approved: false,
    reviewRequired: true,
    createdAt: now,
    updatedAt: now,
  };
}

const OCR = lines([
  "WELCOME TO",
  "MOBIL",
  "DATE 12/27/22 6:38",
  "GALLONS: 6.927",
  "FUEL SALE $31.86",
  "CREDIT $31.86",
]);

test("locateValue finds a corrected amount, vendor and date on the receipt", () => {
  const amt = locateValue(OCR, "amount", 31.86);
  assert.ok(amt, "amount located");
  assert.match(amt!.lineText, /FUEL SALE/); // non-payment line preferred
  const ven = locateValue(OCR, "vendor", "Mobil");
  assert.ok(ven && /MOBIL/.test(ven.lineText));
  const dt = locateValue(OCR, "date", "2022-12-27");
  assert.ok(dt && /12\/27\/22/.test(dt.lineText));
  assert.equal(locateValue(OCR, "amount", 999.99), null);
});

test("buildCorrectionRecords diffs a review patch with located provenance", () => {
  const before = receipt();
  const records = buildCorrectionRecords(
    before,
    {
      vendor: { value: "Mobil", confidence: 1, edited: true },
      date: { value: "2022-12-27", confidence: 1, edited: true },
      amount: { value: 31.86, confidence: 1, edited: true },
      category: { value: "Fuel", confidence: 1, edited: true },
    },
    OCR,
    123,
  );
  assert.equal(records.length, 4);
  const byField = Object.fromEntries(records.map((r) => [r.field, r]));
  assert.equal(byField.vendor!.from, "nob");
  assert.equal(byField.vendor!.to, "Mobil");
  assert.ok(byField.vendor!.located && byField.vendor!.bbox);
  assert.ok(byField.amount!.located && /FUEL SALE/.test(byField.amount!.lineText ?? ""));
  assert.ok(byField.date!.located);
  assert.equal(byField.category!.located, false); // categories aren't printed
  assert.ok(records.every((r) => r.ts === 123 && r.receiptId === "r1"));
});

test("unchanged fields produce no correction records", () => {
  const before = receipt();
  const records = buildCorrectionRecords(
    before,
    { vendor: { value: "nob", confidence: 1, edited: true } },
    OCR,
  );
  assert.equal(records.length, 0);
});
