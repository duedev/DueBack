import ExcelJS from "exceljs";
import type { Batch, Receipt, Category } from "../types.ts";
import { CATEGORIES, CATEGORY_META } from "../config/categories.ts";
import { safeAmount } from "../util/money.ts";
import { computeInsights, type Insights } from "./insights.ts";
import { thumbnail } from "./images.ts";
import {
  categoryChartImage,
  dailyChartImage,
  type ChartImage,
} from "./charts.ts";

// The output is the point (§3). The workbook replicates the original Python
// app's report (spreadsheet_theme.py) — the layout its users already hand to
// their office: a Summary *form* with per-category receipt tables whose "#"
// cells hyperlink to the receipt's image on the category sheet, subtotals and
// a TOTAL that foot with real SUM formulas, per-category image sheets
// (header band → 4pt anchor row → image → data row), an Insights sheet, and
// print setup so every sheet is legible the moment it opens — no zooming.

// ── Palette (lifted from the original app's spreadsheet_theme.py) ───────────
const TITLE_DARK = "FF2C3E50"; // dark slate title bands
const SECTION_BLUE = "FF1E40AF"; // category section bands
const TABLE_BLUE = "FF3B82F6"; // table header rows
const LINK_BLUE = "FF4F8EF7"; // hyperlinked "#" cells
const ZEBRA_BLUE = "FFE4EEF8"; // striped data rows
const INFO_BLUE = "FFEBF5FB"; // employee/period info band
const NOTE_YELLOW = "FFFEF9C3"; // subtotal band
const TEXT_GRAY = "FF4B5563"; // secondary text
const FOOT_GRAY = "FF8A93A6"; // footer text
const WHITE = "FFFFFFFF";
const AMBER = "FFFEF3C7"; // needs-review row highlight

/** Pastel accent behind each receipt's header band on its image sheet. */
const CATEGORY_TINTS: Partial<Record<Category, string>> = {
  Fuel: "FFFFF3CC",
  "Office Supplies": "FFD4FAE8",
  "Meals & Entertainment": "FFFFE4E6",
  Travel: "FFE0F2FE",
  Lodging: "FFEDE9FF",
  "Ground Transportation": "FFDBEAFE",
  "Software & Subscriptions": "FFF3E8FF",
  "Utilities & Phone": "FFECFEFF",
  "Shipping & Postage": "FFFEF3C7",
  "Professional Services": "FFE2E8F0",
  Other: "FFEDE9FF",
};

/** Accounting number format ("$  1,234.56", dash for zero) like the original. */
function acctFormat(currency: string): string {
  const sym: Record<string, string> = {
    USD: "$", CAD: "$", AUD: "$", MXN: "$",
    GBP: "£", EUR: "€", JPY: "¥", CNY: "¥", INR: "₹",
  };
  const s = sym[currency] ?? "$";
  return `_("${s}"* #,##0.00_);_("${s}"* \\(#,##0.00\\);_("${s}"* "-"??_);_(@_)`;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  totalCost: number;
  count: number;
}

interface EmbeddedImage {
  id: number;
  /** Display size in px on the sheet. */
  w: number;
  h: number;
}

/** Per-receipt placement on its category sheet, for Summary hyperlinks. */
interface ReceiptAnchor {
  sheet: string;
  /** The 4pt anchor row right under the receipt's header band. */
  row: number;
}

const IMG_DISPLAY_W = 380; // ≈ column A at width 55
const IMG_ROW_PT = 14; // height of each image carrier row

function exportable(receipts: Receipt[]): Receipt[] {
  return receipts
    .filter((r) => r.status !== "failed" && safeAmount(r.amount.value) > 0)
    .sort((a, b) => (a.date.value < b.date.value ? -1 : 1));
}

export async function buildWorkbook(
  batch: Batch,
  receipts: Receipt[],
  getBlob: (key: string) => Promise<Blob | undefined>,
): Promise<ExportResult> {
  const rows = exportable(receipts);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Reimbursements F5";
  wb.created = new Date();
  wb.properties.date1904 = false;

  // Embed each receipt image once (encoded 2× the display size so it stays
  // sharp when printed); reused by id across sheets.
  const imageByReceipt = new Map<string, EmbeddedImage>();
  for (const r of rows) {
    const key = r.cleanedKey ?? r.fileKey;
    const blob = await getBlob(key);
    if (!blob) continue;
    try {
      const t = await thumbnail(blob, IMG_DISPLAY_W * 2, 0.8);
      const id = wb.addImage({ buffer: t.buffer, extension: t.ext });
      const scale = Math.min(IMG_DISPLAY_W / t.width, 1);
      imageByReceipt.set(r.id, {
        id,
        w: Math.round(t.width * scale),
        h: Math.round(t.height * scale),
      });
    } catch {
      /* skip image on failure — the row still exports */
    }
  }

  const totalCost = rows.reduce((s, r) => s + (r.cost || 0), 0);
  const currency = dominantCurrency(rows);
  const insights = computeInsights(rows);
  const charts = {
    category: await categoryChartImage(insights).catch(() => null),
    daily: await dailyChartImage(insights).catch(() => null),
  };

  // Categories present, in taxonomy order; layout is computed up-front so the
  // Summary (built first, shown first) can hyperlink into the image sheets.
  const perCategory = CATEGORIES.map((cat) => ({
    cat,
    rows: rows.filter((r) => r.category.value === cat),
  })).filter((g) => g.rows.length > 0);

  const anchors = new Map<string, ReceiptAnchor>();
  for (const g of perCategory) {
    const sheet = sheetName(g.cat);
    let row = 3; // first receipt block starts right under the header rows
    for (const rec of g.rows) {
      anchors.set(rec.id, { sheet, row: row + 1 }); // the 4pt anchor row
      row += blockRows(imageByReceipt.get(rec.id));
    }
  }

  buildSummarySheet(wb, batch, perCategory, anchors, currency, insights, totalCost);
  buildInsightsSheet(wb, batch, insights, currency, charts);
  buildAllReceiptsSheet(wb, rows, anchors, currency);
  for (const g of perCategory) {
    buildImageSheet(wb, g.cat, g.rows, imageByReceipt, batch, currency);
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  return { blob, fileName: makeFileName(batch), totalCost, count: rows.length };
}

/** Rows one receipt block occupies on its image sheet:
 *  header band + 4pt anchor + image carrier rows + data row + spacer. */
function blockRows(img: EmbeddedImage | undefined): number {
  const imgRows = img ? Math.max(1, Math.ceil((img.h * 0.75) / IMG_ROW_PT)) : 1;
  return 1 + 1 + imgRows + 1 + 1;
}

// ── Shared styling helpers ───────────────────────────────────────────────────

function fill(cell: ExcelJS.Cell, argb: string): void {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function bandRow(
  ws: ExcelJS.Worksheet,
  row: number,
  cols: number,
  text: string,
  opts: {
    bg: string;
    size?: number;
    height?: number;
    align?: "left" | "center";
  },
): void {
  ws.mergeCells(row, 1, row, cols);
  const cell = ws.getCell(row, 1);
  cell.value = text;
  cell.font = { bold: true, size: opts.size ?? 13, color: { argb: WHITE } };
  cell.alignment = { vertical: "middle", horizontal: opts.align ?? "left" };
  for (let c = 1; c <= cols; c++) fill(ws.getCell(row, c), opts.bg);
  ws.getRow(row).height = opts.height ?? 24;
}

const TABLE_HEADERS = ["#", "Date", "Store", "Job Name", "Job Number", "Amount", "Summary", "Notes"];

function tableHeaderRow(ws: ExcelJS.Worksheet, row: number, size = 11): void {
  TABLE_HEADERS.forEach((h, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = h;
    cell.font = { bold: true, size, color: { argb: WHITE } };
    fill(cell, TABLE_BLUE);
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
}

/** One-line description in the spirit of the original's LLM summaries. */
function describe(rec: Receipt): string {
  const vendor = rec.vendor.value.trim();
  const map: Partial<Record<Category, string>> = {
    Fuel: "Fuel",
    "Meals & Entertainment": "Meal",
    Lodging: "Stay",
    Travel: "Travel",
    "Ground Transportation": "Ride",
  };
  const noun = map[rec.category.value] ?? "Purchase";
  return vendor ? `${noun} at ${vendor}` : `${noun} — vendor unreadable`;
}

function dateValue(iso: string): Date | string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return "—";
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Write one receipt's 8-column data cells starting at `row`. */
function writeReceiptCells(
  ws: ExcelJS.Worksheet,
  row: number,
  n: number,
  rec: Receipt,
  batch: Batch,
  fmt: string,
  opts: { link?: ReceiptAnchor; bg?: string; small?: boolean } = {},
): void {
  const line = ws.getRow(row);
  const num = line.getCell(1);
  if (opts.link) {
    num.value = { text: String(n), hyperlink: `#'${opts.link.sheet}'!A${opts.link.row}` };
  } else {
    num.value = n;
  }
  num.font = { bold: true, size: opts.small ? 10 : 11, color: { argb: LINK_BLUE } };
  num.alignment = { horizontal: "center", vertical: "middle" };

  const base = { size: opts.small ? 10 : 11 } as const;
  const set = (
    c: number,
    v: ExcelJS.CellValue,
    over: Partial<ExcelJS.Style> = {},
  ): void => {
    const cell = line.getCell(c);
    cell.value = v;
    cell.font = { ...base, ...(over.font ?? {}) };
    cell.alignment = {
      horizontal: "center",
      vertical: "middle",
      ...(over.alignment ?? {}),
    };
    if (over.numFmt) cell.numFmt = over.numFmt;
  };
  set(2, dateValue(rec.date.value), { numFmt: "m/d/yy" });
  set(3, rec.vendor.value || "—", {});
  set(4, batch.jobName || "Default Job Name", {});
  set(5, batch.jobNumber || "Default Job Number", {});
  set(6, safeAmount(rec.amount.value), {
    numFmt: fmt,
    alignment: { horizontal: "right", vertical: "middle" },
  });
  set(7, describe(rec), { font: { size: 10, color: { argb: TEXT_GRAY } } });
  set(8, notesFor(rec), { font: { size: 10, color: { argb: TEXT_GRAY } } });

  if (opts.bg) {
    for (let c = 1; c <= 8; c++) fill(line.getCell(c), opts.bg);
  }
}

// ── Summary sheet ────────────────────────────────────────────────────────────

function buildSummarySheet(
  wb: ExcelJS.Workbook,
  batch: Batch,
  perCategory: { cat: Category; rows: Receipt[] }[],
  anchors: Map<string, ReceiptAnchor>,
  currency: string,
  insights: Insights,
  totalCost: number,
): void {
  const ws = wb.addWorksheet("Summary", {
    properties: { tabColor: { argb: TITLE_DARK } },
    views: [{ state: "frozen", ySplit: 4 }],
    pageSetup: {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });
  [24, 18.5, 24, 24, 21.8, 16.3, 44, 36].forEach(
    (w, i) => (ws.getColumn(i + 1).width = w),
  );

  bandRow(ws, 1, 8, "Expense Reimbursement Form", {
    bg: TITLE_DARK, size: 16, height: 30, align: "center",
  });

  const info: [string, string][] = [
    ["Employee:", batch.employee || "—"],
    ["Expense Period:", insights.period || "—"],
  ];
  if (batch.jobName || batch.jobNumber) {
    info.push(["Job:", [batch.jobName, batch.jobNumber].filter(Boolean).join("  ·  ")]);
  }
  let r = 2;
  for (const [k, v] of info) {
    const label = ws.getCell(r, 2);
    label.value = k;
    label.font = { bold: true };
    label.alignment = { horizontal: "right", vertical: "middle" };
    fill(label, INFO_BLUE);
    const val = ws.getCell(r, 3);
    val.value = v;
    val.alignment = { horizontal: "left", vertical: "middle" };
    fill(val, INFO_BLUE);
    ws.getRow(r).height = 18;
    r++;
  }
  r++; // breathing room before the first section

  const fmt = acctFormat(currency);
  const subtotalCells: string[] = [];

  for (const g of perCategory) {
    bandRow(ws, r, 8, `  ${g.cat}`, { bg: SECTION_BLUE });
    r++;
    tableHeaderRow(ws, r);
    ws.getRow(r).height = 32;
    r++;

    const firstData = r;
    g.rows.forEach((rec, i) => {
      writeReceiptCells(ws, r, i + 1, rec, batch, fmt, {
        link: anchors.get(rec.id),
        bg: i % 2 === 1 ? ZEBRA_BLUE : WHITE,
      });
      ws.getRow(r).height = 30;
      r++;
    });

    // Subtotal row
    const sub = ws.getRow(r);
    sub.getCell(5).value = "Subtotal";
    sub.getCell(5).font = { bold: true, color: { argb: "FF1F2937" } };
    sub.getCell(5).alignment = { horizontal: "right", vertical: "middle" };
    fill(sub.getCell(5), NOTE_YELLOW);
    sub.getCell(6).value = {
      formula: `SUM(F${firstData}:F${r - 1})`,
      result: g.rows.reduce((s, x) => s + safeAmount(x.amount.value), 0),
    };
    sub.getCell(6).font = { bold: true, color: { argb: "FF1F2937" } };
    sub.getCell(6).numFmt = fmt;
    sub.getCell(6).alignment = { horizontal: "right", vertical: "middle" };
    fill(sub.getCell(6), NOTE_YELLOW);
    sub.height = 20;
    subtotalCells.push(`F${r}`);
    r += 2; // spacer between sections
  }

  // Grand TOTAL row footing the subtotals
  const totalRow = ws.getRow(r);
  totalRow.getCell(5).value = "TOTAL";
  totalRow.getCell(6).value = {
    formula: subtotalCells.join("+") || "0",
    result: perCategory.reduce(
      (s, g) => s + g.rows.reduce((x, rec) => x + safeAmount(rec.amount.value), 0),
      0,
    ),
  };
  for (const c of [5, 6]) {
    const cell = totalRow.getCell(c);
    cell.font = { bold: true, size: 12, color: { argb: WHITE } };
    fill(cell, TITLE_DARK);
    cell.alignment = { horizontal: c === 5 ? "right" : "right", vertical: "middle" };
  }
  totalRow.getCell(6).numFmt = fmt;
  totalRow.height = 24;
  r += 2;

  // Footer: generation note + honest cost line
  const foot = ws.getRow(r);
  foot.getCell(7).value = `Generated ${new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  })} by Reimbursements F5${totalCost === 0 ? " · extraction cost $0.00" : ""}`;
  foot.getCell(7).font = { size: 9, color: { argb: FOOT_GRAY } };
  foot.getCell(8).value = "github.com/duedev/ReimbursementsF5";
  foot.getCell(8).font = { size: 9, color: { argb: LINK_BLUE } };
}

// ── Per-category image sheets ────────────────────────────────────────────────

function buildImageSheet(
  wb: ExcelJS.Workbook,
  cat: Category,
  rows: Receipt[],
  images: Map<string, EmbeddedImage>,
  batch: Batch,
  currency: string,
): void {
  const ws = wb.addWorksheet(sheetName(cat), {
    properties: { tabColor: { argb: CATEGORY_META[cat].color } },
    views: [{ state: "frozen", ySplit: 2 }],
    pageSetup: {
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
    },
  });
  ws.getColumn(1).width = 55;
  for (let c = 2; c <= 8; c++) ws.getColumn(c).width = 14.7;

  bandRow(ws, 1, 8, `${cat} — Receipt Images`, {
    bg: TITLE_DARK, size: 14, height: 28, align: "center",
  });
  tableHeaderRow(ws, 2, 10);
  ws.getRow(2).height = 28;

  const tint = CATEGORY_TINTS[cat] ?? "FFEDE9FF";
  const fmt = acctFormat(currency);
  let r = 3;
  rows.forEach((rec, i) => {
    // Receipt header band
    ws.mergeCells(r, 1, r, 8);
    const head = ws.getCell(r, 1);
    head.value = `Receipt ${i + 1}  ·  ${rec.fileName}`;
    head.font = { bold: true, size: 10, color: { argb: "FF374151" } };
    head.alignment = { horizontal: "left", vertical: "middle" };
    for (let c = 1; c <= 8; c++) fill(ws.getCell(r, c), tint);
    ws.getRow(r).height = 16;
    r++;

    // 4pt anchor row — the Summary "#" hyperlink lands here, image in view.
    ws.mergeCells(r, 1, r, 8);
    ws.getRow(r).height = 4;
    r++;

    // Image carrier rows
    const img = images.get(rec.id);
    const imgRows = img ? Math.max(1, Math.ceil((img.h * 0.75) / IMG_ROW_PT)) : 1;
    if (img) {
      ws.addImage(img.id, {
        tl: { col: 0.05, row: r - 1 + 0.05 },
        ext: { width: img.w, height: img.h },
        editAs: "oneCell",
      });
    } else {
      ws.getCell(r, 1).value = "(image unavailable)";
      ws.getCell(r, 1).font = { italic: true, size: 9, color: { argb: FOOT_GRAY } };
    }
    for (let k = 0; k < imgRows; k++) {
      ws.getRow(r + k).height = IMG_ROW_PT;
    }
    r += imgRows;

    // Data row
    writeReceiptCells(ws, r, i + 1, rec, batch, fmt, { small: true });
    ws.getRow(r).height = 22;
    r++;

    // Spacer
    ws.getRow(r).height = 8;
    r++;
  });
}

// ── All Receipts index (compact, linked, no images) ─────────────────────────

function buildAllReceiptsSheet(
  wb: ExcelJS.Workbook,
  rows: Receipt[],
  anchors: Map<string, ReceiptAnchor>,
  currency: string,
): void {
  const ws = wb.addWorksheet("All Receipts", {
    properties: { tabColor: { argb: TABLE_BLUE } },
    views: [{ state: "frozen", ySplit: 2 }],
    pageSetup: {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });
  const headers = ["#", "Date", "Store", "Category", "Amount", "Tax", "Conf.", "Notes", "File"];
  const widths = [5, 11, 26, 22, 14, 11, 8, 40, 28];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  bandRow(ws, 1, headers.length, "All Receipts", {
    bg: TITLE_DARK, size: 14, height: 28, align: "center",
  });
  headers.forEach((h, i) => {
    const cell = ws.getCell(2, i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 10, color: { argb: WHITE } };
    fill(cell, TABLE_BLUE);
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  ws.getRow(2).height = 24;

  const fmt = acctFormat(currency);
  const dataStart = 3;
  let r = dataStart;
  rows.forEach((rec, i) => {
    const line = ws.getRow(r);
    const link = anchors.get(rec.id);
    const num = line.getCell(1);
    num.value = link
      ? { text: String(i + 1), hyperlink: `#'${link.sheet}'!A${link.row}` }
      : i + 1;
    num.font = { bold: true, color: { argb: LINK_BLUE } };
    num.alignment = { horizontal: "center" };
    line.getCell(2).value = dateValue(rec.date.value);
    line.getCell(2).numFmt = "m/d/yy";
    line.getCell(2).alignment = { horizontal: "center" };
    line.getCell(3).value = rec.vendor.value || "—";
    line.getCell(4).value = rec.category.value;
    line.getCell(5).value = safeAmount(rec.amount.value);
    line.getCell(5).numFmt = fmt;
    line.getCell(5).alignment = { horizontal: "right" };
    line.getCell(6).value = safeAmount(rec.tax.value);
    line.getCell(6).numFmt = fmt;
    line.getCell(6).alignment = { horizontal: "right" };
    line.getCell(7).value = Math.round(rec.confidence * 100);
    line.getCell(7).alignment = { horizontal: "center" };
    line.getCell(8).value = notesFor(rec);
    line.getCell(8).font = { size: 10, color: { argb: TEXT_GRAY } };
    line.getCell(9).value = rec.fileName;
    line.getCell(9).font = { size: 10, color: { argb: TEXT_GRAY } };

    const needsReview = rec.reviewRequired && !rec.approved;
    const bg = needsReview ? AMBER : i % 2 === 1 ? ZEBRA_BLUE : WHITE;
    for (let c = 1; c <= headers.length; c++) fill(line.getCell(c), bg);
    line.height = 18;
    r++;
  });
  const dataEnd = r - 1;

  if (dataEnd >= dataStart) {
    const totalRow = ws.getRow(r);
    totalRow.getCell(4).value = "TOTAL";
    totalRow.getCell(5).value = {
      formula: `SUM(E${dataStart}:E${dataEnd})`,
      result: rows.reduce((s, x) => s + safeAmount(x.amount.value), 0),
    };
    totalRow.getCell(6).value = {
      formula: `SUM(F${dataStart}:F${dataEnd})`,
      result: rows.reduce((s, x) => s + safeAmount(x.tax.value), 0),
    };
    for (const c of [4, 5, 6]) {
      const cell = totalRow.getCell(c);
      cell.font = { bold: true, size: 12, color: { argb: WHITE } };
      fill(cell, TITLE_DARK);
      cell.alignment = { horizontal: "right" };
      if (c >= 5) cell.numFmt = fmt;
    }
    totalRow.height = 22;

    // Confidence data bar — free signal, no visual cost when everything is fine.
    ws.addConditionalFormatting({
      ref: `G${dataStart}:G${dataEnd}`,
      rules: [
        {
          type: "dataBar",
          cfvo: [
            { type: "num", value: 0 },
            { type: "num", value: 100 },
          ],
          color: { argb: TABLE_BLUE },
          priority: 1,
        } as ExcelJS.ConditionalFormattingRule,
      ],
    });
  }
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: Math.max(dataStart, dataEnd), column: headers.length } };
}

// ── Insights sheet ───────────────────────────────────────────────────────────

function buildInsightsSheet(
  wb: ExcelJS.Workbook,
  batch: Batch,
  insights: Insights,
  currency: string,
  charts: { category: ChartImage | null; daily: ChartImage | null },
): void {
  const ws = wb.addWorksheet("Insights", {
    properties: { tabColor: { argb: SECTION_BLUE } },
    views: [{ showGridLines: false }],
    pageSetup: {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
    },
  });
  const widths = [22, 12, 14, 4, 16, 16, 16, 16];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  bandRow(ws, 1, 8, "Insights", { bg: TITLE_DARK, size: 16, height: 30, align: "center" });
  ws.mergeCells(2, 1, 2, 8);
  const sub = ws.getCell(2, 1);
  sub.value = [batch.employee, insights.period].filter(Boolean).join("  ·  ") || "—";
  sub.font = { color: { argb: "FF334155" } };
  sub.alignment = { horizontal: "center", vertical: "middle" };
  for (let c = 1; c <= 8; c++) fill(ws.getCell(2, c), INFO_BLUE);

  const fmt = acctFormat(currency);

  // Key figures: label row + big value row (the original's stat tiles)
  bandRow(ws, 4, 8, "  Key Figures", { bg: SECTION_BLUE });
  const stats: { label: string; value: number | string; color?: string; money?: boolean }[] = [
    { label: "Total Spend", value: insights.total, money: true },
    { label: "Receipts", value: insights.count },
    { label: "Avg / Receipt", value: insights.average, money: true },
    { label: "Largest", value: insights.largest, money: true },
    { label: "Tax", value: insights.tax, money: true },
    { label: "Flagged", value: insights.flagged, color: "FFB91C1C" },
  ];
  stats.forEach((s, i) => {
    const c = i + 1 <= 3 ? i + 1 : i + 2; // skip the narrow spacer column D
    const label = ws.getCell(5, c);
    label.value = s.label;
    label.font = { size: 9, color: { argb: "FF64748B" } };
    label.alignment = { horizontal: "center" };
    const val = ws.getCell(6, c);
    val.value = s.value;
    val.font = { bold: true, size: 15, color: { argb: s.color ?? SECTION_BLUE } };
    val.alignment = { horizontal: "center" };
    if (s.money) val.numFmt = fmt;
  });
  ws.getRow(5).height = 16;
  ws.getRow(6).height = 24;

  // By-category table (cols A–C) with the charts to the right (cols E–H) —
  // these bands span only the table so they don't run under the charts.
  bandRow(ws, 8, 3, "  By Category", { bg: SECTION_BLUE });
  let r = 9;
  ["Category", "Count", "Total"].forEach((h, i) => {
    const cell = ws.getCell(r, i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 10, color: { argb: WHITE } };
    fill(cell, TABLE_BLUE);
    cell.alignment = { horizontal: "center" };
  });
  r++;
  insights.byCategory.forEach((c, i) => {
    ws.getCell(r, 1).value = c.category;
    ws.getCell(r, 2).value = c.count;
    ws.getCell(r, 2).alignment = { horizontal: "center" };
    ws.getCell(r, 3).value = c.total;
    ws.getCell(r, 3).numFmt = fmt;
    if (i % 2 === 1) {
      for (let col = 1; col <= 3; col++) fill(ws.getCell(r, col), ZEBRA_BLUE);
    }
    r++;
  });

  let chartRow = 8;
  for (const img of [charts.category, charts.daily]) {
    if (!img) continue;
    const id = wb.addImage({ buffer: img.buffer, extension: "png" });
    const w = Math.round(img.width * 0.72);
    const h = Math.round(img.height * 0.72);
    ws.addImage(id, {
      tl: { col: 4, row: chartRow },
      ext: { width: w, height: h },
      editAs: "oneCell",
    });
    chartRow += Math.ceil(h / 19) + 2;
  }

  // Top vendors below (cols A–C, clear of the charts on the right).
  r += 1;
  bandRow(ws, r, 3, "  Top Vendors", { bg: SECTION_BLUE });
  r++;
  ["Vendor", "Count", "Total"].forEach((h, i) => {
    const cell = ws.getCell(r, i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 10, color: { argb: WHITE } };
    fill(cell, TABLE_BLUE);
    cell.alignment = { horizontal: "center" };
  });
  r++;
  for (const [i, v] of insights.topVendors.entries()) {
    ws.getCell(r, 1).value = v.vendor;
    ws.getCell(r, 2).value = v.count;
    ws.getCell(r, 2).alignment = { horizontal: "center" };
    ws.getCell(r, 3).value = v.total;
    ws.getCell(r, 3).numFmt = fmt;
    if (i % 2 === 1) {
      for (let col = 1; col <= 3; col++) fill(ws.getCell(r, col), ZEBRA_BLUE);
    }
    r++;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function notesFor(r: Receipt): string {
  if (r.flags.length === 0) return r.approved ? "Approved" : "";
  return r.flags
    .filter((f) => f.code !== "low_confidence" || !r.approved)
    .map((f) => f.message)
    .join(" ");
}

function dominantCurrency(rows: Receipt[]): string {
  const counts = new Map<string, number>();
  for (const r of rows)
    counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  let best = "USD";
  let max = 0;
  for (const [cur, n] of counts) if (n > max) ((max = n), (best = cur));
  return best;
}

function sheetName(cat: Category): string {
  // Excel sheet names: max 31 chars, no []:*?/\
  return cat.replace(/[[\]:*?/\\]/g, "").slice(0, 31);
}

function toLocalIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function makeFileName(batch: Batch): string {
  const safe = (batch.jobName || batch.employee || "reimbursement")
    .replace(/[^A-Za-z0-9 _-]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 40);
  const stamp = toLocalIso(new Date());
  return `${safe || "reimbursement"}_${stamp}.xlsx`;
}
