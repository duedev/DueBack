import type { Category, Receipt } from "../types.ts";
import { CATEGORIES } from "../config/categories.ts";
import { safeAmount } from "../util/money.ts";

// The report's order, shared by every consumer that must agree on it — the
// workbook (Summary numbering, image sheets), the CSV in the tuning bundle
// and the print packet. Deliberately free of ExcelJS/Chart.js so the
// ExportBar can sort and label without pulling the lazy export chunk.

/** Total order: date, then intake order (createdAt), then id. Two same-day
 *  receipts used to compare as "equal" and land in engine-dependent order,
 *  so the packet's "#2" could be the workbook's "#3". Plain string compares:
 *  ISO dates and ids must not go through locale collation. */
export function byReportOrder(a: Receipt, b: Receipt): number {
  return (
    (a.date.value < b.date.value ? -1 : a.date.value > b.date.value ? 1 : 0) ||
    a.createdAt - b.createdAt ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The receipts a report carries: readable, with a positive total. */
export function exportableReceipts(receipts: readonly Receipt[]): Receipt[] {
  return receipts
    .filter((r) => r.status !== "failed" && safeAmount(r.amount.value) > 0)
    .sort(byReportOrder);
}

/** Category sections in taxonomy order, empty ones dropped; a receipt's
 *  "#n" is its index + 1 within its section. */
export function reportOrder(
  receipts: readonly Receipt[],
): { cat: Category; rows: Receipt[] }[] {
  const rows = exportableReceipts(receipts);
  return CATEGORIES.map((cat) => ({
    cat,
    rows: rows.filter((r) => r.category.value === cat),
  })).filter((g) => g.rows.length > 0);
}

/** Report label: Other reads "Miscellaneous" (the original app's word). */
export function displayCategory(cat: Category): string {
  return cat === "Other" ? "Miscellaneous" : cat;
}
