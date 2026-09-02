import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv, toCsvBytes, csvFileName } from "../src/export/csv.ts";
import type { Receipt, Category } from "../src/types.ts";

function receipt(f: {
  vendor: string;
  amount: number;
  category: Category;
  date: string;
  status?: Receipt["status"];
}): Receipt {
  const now = Date.now();
  return {
    id: Math.random().toString(36).slice(2),
    batchId: "b1",
    fileKey: "k",
    fileName: "r.jpg",
    mimeType: "image/jpeg",
    status: f.status ?? "done",
    vendor: { value: f.vendor, confidence: 0.9 },
    date: { value: f.date, confidence: 0.9 },
    amount: { value: f.amount, confidence: 0.9 },
    tax: { value: 0, confidence: 0.8 },
    currency: "USD",
    category: { value: f.category, confidence: 0.9 },
    confidence: 0.9,
    flags: [],
    methodUsed: "rules",
    cost: 0,
    approved: true,
    reviewRequired: false,
    createdAt: now,
    updatedAt: now,
  };
}

test("CSV has the expected header and is sorted by date", () => {
  const csv = toCsv([
    receipt({ vendor: "Home Depot", amount: 120, category: "Office Supplies", date: "2026-05-02" }),
    receipt({ vendor: "Shell", amount: 45.2, category: "Fuel", date: "2026-05-01" }),
  ]);
  const rows = csv.split("\r\n");
  assert.equal(rows[0], "Category,Date,Vendor,Amount,Currency,Confidence,Status,Notes");
  // Shell (05-01) sorts before Home Depot (05-02).
  assert.ok(rows[1]!.startsWith("Fuel,2026-05-01,Shell,45.20,"));
});

test("fields with commas and quotes are RFC-4180 escaped", () => {
  const csv = toCsv([
    receipt({ vendor: 'Butch\'s, "Grinders"', amount: 18.5, category: "Meals", date: "2026-05-02" }),
  ]);
  // The vendor, containing a comma and quotes, is wrapped and inner-quotes doubled.
  assert.ok(csv.includes('"Butch\'s, ""Grinders"""'));
  // Round-trips to exactly one data row + header.
  assert.equal(csv.split("\r\n").length, 2);
});

test("failed and zero-amount receipts are excluded", () => {
  const csv = toCsv([
    receipt({ vendor: "Shell", amount: 45.2, category: "Fuel", date: "2026-05-01" }),
    receipt({ vendor: "Bad", amount: 0, category: "Other", date: "2026-05-02" }),
    receipt({ vendor: "Broke", amount: 10, category: "Other", date: "2026-05-03", status: "failed" }),
  ]);
  assert.equal(csv.split("\r\n").length, 2); // header + Shell only
});

test("the Currency column is pinned to USD, even for legacy stored codes", () => {
  // A pre-USD-only build could store e.g. "EUR"; the CSV must still agree
  // with the workbook, which always renders $.
  const legacy = receipt({ vendor: "Cafe Berlin", amount: 19.9, category: "Meals", date: "2026-03-14" });
  legacy.currency = "EUR";
  const csv = toCsv([legacy]);
  assert.ok(csv.split("\r\n")[1]!.includes(",19.90,USD,"));
});

test("csvFileName is sanitized and dated", () => {
  assert.match(csvFileName({ jobName: "Q1 Travel" }), /^Q1_Travel_\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(csvFileName({}), /^reimbursement_\d{4}-\d{2}-\d{2}\.csv$/);
});

test("toCsvBytes is UTF-8 with a BOM, wrapping exactly toCsv", () => {
  const r = receipt({ vendor: "Café — Olé", amount: 9, category: "Meals", date: "2026-05-02" });
  const bytes = toCsvBytes([r]);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  // TextDecoder strips the BOM by default.
  assert.equal(new TextDecoder().decode(bytes), toCsv([r]));
  assert.deepEqual([...toCsvBytes([]).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test("a vendor that reads as a formula is neutralised with a leading apostrophe", () => {
  const csv = toCsv([
    receipt({ vendor: '=HYPERLINK("http://x","y")', amount: 5, category: "Other", date: "2026-05-02" }),
    receipt({ vendor: "-SHELL", amount: 5, category: "Fuel", date: "2026-05-01" }),
  ]);
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"",""y"")"`), csv);
  assert.ok(csv.includes(",'-SHELL,"), csv);
});

test("same-day receipts keep intake order (the workbook's order)", () => {
  const a = receipt({ vendor: "Second", amount: 5, category: "Fuel", date: "2026-05-01" });
  const b = receipt({ vendor: "First", amount: 5, category: "Fuel", date: "2026-05-01" });
  a.createdAt = 2000;
  b.createdAt = 1000;
  const rows = toCsv([a, b]).split("\r\n");
  assert.ok(rows[1]!.includes(",First,"), rows.join(" | "));
  assert.ok(rows[2]!.includes(",Second,"), rows.join(" | "));
});
