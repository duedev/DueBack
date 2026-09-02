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

import { mergeCorrections, type CorrectionRecord } from "../src/train/corrections.ts";

function rec(field: CorrectionRecord["field"], from: string | number, to: string | number): CorrectionRecord {
  return {
    ts: 1, receiptId: "r1", fileName: "f.jpg", field, from, to,
    located: false, confidence: 0.5, method: "rules",
  };
}

test("mergeCorrections collapses typing churn into one original→final record", () => {
  // The date input fires a change per typed segment.
  let log: CorrectionRecord[] = [];
  for (const [from, to] of [
    ["", "0002-09-11"], ["0002-09-11", "0020-09-11"],
    ["0020-09-11", "0202-09-11"], ["0202-09-11", "2024-09-11"],
  ] as const) {
    log = mergeCorrections(log, [rec("date", from, to)]);
  }
  assert.equal(log.length, 1);
  assert.equal(log[0]!.from, "");
  assert.equal(log[0]!.to, "2024-09-11");
});

test("mergeCorrections drops a correction reverted to the original", () => {
  let log = mergeCorrections([], [rec("vendor", "nob", "Mobil")]);
  log = mergeCorrections(log, [rec("vendor", "Mobil", "Mob il")]);
  log = mergeCorrections(log, [rec("vendor", "Mob il", "Mobil")]);
  assert.equal(log.length, 1);
  assert.deepEqual([log[0]!.from, log[0]!.to], ["nob", "Mobil"]);
  // …and a full revert to the very first value vanishes.
  log = mergeCorrections(log, [rec("vendor", "Mobil", "nob")]);
  assert.equal(log.length, 0);
});

test("mergeCorrections keeps unrelated corrections separate", () => {
  let log = mergeCorrections([], [rec("vendor", "nob", "Mobil")]);
  log = mergeCorrections(log, [rec("amount", 2819.28, 248.81)]);
  assert.equal(log.length, 2);
});

test("locateValue's vendor probe is word-bounded and never a stopword", () => {
  const hd = lines(["THE HOME DEPOT", "1005-667-380 2 YR REPLACE <A,U> 12.00", "TOTAL 12.00"]);
  assert.equal(locateValue(hd, "vendor", "Ace Hardware"), null);
  assert.equal(locateValue(lines(["OTHER STORE", "THERMAL PAPER 5.00"]), "vendor", "The UPS Store"), null);
  assert.equal(locateValue(lines(["7-ELEUEN", "TOTAL 5.00"]), "vendor", "7-Eleven")?.lineText, "7-ELEUEN");
  assert.equal(locateValue(lines(["WELCOME", "MOBIL", "TOTAL 5.00"]), "vendor", "Mobil")?.lineText, "MOBIL");
});
