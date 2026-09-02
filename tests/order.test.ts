import { test } from "node:test";
import assert from "node:assert/strict";
import {
  byReportOrder,
  displayCategory,
  exportableReceipts,
  reportOrder,
} from "../src/export/order.ts";
import type { Receipt, Category } from "../src/types.ts";

// One report order for the workbook, the CSV and the print packet: date,
// then intake order, then id — a total order, so two same-day receipts can't
// land as "#2" in one artifact and "#3" in another.

function receipt(f: {
  id: string;
  vendor: string;
  amount: number;
  category: Category;
  date: string;
  createdAt?: number;
  status?: Receipt["status"];
}): Receipt {
  return {
    id: f.id,
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
    createdAt: f.createdAt ?? 1000,
    updatedAt: 1000,
  };
}

test("same-day receipts order by intake, then id — never engine-dependent", () => {
  const later = receipt({ id: "b", vendor: "Shell", amount: 40, category: "Fuel", date: "2026-05-01", createdAt: 2000 });
  const earlier = receipt({ id: "a", vendor: "Chevron", amount: 30, category: "Fuel", date: "2026-05-01", createdAt: 1000 });
  const tieB = receipt({ id: "z", vendor: "Exxon", amount: 20, category: "Fuel", date: "2026-05-01", createdAt: 1000 });
  const sorted = exportableReceipts([later, tieB, earlier]);
  assert.deepEqual(sorted.map((r) => r.id), ["a", "z", "b"]);
  // Antisymmetric and reflexive, as a comparator must be.
  assert.equal(byReportOrder(earlier, later), -byReportOrder(later, earlier));
  assert.equal(byReportOrder(earlier, earlier), 0);
});

test("exportableReceipts drops failed and zero-amount rows; reportOrder groups in taxonomy order", () => {
  const rows = [
    receipt({ id: "1", vendor: "Uber", amount: 23, category: "Ground Transportation", date: "2026-01-06" }),
    receipt({ id: "2", vendor: "Shell", amount: 45, category: "Fuel", date: "2026-01-07" }),
    receipt({ id: "3", vendor: "Broken", amount: 0, category: "Fuel", date: "2026-01-01" }),
    receipt({ id: "4", vendor: "Dead", amount: 9, category: "Fuel", date: "2026-01-01", status: "failed" }),
    receipt({ id: "5", vendor: "Chevron", amount: 30, category: "Fuel", date: "2026-01-02" }),
  ];
  const groups = reportOrder(rows);
  assert.deepEqual(groups.map((g) => g.cat), ["Fuel", "Ground Transportation"]);
  assert.deepEqual(groups[0]!.rows.map((r) => r.id), ["5", "2"]); // Chevron is Fuel #1
  assert.equal(displayCategory("Other"), "Miscellaneous");
  assert.equal(displayCategory("Fuel"), "Fuel");
});
