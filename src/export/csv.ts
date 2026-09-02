import type { Receipt } from "../types.ts";
import { safeAmount } from "../util/money.ts";
import { displayCategory, exportableReceipts } from "./order.ts";

// CSV export — adapted from the original app's `_results_to_csv`. A plain,
// importable companion to the .xlsx for expense systems that want raw rows.
// Deterministic, RFC-4180 quoting, in the report's order. Pure (no DOM), so
// it's trivially testable. Its one caller today is the tuning bundle
// (train/bundle.ts), which takes `toCsvBytes` — UTF-8 with a BOM so Excel
// opens the em-dash notes and accented vendors cleanly.

const HEADERS = [
  "Category", "Date", "Vendor", "Amount",
  "Currency", "Confidence", "Status", "Notes",
] as const;

/** Quote a field iff it contains a comma, quote or newline; double inner quotes. */
function csvField(v: string | number): string {
  const s = String(v ?? "");
  // A cell starting with = + - @ (or a tab/CR) is a formula to Excel and
  // Sheets — a vendor OCR'd as "=SUM(…)" or "-SHELL" would execute or
  // mis-parse on import. A leading apostrophe makes it text (the
  // spreadsheet hides the apostrophe). Only Vendor can realistically start
  // that way: amounts are positive, confidence is an integer, dates ISO.
  const t = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

function statusOf(r: Receipt): string {
  if (r.status === "failed") return "Failed";
  if (r.reviewRequired && !r.approved) return "Needs review";
  if (r.approved) return "Approved";
  return "OK";
}

function notesOf(r: Receipt): string {
  return r.flags.map((f) => f.message).join("; ");
}

/** Build a CSV document (CRLF rows) from the exportable receipts. */
export function toCsv(receipts: Receipt[]): string {
  const rows = exportableReceipts(receipts);

  const lines = [HEADERS.map(csvField).join(",")];
  for (const r of rows) {
    lines.push(
      [
        // Report label parity with the workbook: Other reads Miscellaneous.
        displayCategory(r.category.value),
        r.date.value,
        r.vendor.value,
        safeAmount(r.amount.value).toFixed(2),
        // USD-only app: pinned so a legacy row that still stores another code
        // can't contradict the workbook, which always renders $.
        "USD",
        Math.round(r.confidence * 100),
        statusOf(r),
        notesOf(r),
      ]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

/** `toCsv` as UTF-8 bytes with a BOM — what a file should carry (Excel
 *  reads BOM-less UTF-8 as the local code page and garbles "—"/"é"). */
export function toCsvBytes(receipts: Receipt[]): Uint8Array {
  return new TextEncoder().encode("\ufeff" + toCsv(receipts));
}

/** "<job or employee>_<YYYY-MM-DD>.csv", sanitized. */
export function csvFileName(meta: { jobName?: string; employee?: string }): string {
  const base = (meta.jobName || meta.employee || "reimbursement")
    .replace(/[^A-Za-z0-9 _-]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 40);
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${base || "reimbursement"}_${stamp}.csv`;
}
