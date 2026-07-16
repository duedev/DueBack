import type { PhoneService } from "../types.ts";
import { PHONE_SERVICE_MONTHLY_USD } from "../config/constants.ts";
import { safeAmount, formatMoney } from "./money.ts";

// Phone-service reimbursement math, shared by the report bar (month chips +
// live preview) and the workbook (the Summary's allowance line). Pure —
// Node-tested like util/perdiem.ts.

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Valid, unique, sorted "YYYY-MM" keys — garbage in a synced payload
 *  (or a hand-edited one) never reaches the totals. */
export function normalizeMonths(months: readonly string[] | undefined | null): string[] {
  if (!months) return [];
  return [...new Set(months.filter((m) => MONTH_RE.test(m)))].sort();
}

/** Total reimbursement: fixed monthly rate × selected months. */
export function phoneServiceAmount(ps: PhoneService | undefined | null): number {
  if (!ps?.enabled) return 0;
  return safeAmount(normalizeMonths(ps.months).length * PHONE_SERVICE_MONTHLY_USD);
}

/** "2026-03" → "Mar 2026" (chip labels and month lists). */
export function monthLabel(month: string): string {
  const m = MONTH_RE.exec(month);
  if (!m) return month;
  return new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)
    .toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

/** Months since year 0 — consecutive months differ by exactly 1. */
function monthIndex(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

/** Compact human list with consecutive runs collapsed:
 *  ["2026-01","2026-02","2026-03","2026-05"] → "Jan–Mar 2026, May 2026";
 *  runs across new year keep both years: "Dec 2025–Jan 2026". */
export function formatMonthList(months: readonly string[]): string {
  const valid = normalizeMonths(months);
  if (valid.length === 0) return "";
  const runs: [string, string][] = [];
  let start = valid[0]!;
  let prev = valid[0]!;
  for (const m of valid.slice(1)) {
    if (monthIndex(m) === monthIndex(prev) + 1) {
      prev = m;
      continue;
    }
    runs.push([start, prev]);
    start = prev = m;
  }
  runs.push([start, prev]);
  return runs
    .map(([a, b]) => {
      if (a === b) return monthLabel(a);
      const sameYear = a.slice(0, 4) === b.slice(0, 4);
      const from = sameYear
        ? new Date(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, 1)
            .toLocaleDateString("en-US", { month: "short" })
        : monthLabel(a);
      return `${from}–${monthLabel(b)}`;
    })
    .join(", ");
}

/** "3 months × $63.00/month (Jan–Mar 2026)" — the report-row breakdown. */
export function phoneServiceLabel(ps: PhoneService, currency = "USD"): string {
  const months = normalizeMonths(ps.months);
  const unit = months.length === 1 ? "month" : "months";
  const rate = formatMoney(PHONE_SERVICE_MONTHLY_USD, currency);
  const list = formatMonthList(months);
  return `${months.length} ${unit} × ${rate}/month${list ? ` (${list})` : ""}`;
}
