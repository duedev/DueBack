import { test } from "node:test";
import assert from "node:assert/strict";
import { computeInsights, shareSlices } from "../src/export/insights.ts";
import type { Receipt, Category } from "../src/types.ts";

function receipt(f: {
  vendor: string;
  amount: number;
  category: Category;
  date: string;
  tax?: number;
  flagged?: boolean;
}): Receipt {
  const now = Date.now();
  return {
    id: Math.random().toString(36).slice(2),
    batchId: "b1",
    fileKey: "k",
    fileName: "r.jpg",
    mimeType: "image/jpeg",
    status: "done",
    vendor: { value: f.vendor, confidence: 0.9 },
    date: { value: f.date, confidence: 0.9 },
    amount: { value: f.amount, confidence: 0.9 },
    tax: { value: f.tax ?? 0, confidence: 0.8 },
    currency: "USD",
    category: { value: f.category, confidence: 0.9 },
    confidence: 0.9,
    flags: [],
    methodUsed: "rules",
    cost: 0,
    approved: !f.flagged,
    reviewRequired: Boolean(f.flagged),
    createdAt: now,
    updatedAt: now,
  };
}

const rows: Receipt[] = [
  receipt({ vendor: "Shell", amount: 45.2, category: "Fuel", date: "2026-05-01" }),
  receipt({ vendor: "Shell", amount: 50.0, category: "Fuel", date: "2026-05-03" }),
  receipt({ vendor: "The Home Depot", amount: 120.0, category: "Office Supplies", date: "2026-05-02", flagged: true }),
  receipt({ vendor: "Joe's Diner", amount: 18.5, category: "Meals", date: "2026-05-02", tax: 1.5 }),
];

test("headline totals, average, largest and flagged", () => {
  const s = computeInsights(rows);
  assert.equal(s.count, 4);
  assert.equal(s.total, 233.7);
  assert.equal(s.average, round2(233.7 / 4));
  assert.equal(s.largest, 120);
  assert.equal(s.flagged, 1);
  assert.equal(s.tax, 1.5);
});

test("top vendors sorted by total, merging repeats", () => {
  const s = computeInsights(rows);
  assert.equal(s.topVendors[0]!.vendor, "The Home Depot");
  assert.deepEqual(s.topVendors[1], { vendor: "Shell", count: 2, total: 95.2 });
});

test("timeline is sorted and merges same-day spend", () => {
  const s = computeInsights(rows);
  const days = s.timeline.map((t) => t.date);
  assert.deepEqual(days, [...days].sort());
  const may2 = s.timeline.find((t) => t.date === "2026-05-02")!;
  assert.equal(may2.total, 138.5); // 120 + 18.50 on the same day
  assert.equal(may2.count, 2);
});

test("expense period spans the first to last date", () => {
  const s = computeInsights(rows);
  assert.match(s.period, /May 1, 2026.*May 3, 2026/);
});

test("empty input is handled", () => {
  const s = computeInsights([]);
  assert.equal(s.count, 0);
  assert.equal(s.total, 0);
  assert.equal(s.average, 0);
  assert.deepEqual(s.timeline, []);
  assert.deepEqual(s.topVendors, []);
  assert.equal(s.period, "");
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

test("shareSlices foots to 100%: the top 7 plus one remainder over the whole positive spend", () => {
  const byCategory = [
    "Fuel", "Materials", "Meals", "Travel", "Lodging", "Ground Transportation",
    "Office Supplies", "Software & Subscriptions", "Utilities & Phone", "Other",
  ].map((category, i) => ({ category, count: 1, total: 100 - i * 5 }));
  const slices = shareSlices({ byCategory });
  assert.equal(slices.length, 8, "7 categories + the remainder");
  assert.equal(slices[7]!.category, null);
  assert.equal(slices[7]!.label, "All other (3)");
  assert.equal(slices[7]!.total, 65 + 60 + 55);
  const pct = slices.reduce((s, x) => s + x.share, 0);
  assert.ok(Math.abs(pct - 100) < 1e-9, `shares foot to 100 (got ${pct})`);
  // No remainder when everything fits; nothing at all with one category.
  assert.equal(shareSlices({ byCategory: byCategory.slice(0, 3) }).length, 3);
  assert.deepEqual(shareSlices({ byCategory: byCategory.slice(0, 1) }), []);
  // Zero-total categories are not drawn and not counted in the denominator.
  const withZero = [...byCategory.slice(0, 2), { category: "Travel", count: 0, total: 0 }];
  assert.equal(shareSlices({ byCategory: withZero }).length, 2);
});
