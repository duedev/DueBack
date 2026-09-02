import type { Receipt } from "../types.ts";
import { safeAmount } from "../util/money.ts";
import { formatDate } from "../util/format.ts";

// Report insights — adapted from the original app's `_compute_stats`. Pure and
// deterministic: it turns the exported rows into the headline numbers a
// reimbursement report should surface (average, largest, who you spent the most
// with, and the day-by-day breakdown) so the workbook is more than a list.

export interface CategoryStat {
  category: string;
  count: number;
  total: number;
}
export interface VendorStat {
  vendor: string;
  count: number;
  total: number;
}
export interface DayStat {
  date: string;
  count: number;
  total: number;
}

export interface Insights {
  count: number;
  total: number;
  tax: number;
  average: number;
  largest: number;
  flagged: number;
  byCategory: CategoryStat[]; // sorted by total, desc
  topVendors: VendorStat[]; // sorted by total, desc
  timeline: DayStat[]; // sorted by date, asc
  /** Friendly expense date range, e.g. "Jan 4 – Jan 6, 2026", or "" when none. */
  period: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface ShareSlice {
  /** The category, or null for the rolled-up remainder. */
  category: string | null;
  label: string;
  total: number;
  /** Percent of the spend DRAWN (all positive categories), so slices foot to 100. */
  share: number;
}

/** The share doughnut's slices: the top 7 positive categories plus one
 *  remainder slice for the rest, so the percentages foot to 100% of the
 *  spend drawn — a capped list over the whole total used to print slices
 *  summing to less than 100%. Fewer than two positive categories → none
 *  (a one-slice doughnut says nothing). Pure; Node-tested. */
export function shareSlices(insights: Pick<Insights, "byCategory">): ShareSlice[] {
  const all = insights.byCategory.filter((c) => c.total > 0);
  if (all.length < 2) return [];
  const head = all.slice(0, 7);
  const rest = all.slice(7);
  const total = all.reduce((s, c) => s + c.total, 0);
  const slices: ShareSlice[] = head.map((c) => ({
    category: c.category,
    label: c.category === "Other" ? "Miscellaneous" : c.category,
    total: c.total,
    share: 0,
  }));
  if (rest.length) {
    slices.push({
      category: null,
      label: `All other (${rest.length})`,
      total: round2(rest.reduce((s, c) => s + c.total, 0)),
      share: 0,
    });
  }
  return slices.map((s) => ({ ...s, share: (s.total / total) * 100 }));
}

export function computeInsights(rows: Receipt[]): Insights {
  let total = 0;
  let tax = 0;
  let largest = 0;
  let flagged = 0;

  const byCat = new Map<string, CategoryStat>();
  const byVendor = new Map<string, VendorStat>();
  const byDay = new Map<string, DayStat>();

  for (const r of rows) {
    const amount = safeAmount(r.amount.value);
    total += amount;
    tax += safeAmount(r.tax.value);
    if (amount > largest) largest = amount;
    if (r.reviewRequired && !r.approved) flagged++;

    const cat = r.category.value;
    const c = byCat.get(cat) ?? { category: cat, count: 0, total: 0 };
    c.count++;
    c.total = round2(c.total + amount);
    byCat.set(cat, c);

    const vendorName = (r.vendor.value || "—").trim() || "—";
    const vKey = vendorName.toLowerCase();
    const v = byVendor.get(vKey) ?? { vendor: vendorName, count: 0, total: 0 };
    v.count++;
    v.total = round2(v.total + amount);
    byVendor.set(vKey, v);

    const day = r.date.value;
    if (day) {
      const d = byDay.get(day) ?? { date: day, count: 0, total: 0 };
      d.count++;
      d.total = round2(d.total + amount);
      byDay.set(day, d);
    }
  }

  const count = rows.length;
  const byCategory = [...byCat.values()].sort((a, b) => b.total - a.total);
  const topVendors = [...byVendor.values()]
    .sort((a, b) => b.total - a.total || b.count - a.count || a.vendor.localeCompare(b.vendor))
    .slice(0, 5);
  const timeline = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  let period = "";
  if (timeline.length) {
    const min = timeline[0]!.date;
    const max = timeline[timeline.length - 1]!.date;
    period = min === max ? formatDate(min) : `${formatDate(min)} – ${formatDate(max)}`;
  }

  return {
    count,
    total: round2(total),
    tax: round2(tax),
    average: count ? round2(total / count) : 0,
    largest: round2(largest),
    flagged,
    byCategory,
    topVendors,
    timeline,
    period,
  };
}
