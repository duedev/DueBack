import ExcelJS from "exceljs";
import type { Batch, Receipt, Category } from "../types.ts";
import { APP_NAME } from "../config/constants.ts";
import { CATEGORIES, CATEGORY_META } from "../config/categories.ts";
import { safeAmount } from "../util/money.ts";
import { computeInsights, type Insights } from "./insights.ts";
import { thumbnail } from "./images.ts";
import {
  categoryChartImage,
  dailyChartImage,
  vendorsChartImage,
  cumulativeChartImage,
  shareChartImage,
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

/** Pastel accent behind each receipt's header band on its image sheet. */
const CATEGORY_TINTS: Partial<Record<Category, string>> = {
  Fuel: "FFFFF3CC",
  Materials: "FFD4FAE8",
  "Office Supplies": "FFF0FDF4",
  "Meals": "FFFFE4E6",
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

// Field color-coding on the detail sheets (NOT the Summary form): the same
// scheme as the on-image highlighter — vendor blue, date red, amount green.
const FIELD_TINTS = {
  vendor: { fill: "FFDBEAFE", ink: "FF1D4ED8" },
  date: { fill: "FFFEE2E2", ink: "FFB91C1C" },
  amount: { fill: "FFD8F0E3", ink: "FF116A43" },
} as const;

const IMG_DISPLAY_W = 380; // ≈ column A at width 55
const IMG_ROW_PT = 14; // height of each image carrier row

// ── Column autofit (ExcelJS has none) ────────────────────────────────────────


/** Estimate a cell's rendered text length in default-font character units. */
function displayLength(cell: ExcelJS.Cell): number {
  const v = cell.value;
  if (v === null || v === undefined) return 0;
  if (v instanceof Date) return 8; // rendered m/d/yy
  if (typeof v === "number") {
    // Accounting format ≈ "$  1,234.56" — digits + grouping + symbol gutter.
    return cell.numFmt
      ? v.toLocaleString("en-US", { minimumFractionDigits: 2 }).length + 3
      : String(v).length;
  }
  if (typeof v === "object") {
    const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[] };
    if (typeof o.text === "string") return o.text.length; // hyperlink cell
    if (o.richText) return o.richText.map((t) => t.text).join("").length;
    if (o.result !== undefined) {
      return typeof o.result === "number"
        ? o.result.toLocaleString("en-US", { minimumFractionDigits: 2 }).length + 3
        : String(o.result).length;
    }
    return 0;
  }
  return String(v)
    .split("\n")
    .reduce((m, line) => Math.max(m, line.length), 0);
}

/** Set each column's width to fit its longest cell (font size and bold
 *  factored in). Merged cells are skipped — the full-width band rows would
 *  otherwise balloon column A — as are explicitly skipped rows (footers). */
function autofitColumns(
  ws: ExcelJS.Worksheet,
  cols: number[],
  opts: { min?: number; max?: number; skipRows?: number[] } = {},
): void {
  const skip = new Set(opts.skipRows ?? []);
  const want = new Map<number, number>();
  ws.eachRow({ includeEmpty: false }, (row, rowNo) => {
    if (skip.has(rowNo)) return;
    row.eachCell({ includeEmpty: false }, (cell, colNo) => {
      if (!cols.includes(colNo) || cell.isMerged) return;
      const len = displayLength(cell);
      if (len === 0) return;
      const size = cell.font?.size ?? 11;
      const bold = cell.font?.bold ? 1.06 : 1;
      const units = len * (size / 11) * bold + 2.6;
      want.set(colNo, Math.max(want.get(colNo) ?? 0, units));
    });
  });
  for (const c of cols) {
    const w = want.get(c);
    if (w === undefined) continue;
    ws.getColumn(c).width = Math.min(
      opts.max ?? 46,
      Math.max(opts.min ?? 8, Math.round(w * 10) / 10),
    );
  }
}

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
  wb.creator = APP_NAME;
  wb.created = new Date();
  wb.properties.date1904 = false;

  // Embed each receipt image once (encoded 2× the display size so it stays
  // sharp when printed); reused by id across sheets.
  const imageByReceipt = new Map<string, EmbeddedImage>();
  for (const r of rows) {
    const key = r.annotatedKey ?? r.cleanedKey ?? r.fileKey;
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
    vendors: await vendorsChartImage(insights).catch(() => null),
    cumulative: await cumulativeChartImage(insights).catch(() => null),
    share: await shareChartImage(insights).catch(() => null),
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

  // Tab order: Summary first (it IS the per-category receipt table, linked),
  // the category image sheets next (Fuel, Materials, … Miscellaneous), and
  // Insights all the way to the right.
  const subtotalCells = buildSummarySheet(wb, batch, perCategory, anchors, currency, insights);
  for (const g of perCategory) {
    buildImageSheet(wb, g.cat, g.rows, imageByReceipt, batch, currency);
  }
  buildInsightsSheet(wb, batch, insights, currency, charts, subtotalCells);

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

// The Notes column is gone by request: it only ever carried app-generated
// review chatter ("Manually reviewed", flag text) that the office doesn't
// need on the report — review state lives in the app, not the deliverable.
const TABLE_HEADERS = ["#", "Date", "Store", "Job Name", "Job Number", "Amount", "Summary"];

function tableHeaderRow(ws: ExcelJS.Worksheet, row: number, size = 11): void {
  TABLE_HEADERS.forEach((h, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = h;
    cell.font = { bold: true, size, color: { argb: WHITE } };
    fill(cell, TABLE_BLUE);
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
}

// The original app's Summary column carried real LLM-written descriptions;
// synthesized "Purchase at …" filler added nothing, so the column stays blank
// unless something meaningful exists (kept for the office's format parity).

function dateValue(iso: string): Date | string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return "—";
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Write one receipt's 7-column data cells starting at `row`. */
function writeReceiptCells(
  ws: ExcelJS.Worksheet,
  row: number,
  n: number,
  rec: Receipt,
  batch: Batch,
  fmt: string,
  opts: { link?: ReceiptAnchor; bg?: string; small?: boolean; colorFields?: boolean } = {},
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
  set(7, "", { font: { size: 10, color: { argb: TEXT_GRAY } } });

  if (opts.bg) {
    for (let c = 1; c <= 7; c++) fill(line.getCell(c), opts.bg);
  }
  if (opts.colorFields) {
    const paint = (
      c: number,
      t: { fill: string; ink: string },
    ): void => {
      const cell = line.getCell(c);
      fill(cell, t.fill);
      cell.font = { ...(cell.font ?? {}), color: { argb: t.ink } };
    };
    paint(3, FIELD_TINTS.vendor); // Store
    paint(2, FIELD_TINTS.date); // Date
    paint(6, FIELD_TINTS.amount); // Amount
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
): string[] {
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
  [24, 18.5, 24, 24, 21.8, 16.3, 30].forEach(
    (w, i) => (ws.getColumn(i + 1).width = w),
  );

  bandRow(ws, 1, 7, "Expense Reimbursement Form", {
    bg: TITLE_DARK, size: 16, height: 30, align: "center",
  });

  // Job name/number are per-receipt columns, not report headers.
  const info: [string, string][] = [
    ["Employee:", batch.employee || "—"],
    ["Expense Period:", insights.period || "—"],
  ];
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

  // Credits sit up top beside the employee info (merged cells are skipped by
  // the autofit, so the long strings can't balloon a column).
  ws.mergeCells(2, 5, 2, 7);
  const gen = ws.getCell(2, 5);
  gen.value = `Generated ${new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  })} by ${APP_NAME}`;
  gen.font = { size: 9, color: { argb: FOOT_GRAY } };
  gen.alignment = { horizontal: "right", vertical: "middle" };
  ws.mergeCells(3, 5, 3, 7);
  const src = ws.getCell(3, 5);
  src.value = { text: "github.com/duedev/ReimbursementsF5", hyperlink: "https://github.com/duedev/ReimbursementsF5" };
  src.font = { size: 9, color: { argb: LINK_BLUE }, underline: true };
  src.alignment = { horizontal: "right", vertical: "middle" };

  r++; // breathing room before the first section

  const fmt = acctFormat(currency);
  const subtotalCells: string[] = [];

  for (const g of perCategory) {
    bandRow(ws, r, 7, `  ${displayCategory(g.cat)}`, { bg: SECTION_BLUE });
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

  // Fit every column to its content.
  autofitColumns(ws, [1, 2, 3, 4, 5, 6, 7], { min: 6, max: 46 });
  return subtotalCells;
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
  for (let c = 2; c <= 7; c++) ws.getColumn(c).width = 14.7;

  bandRow(ws, 1, 7, `${displayCategory(cat)} — Receipt Images`, {
    bg: CATEGORY_META[cat].color, size: 14, height: 28, align: "center",
  });
  tableHeaderRow(ws, 2, 10);
  ws.getRow(2).height = 28;

  const tint = CATEGORY_TINTS[cat] ?? "FFEDE9FF";
  const fmt = acctFormat(currency);
  let r = 3;
  rows.forEach((rec, i) => {
    // Receipt header band
    ws.mergeCells(r, 1, r, 7);
    const head = ws.getCell(r, 1);
    head.value = `Receipt ${i + 1}  ·  ${rec.fileName}`;
    head.font = { bold: true, size: 10, color: { argb: "FF374151" } };
    head.alignment = { horizontal: "left", vertical: "middle" };
    for (let c = 1; c <= 7; c++) fill(ws.getCell(r, c), tint);
    ws.getRow(r).height = 16;
    r++;

    // 4pt anchor row — the Summary "#" hyperlink lands here, image in view.
    ws.mergeCells(r, 1, r, 7);
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
    writeReceiptCells(ws, r, i + 1, rec, batch, fmt, { small: true, colorFields: true });
    ws.getRow(r).height = 22;
    r++;

    // Spacer
    ws.getRow(r).height = 8;
    r++;
  });

  // Fit the data columns; column A stays fixed — it carries the images.
  autofitColumns(ws, [2, 3, 4, 5, 6, 7], { min: 8, max: 40 });
}

// ── Insights sheet — an executive dashboard ─────────────────────────────────

function buildInsightsSheet(
  wb: ExcelJS.Workbook,
  batch: Batch,
  insights: Insights,
  currency: string,
  charts: {
    category: ChartImage | null;
    daily: ChartImage | null;
    vendors: ChartImage | null;
    cumulative: ChartImage | null;
    share: ChartImage | null;
  },
  subtotalCells: string[],
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
  const COLS = 12;
  const widths = [22, 12, 14, 2, 13, 13, 13, 13, 13, 13, 13, 13];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  bandRow(ws, 1, COLS, "Insights", { bg: TITLE_DARK, size: 16, height: 30, align: "center" });
  ws.mergeCells(2, 1, 2, COLS);
  const sub = ws.getCell(2, 1);
  sub.value =
    [batch.employee, insights.period, `${insights.count} receipts`]
      .filter(Boolean)
      .join("  ·  ") || "—";
  sub.font = { color: { argb: "FF334155" } };
  sub.alignment = { horizontal: "center", vertical: "middle" };
  for (let c = 1; c <= COLS; c++) fill(ws.getCell(2, c), INFO_BLUE);

  const fmt = acctFormat(currency);

  // ── KPI tiles ──────────────────────────────────────────────────────────────
  bandRow(ws, 4, COLS, "  Key Figures", { bg: SECTION_BLUE });
  const totalFormula = subtotalCells.map((c) => `Summary!${c}`).join("+");
  const stats: { label: string; value: ExcelJS.CellValue; color?: string; money?: boolean }[] = [
    {
      label: "Total Spend",
      value: totalFormula
        ? { formula: totalFormula, result: insights.total }
        : insights.total,
      money: true,
    },
    { label: "Receipts", value: insights.count },
    { label: "Avg / Receipt", value: insights.average, money: true },
    { label: "Largest", value: insights.largest, money: true },
    { label: "Categories", value: insights.byCategory.filter((c) => c.total > 0).length },
    { label: "Flagged", value: insights.flagged, color: "FFB91C1C" },
  ];
  const TILE_BG = "FFF6F8FB";
  stats.forEach((st, i) => {
    const c = i * 2 + 1; // two columns per tile
    ws.mergeCells(5, c, 5, c + 1);
    ws.mergeCells(6, c, 6, c + 1);
    const label = ws.getCell(5, c);
    label.value = st.label;
    label.font = { size: 9, color: { argb: "FF64748B" } };
    label.alignment = { horizontal: "center", vertical: "bottom" };
    const val = ws.getCell(6, c);
    val.value = st.value;
    val.font = { bold: true, size: 16, color: { argb: st.color ?? SECTION_BLUE } };
    val.alignment = { horizontal: "center", vertical: "middle" };
    if (st.money) val.numFmt = fmt;
    for (const rr of [5, 6]) {
      for (let cc = c; cc <= c + 1; cc++) fill(ws.getCell(rr, cc), TILE_BG);
    }
    val.border = { bottom: { style: "medium", color: { argb: SECTION_BLUE } } };
    ws.getCell(6, c + 1).border = {
      bottom: { style: "medium", color: { argb: SECTION_BLUE } },
    };
  });
  ws.getRow(5).height = 16;
  ws.getRow(6).height = 28;

  // ── Chart grid: two per row, scaled to sit side by side ────────────────────
  const SCALE = 0.62; // 900px renders → ~560px display, two-up
  const pairs: [ChartImage | null, ChartImage | null][] = [
    [charts.category, charts.share],
    [charts.daily, charts.cumulative],
    [charts.vendors, null],
  ];
  let r = 8;
  for (const [left, right] of pairs) {
    let rowsUsed = 0;
    for (const [img, col] of [
      [left, 0],
      [right, 6],
    ] as [ChartImage | null, number][]) {
      if (!img) continue;
      const id = wb.addImage({ buffer: img.buffer, extension: "png" });
      const w = Math.round(img.width * SCALE);
      const h = Math.round(img.height * SCALE);
      ws.addImage(id, {
        tl: { col, row: r - 1 },
        ext: { width: w, height: h },
        editAs: "oneCell",
      });
      rowsUsed = Math.max(rowsUsed, Math.ceil(h / 19) + 2);
    }
    r += rowsUsed;
  }

  // ── Reference tables, side by side under the charts ───────────────────────
  const tableTop = r + 1;
  smallTable(
    ws, tableTop, 1, "By Category",
    ["Category", "Count", "Total"],
    insights.byCategory.map((c) => [
      c.category === "Other" ? "Miscellaneous" : c.category,
      c.count,
      c.total,
    ]),
    fmt,
    insights.byCategory.map(
      (c) => CATEGORY_META[c.category as Category]?.color,
    ),
  );
  smallTable(
    ws, tableTop, 5, "Top Vendors",
    ["Vendor", "Count", "Total"],
    insights.topVendors.map((v) => [v.vendor, v.count, v.total]),
    fmt,
  );
}

/** Small 3-column table with a section band, header and zebra rows. */
function smallTable(
  ws: ExcelJS.Worksheet,
  top: number,
  col: number,
  heading: string,
  headers: string[],
  data: (string | number)[][],
  moneyFmt: string,
  nameColors?: (string | undefined)[],
): void {
  ws.mergeCells(top, col, top, col + 2);
  const band = ws.getCell(top, col);
  band.value = `  ${heading}`;
  band.font = { bold: true, size: 13, color: { argb: WHITE } };
  band.alignment = { vertical: "middle", horizontal: "left" };
  for (let c = col; c <= col + 2; c++) fill(ws.getCell(top, c), SECTION_BLUE);
  ws.getRow(top).height = 24;

  headers.forEach((h, i) => {
    const cell = ws.getCell(top + 1, col + i);
    cell.value = h;
    cell.font = { bold: true, size: 10, color: { argb: WHITE } };
    fill(cell, TABLE_BLUE);
    cell.alignment = { horizontal: "center" };
  });

  data.forEach((rowData, i) => {
    const r = top + 2 + i;
    rowData.forEach((v, j) => {
      const cell = ws.getCell(r, col + j);
      cell.value = v;
      cell.alignment = { horizontal: j === 0 ? "left" : j === 1 ? "center" : "right" };
      if (j === 2 && typeof v === "number") cell.numFmt = moneyFmt;
    });
    const nameColor = nameColors?.[i];
    if (nameColor) {
      ws.getCell(r, col).font = { bold: true, color: { argb: nameColor } };
    }
    if (i % 2 === 1) {
      for (let c = col; c <= col + 2; c++) fill(ws.getCell(r, c), ZEBRA_BLUE);
    }
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────


function dominantCurrency(rows: Receipt[]): string {
  const counts = new Map<string, number>();
  for (const r of rows)
    counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  let best = "USD";
  let max = 0;
  for (const [cur, n] of counts) if (n > max) ((max = n), (best = cur));
  return best;
}

/** Report label for a category — "Other" reads "Miscellaneous", like the
 *  original app's fuel/materials/miscellaneous taxonomy. */
function displayCategory(cat: Category): string {
  return cat === "Other" ? "Miscellaneous" : cat;
}

function sheetName(cat: Category): string {
  // Excel sheet names: max 31 chars, no []:*?/\
  return displayCategory(cat).replace(/[[\]:*?/\\]/g, "").slice(0, 31);
}

function toLocalIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function makeFileName(batch: Batch): string {
  // The original app's convention: Reimbursements_{Employee}_{YYYYMMDD}.xlsx
  const safe = (batch.employee || "Employee")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 40);
  const stamp = toLocalIso(new Date()).replace(/-/g, "");
  return `Reimbursements_${safe || "Employee"}_${stamp}.xlsx`;
}
