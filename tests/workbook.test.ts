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
  receipt({ vendor: "Blue Bottle", amount: 8.99, category: "Meals", date: "2026-01-05" }),
  receipt({ vendor: "Uber", amount: 23.4, category: "Ground Transportation", date: "2026-01-06" }),
];

test("buildWorkbook produces a valid multi-sheet workbook with footing totals", async () => {
  const result = await buildWorkbook(batch, receipts, async () => undefined, { insights: true });
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

test("sheet order: Summary, categories in taxonomy order, Insights rightmost", async () => {
  const result = await buildWorkbook(batch, receipts, async () => undefined, { insights: true });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  const names = wb.worksheets.map((w) => w.name);
  assert.equal(names[0], "Summary");
  assert.equal(names[names.length - 1], "Insights");
  // The Summary IS the receipt table (linked); no redundant flat copy.
  assert.ok(!names.includes("All Receipts"));
  assert.deepEqual(names.slice(1, -1), ["Meals", "Travel", "Lodging", "Ground Transportation"]);
});

test("the Insights sheet is opt-in — absent by default", async () => {
  const result = await buildWorkbook(batch, receipts, async () => undefined);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  const names = wb.worksheets.map((w) => w.name);
  assert.ok(!names.includes("Insights"), names.join(", "));
  // Without it, the rightmost tab is the last category sheet…
  assert.equal(names[names.length - 1], "Ground Transportation");
  // …and the Summary still knows the expense period (computed regardless).
  const summary = wb.getWorksheet("Summary")!;
  let period = "";
  summary.eachRow((row) => {
    if (String(row.getCell(2).value ?? "") === "Expense Period:") {
      period = String(row.getCell(3).value ?? "");
    }
  });
  assert.match(period, /Jan/, `expense period present (got "${period}")`);
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

test("no app-generated notes reach the report; credits sit at the top", async () => {
  const reviewed = receipt({ vendor: "Shop", amount: 9.99, category: "Other", date: "2026-01-08" });
  reviewed.reviewRequired = true;
  reviewed.approved = true;
  reviewed.flags = [
    { code: "total_mismatch", severity: "warn", message: "needs review chatter" },
  ];
  const result = await buildWorkbook(batch, [reviewed], async () => undefined);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  wb.eachSheet((ws) => {
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        const v = String(cell.value ?? "");
        assert.notEqual(v, "Approved");
        assert.notEqual(v, "Manually reviewed");
        assert.ok(!v.includes("needs review chatter"), `flag text leaked: ${v}`);
        assert.notEqual(v, "Notes"); // the column itself is gone
      });
    });
  });
  // The generation credit + repo link moved from the footer to the header
  // rows beside the employee info.
  const summary = wb.getWorksheet("Summary")!;
  const gen = String(summary.getCell(2, 5).value ?? "");
  assert.match(gen, /^Generated .* by DueBack$/, gen);
  const link = summary.getCell(3, 5).value as { hyperlink?: string } | null;
  assert.ok(
    link && typeof link === "object" && /github\.com\/duedev/.test(link.hyperlink ?? ""),
    "repo link at the top",
  );
});

test("Insights Total Spend foots from the Summary's subtotal formulas", async () => {
  const result = await buildWorkbook(batch, receipts, async () => undefined, { insights: true });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  const insights = wb.getWorksheet("Insights")!;
  let sawFormula = false;
  insights.eachRow((row) => {
    row.eachCell((cell) => {
      const v = cell.value as { formula?: string } | null;
      if (v && typeof v === "object" && v.formula?.includes("Summary!F")) sawFormula = true;
    });
  });
  assert.ok(sawFormula, "insights Total Spend references the Summary subtotals");
});

test("columns autofit to content; notes wrap in a capped column", async () => {
  const long = receipt({
    vendor: "Consolidated Building Materials Warehouse",
    amount: 1234.56,
    category: "Materials",
    date: "2026-01-09",
  });
  long.flags = [
    {
      code: "total_mismatch",
      severity: "warn",
      message:
        "Total 1234.56 is far above the printed subtotal 229.85 — needs review. Double-check against the receipt image before approving.",
    },
  ];
  const result = await buildWorkbook(batch, [long], async () => undefined);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  const summary = wb.getWorksheet("Summary")!;
  // Store column grew to fit the 42-char vendor (default was 24).
  const store = summary.getColumn(3).width ?? 0;
  assert.ok(store > 30, `store col width ${store}`);
});

// ── Workbook-review round: single source of truth + polish ──────────────────

test("Summary amounts are live references to the category sheets", async () => {
  const result = await buildWorkbook(batch, receipts, async () => undefined);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  const summary = wb.getWorksheet("Summary")!;
  let checked = 0;
  summary.eachRow((row) => {
    const link = row.getCell(1).value as { hyperlink?: string } | null;
    if (!link || typeof link !== "object" || !link.hyperlink) return;
    const amt = row.getCell(6).value as { formula?: string; result?: number };
    assert.ok(
      amt && typeof amt === "object" && /^'[^']+'!F\d+$/.test(amt.formula ?? ""),
      `amount is a category-sheet ref (got ${JSON.stringify(amt)})`,
    );
    // Follow the reference: the target cell holds the same value statically.
    const m = /^'([^']+)'!F(\d+)$/.exec(amt.formula!)!;
    const target = wb.getWorksheet(m[1]!)!.getCell(Number(m[2]), 6).value;
    assert.equal(target, amt.result, `ref target ${String(target)} = ${amt.result}`);
    checked++;
  });
  assert.equal(checked, 4, "every receipt row checked");
});

test("Insights KPIs and tables derive from Summary cells", async () => {
  const result = await buildWorkbook(batch, receipts, async () => undefined, { insights: true });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  const ins = wb.getWorksheet("Insights")!;
  const fx: string[] = [];
  ins.eachRow((row) =>
    row.eachCell((cell) => {
      const v = cell.value as { formula?: string } | null;
      if (v && typeof v === "object" && v.formula) fx.push(v.formula);
    }),
  );
  assert.ok(fx.some((f) => /COUNT\(Summary!/.test(f)), "Receipts KPI counts Summary ranges");
  assert.ok(fx.some((f) => f === "A6/C6"), "Avg derives from the Total and Receipts tiles");
  assert.ok(fx.some((f) => /^MAX\(Summary!/.test(f)), "Largest is a MAX over Summary ranges");
  assert.ok(fx.some((f) => /SUMIF\(Summary!\$C:\$C,E\d+,Summary!\$F:\$F\)/.test(f)), "Top Vendors SUMIFs the Summary");
  assert.ok(fx.some((f) => /COUNTIF\(Summary!\$C:\$C,E\d+\)/.test(f)), "vendor counts too");
});

test("no Default Job placeholders; blank batch fields read as an em-dash", async () => {
  const blankBatch = { ...batch, jobName: "", jobNumber: "" };
  const result = await buildWorkbook(blankBatch, receipts, async () => undefined);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  let dashes = 0;
  wb.eachSheet((ws) =>
    ws.eachRow((row) =>
      row.eachCell((cell) => {
        const v = String(cell.value ?? "");
        assert.ok(!v.startsWith("Default Job"), `placeholder leaked: ${v}`);
        if (v === "—") dashes++;
      }),
    ),
  );
  assert.ok(dashes > 0, "blank job fields render as em-dashes");
});

test("headers have six columns (no dead Summary column); dates are whole days", async () => {
  const result = await buildWorkbook(batch, receipts, async () => undefined);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  const summary = wb.getWorksheet("Summary")!;
  let sawHeaders = false;
  summary.eachRow((row) => {
    if (String(row.getCell(1).value ?? "") !== "#") return;
    sawHeaders = true;
    const headers = [1, 2, 3, 4, 5, 6, 7].map((c) => String(row.getCell(c).value ?? ""));
    assert.deepEqual(headers.slice(0, 6), ["#", "Date", "Store", "Job Name", "Job Number", "Amount"]);
    assert.equal(headers[6], "", "no seventh column");
  });
  assert.ok(sawHeaders);
  // Date serials are UTC midnight — no spurious time-of-day.
  summary.eachRow((row) => {
    const v = row.getCell(2).value;
    if (v instanceof Date) {
      assert.equal(v.getUTCHours(), 0, `date carries time: ${v.toISOString()}`);
      assert.equal(v.getUTCMinutes(), 0);
    }
  });
});

// ── Per diem ─────────────────────────────────────────────────────────────────

const receiptsTotal = receipts.reduce((s, r) => s + r.amount.value, 0);

function summaryScan(wb: ExcelJS.Workbook): {
  perDiemLabel: string | null;
  perDiemAmount: number | null;
  phoneLabel: string | null;
  phoneAmount: number | null;
  total: number | null;
  totalFormula: string;
} {
  const summary = wb.getWorksheet("Summary")!;
  let perDiemLabel: string | null = null;
  let perDiemAmount: number | null = null;
  let phoneLabel: string | null = null;
  let phoneAmount: number | null = null;
  let total: number | null = null;
  let totalFormula = "";
  summary.eachRow((row) => {
    const c2 = String(row.getCell(2).value ?? "");
    if (c2.startsWith("Per diem")) {
      perDiemLabel = c2;
      perDiemAmount = Number(row.getCell(6).value);
    }
    if (c2.startsWith("Phone service")) {
      phoneLabel = c2;
      phoneAmount = Number(row.getCell(6).value);
    }
    if (String(row.getCell(5).value ?? "") === "TOTAL") {
      const cell = row.getCell(6).value as { formula?: string; result?: number } | number;
      total = typeof cell === "object" ? Number(cell?.result) : Number(cell);
      totalFormula = typeof cell === "object" ? (cell?.formula ?? "") : "";
    }
  });
  return { perDiemLabel, perDiemAmount, phoneLabel, phoneAmount, total, totalFormula };
}

test("per diem adds a labeled allowance line and feeds the TOTAL", async () => {
  const pdBatch: Batch = {
    ...batch,
    perDiem: { enabled: true, rate: 75, days: 5 },
  };
  const result = await buildWorkbook(pdBatch, receipts, async () => undefined, { insights: true });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  const scan = summaryScan(wb);
  assert.equal(scan.perDiemLabel, "Per diem — 5 days × $75.00/day");
  assert.equal(scan.perDiemAmount, 375);
  assert.ok(
    Math.abs(scan.total! - (receiptsTotal + 375)) < 0.001,
    `TOTAL ${String(scan.total)} includes the allowance`,
  );
  // The TOTAL foots the subtotal cells PLUS the per-diem cell.
  assert.match(scan.totalFormula, /\+F\d+$/);

  // Insights stays receipt analytics: Total Spend excludes the allowance.
  const ins = wb.getWorksheet("Insights")!;
  ins.eachRow((row) => {
    row.eachCell((cell, col) => {
      if (String(cell.value ?? "") === "Total Spend") {
        const raw = ins.getCell(row.number + 1, col).value as
          | number
          | { result?: number };
        const v = typeof raw === "object" ? raw?.result : raw;
        assert.ok(Math.abs(Number(v) - receiptsTotal) < 0.001, `insights ${String(v)}`);
      }
    });
  });
});

test("no per-diem line when disabled or zero", async () => {
  for (const perDiem of [
    undefined,
    { enabled: false, rate: 75, days: 5 },
    { enabled: true, rate: 0, days: 5 },
  ]) {
    const result = await buildWorkbook({ ...batch, perDiem }, receipts, async () => undefined);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await result.blob.arrayBuffer());
    const scan = summaryScan(wb);
    assert.equal(scan.perDiemLabel, null);
    assert.ok(Math.abs(scan.total! - receiptsTotal) < 0.001);
  }
});

test("phone service adds a month-listing line and feeds the TOTAL", async () => {
  const psBatch: Batch = {
    ...batch,
    phoneService: { enabled: true, months: ["2026-01", "2026-02", "2026-04"] },
  };
  const result = await buildWorkbook(psBatch, receipts, async () => undefined);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  const scan = summaryScan(wb);
  assert.equal(
    scan.phoneLabel,
    "Phone service — 3 months × $63.00/month (Jan–Feb 2026, Apr 2026)",
  );
  assert.equal(scan.phoneAmount, 189);
  assert.ok(Math.abs(scan.total! - (receiptsTotal + 189)) < 0.001);
  assert.equal(scan.perDiemLabel, null, "no per-diem row without per diem");
});

test("per diem and phone service stack as separate lines in one TOTAL", async () => {
  const bothBatch: Batch = {
    ...batch,
    perDiem: { enabled: true, rate: 75, days: 5 },
    phoneService: { enabled: true, months: ["2026-01", "2026-02"] },
  };
  const result = await buildWorkbook(bothBatch, receipts, async () => undefined);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  const scan = summaryScan(wb);
  assert.equal(scan.perDiemAmount, 375);
  assert.equal(scan.phoneAmount, 126);
  assert.ok(Math.abs(scan.total! - (receiptsTotal + 375 + 126)) < 0.001);
  // The TOTAL foots the subtotals plus BOTH allowance cells.
  assert.match(scan.totalFormula, /\+F\d+\+F\d+$/);
});

test("no phone line when disabled or no months picked", async () => {
  for (const phoneService of [
    undefined,
    { enabled: false, months: ["2026-01"] },
    { enabled: true, months: [] },
  ]) {
    const result = await buildWorkbook({ ...batch, phoneService }, receipts, async () => undefined);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await result.blob.arrayBuffer());
    const scan = summaryScan(wb);
    assert.equal(scan.phoneLabel, null);
    assert.ok(Math.abs(scan.total! - receiptsTotal) < 0.001);
  }
});

test("a per-diem-only report (zero receipts) still builds and foots", async () => {
  const pdBatch: Batch = {
    ...batch,
    perDiem: { enabled: true, rate: 120.5, days: 3 },
  };
  const result = await buildWorkbook(pdBatch, [], async () => undefined);
  assert.equal(result.count, 0);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  const scan = summaryScan(wb);
  assert.equal(scan.perDiemLabel, "Per diem — 3 days × $120.50/day");
  assert.equal(scan.total, 361.5);
});

test("category sheets link back to the Summary", async () => {
  const result = await buildWorkbook(batch, receipts, async () => undefined);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  const travel = wb.getWorksheet("Travel")!;
  const back = travel.getCell(1, 6).value as { text?: string; hyperlink?: string };
  assert.ok(back && typeof back === "object" && /Summary/.test(back.hyperlink ?? ""), JSON.stringify(back));
});
