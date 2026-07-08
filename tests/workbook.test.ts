import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildWorkbook } from "../src/export/workbook.ts";
import type { Batch, Receipt, Category } from "../src/types.ts";

function receipt(f: {
  vendor: string;
  amount: number;
  category: Category;
  date: string;
  tax?: number;
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
    tax: { value: f.tax ?? 0, confidence: 0.8 },
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

const batch: Batch = {
  id: "b1",
  employee: "Ada Lovelace",
  jobName: "Q1 Travel",
  jobNumber: "JOB-42",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const receipts: Receipt[] = [
  receipt({ vendor: "Delta", amount: 320.5, category: "Travel", date: "2026-01-04" }),
  receipt({ vendor: "Marriott", amount: 210.0, category: "Lodging", date: "2026-01-05" }),
  receipt({ vendor: "Blue Bottle", amount: 8.99, category: "Meals & Entertainment", date: "2026-01-05" }),
  receipt({ vendor: "Uber", amount: 23.4, category: "Ground Transportation", date: "2026-01-06" }),
];

test("buildWorkbook produces a valid multi-sheet workbook with footing totals", async () => {
  const result = await buildWorkbook(batch, receipts, async () => undefined);
  assert.equal(result.count, 4);
  assert.equal(result.totalCost, 0);
  // The original app's convention: Reimbursements_{Employee}_{YYYYMMDD}.xlsx
  assert.match(result.fileName, /^Reimbursements_Ada_Lovelace_\d{8}\.xlsx$/);

  // Re-open the produced bytes and assert structure.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  const names = wb.worksheets.map((w) => w.name);
  assert.ok(names.includes("Summary"));
  assert.ok(names.includes("Insights"));
  assert.ok(names.includes("All Receipts"));
  assert.ok(names.includes("Travel"));
  assert.ok(names.includes("Lodging"));

  // Insights sheet surfaces the headline total (Key Figures stat tile).
  const insightsWs = wb.getWorksheet("Insights")!;
  const sumAmounts = receipts.reduce((s, r) => s + r.amount.value, 0);
  let foundInsightsTotal = false;
  insightsWs.eachRow((row) => {
    row.eachCell((cell, col) => {
      if (String(cell.value ?? "") === "Total Spend") {
        const raw = insightsWs.getCell(row.number + 1, col).value as
          | number
          | { result?: number }
          | null;
        const v = typeof raw === "object" ? raw?.result : raw;
        assert.ok(Math.abs(Number(v) - sumAmounts) < 0.001, `total spend ${String(v)}`);
        foundInsightsTotal = true;
      }
    });
  });
  assert.ok(foundInsightsTotal, "insights has a Total Spend stat");

  // Summary TOTAL row foots the per-category subtotals to the full sum.
  const expectedTotal = receipts.reduce((s, r) => s + r.amount.value, 0);
  const summary = wb.getWorksheet("Summary")!;
  let foundTotal = false;
  let subtotals = 0;
  summary.eachRow((row) => {
    const label = String(row.getCell(5).value ?? "");
    if (label === "Subtotal") subtotals++;
    if (label === "TOTAL") {
      const cell = row.getCell(6).value as { result?: number } | number;
      const val = typeof cell === "object" ? cell?.result : cell;
      assert.ok(
        Math.abs(Number(val) - expectedTotal) < 0.001,
        `grand total ${String(val)} ≈ ${expectedTotal}`,
      );
      foundTotal = true;
    }
  });
  assert.equal(subtotals, 4, "one Subtotal row per category section");
  assert.ok(foundTotal, "summary has a TOTAL row");

  // Every Summary "#" cell hyperlinks to its receipt's anchor row on the
  // category image sheet (the ported linking feature).
  const links: string[] = [];
  summary.eachRow((row) => {
    const v = row.getCell(1).value as { hyperlink?: string } | null;
    if (v && typeof v === "object" && v.hyperlink) links.push(v.hyperlink);
  });
  assert.equal(links.length, 4, `one link per receipt (got ${JSON.stringify(links)})`);
  assert.ok(links.every((l) => /^#'[^']+'!A\d+$/.test(l)), links.join(", "));
  // …and each target sheet block exists ("Receipt 1  ·  <file>").
  const travel = wb.getWorksheet("Travel")!;
  let foundBand = false;
  travel.eachRow((row) => {
    if (/^Receipt 1\s+·/.test(String(row.getCell(1).value ?? ""))) foundBand = true;
  });
  assert.ok(foundBand, "category sheet has the per-receipt header band");
});

test("buildWorkbook skips failed and zero-amount receipts", async () => {
  const withBad = [
    ...receipts,
    receipt({ vendor: "Broken", amount: 0, category: "Other", date: "2026-01-07", status: "failed" }),
  ];
  const result = await buildWorkbook(batch, withBad, async () => undefined);
  assert.equal(result.count, 4); // the zero/failed one is excluded
});

test("sheet order: Summary, categories, then All Receipts and Insights rightmost", async () => {
  const result = await buildWorkbook(batch, receipts, async () => undefined);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  const names = wb.worksheets.map((w) => w.name);
  assert.equal(names[0], "Summary");
  assert.deepEqual(names.slice(-2), ["All Receipts", "Insights"]);
  // Category sheets sit between, in taxonomy order.
  assert.deepEqual(names.slice(1, -2), ["Meals & Entertainment", "Travel", "Lodging", "Ground Transportation"]);
});

test('"Other" receipts are labeled Miscellaneous in the report', async () => {
  const withOther = [
    ...receipts,
    receipt({ vendor: "Corner Store", amount: 12.5, category: "Other", date: "2026-01-07" }),
  ];
  const result = await buildWorkbook(batch, withOther, async () => undefined);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  const names = wb.worksheets.map((w) => w.name);
  assert.ok(names.includes("Miscellaneous"), names.join(", "));
  assert.ok(!names.includes("Other"));
});

test("notes never read Approved; a reviewed receipt reads Manually reviewed", async () => {
  const reviewed = receipt({ vendor: "Shop", amount: 9.99, category: "Other", date: "2026-01-08" });
  reviewed.reviewRequired = true;
  reviewed.approved = true;
  const result = await buildWorkbook(batch, [reviewed], async () => undefined);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  let sawManually = false;
  wb.eachSheet((ws) => {
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        const v = String(cell.value ?? "");
        assert.notEqual(v, "Approved");
        if (v === "Manually reviewed") sawManually = true;
      });
    });
  });
  assert.ok(sawManually, "reviewed receipt is marked Manually reviewed");
});

test("All Receipts has no Conf. column and Insights totals are formulas", async () => {
  const result = await buildWorkbook(batch, receipts, async () => undefined);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  const all = wb.getWorksheet("All Receipts")!;
  const headers: string[] = [];
  all.getRow(2).eachCell((c) => headers.push(String(c.value ?? "")));
  assert.ok(!headers.includes("Conf."), headers.join(", "));

  const insights = wb.getWorksheet("Insights")!;
  let sawFormula = false;
  insights.eachRow((row) => {
    row.eachCell((cell) => {
      const v = cell.value as { formula?: string } | null;
      if (v && typeof v === "object" && v.formula?.includes("'All Receipts'")) sawFormula = true;
    });
  });
  assert.ok(sawFormula, "insights key figures reference All Receipts");
});
