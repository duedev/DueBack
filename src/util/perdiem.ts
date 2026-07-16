import type { PerDiem } from "../types.ts";
import { safeAmount, formatMoney } from "./money.ts";

// Per-diem math, shared by the report bar (live preview) and the workbook
// (the Summary's "Per Diem" line). Pure — Node-tested like the other utils.

/** Longest duration accepted — a leap year; anything above is a typo. */
export const PER_DIEM_MAX_DAYS = 366;

/** Clamp a duration to something sane; 0 disables the line. */
export function safePerDiemDays(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(PER_DIEM_MAX_DAYS, Math.round(n * 100) / 100);
}

/** Total allowance (rate × days), 0 unless enabled with sane inputs. */
export function perDiemAmount(pd: PerDiem | undefined | null): number {
  if (!pd?.enabled) return 0;
  const total = safeAmount(pd.rate) * safePerDiemDays(pd.days);
  return safeAmount(Math.round(total * 100) / 100);
}

/** "5 days × $75.00/day" — the human-readable breakdown for report rows. */
export function perDiemLabel(pd: PerDiem, currency = "USD"): string {
  const days = safePerDiemDays(pd.days);
  const unit = days === 1 ? "day" : "days";
  return `${days} ${unit} × ${formatMoney(safeAmount(pd.rate), currency)}/day`;
}
