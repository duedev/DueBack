// Money parsing/formatting. Input hardening (§11): never let a non-finite or
// absurd amount through — it would poison totals and the export.

/**
 * Parse a human/OCR money string into a finite number of major units.
 * Handles "$1,234.56", "1.234,56" (EU), "USD 12.00", trailing "-", etc.
 * Also accepts a plain number — Svelte binds `<input type="number">` to a
 * number, and a `.replace` call on it threw, silently discarding the edit.
 * Returns null for anything not safely finite or beyond the 1,000,000
 * magnitude guard. The result is SIGNED (a leading or trailing "-" negates;
 * accounting parentheses are stripped, not negated) — callers that persist or
 * export must clamp with `safeAmount`, and the extraction rules filter sign
 * on their side.
 */
export function parseAmount(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || Math.abs(raw) > 1_000_000) return null;
    return Math.round(raw * 100) / 100;
  }
  let s = raw.replace(/[^\d.,\-]/g, "");
  if (!s || !/\d/.test(s)) return null;

  const neg = /-/.test(s);
  s = s.replace(/-/g, "");

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  let decSep: "." | "," | null = null;
  if (lastComma > -1 && lastDot > -1) {
    // Both present: the right-most separator is the decimal point.
    decSep = lastComma > lastDot ? "," : ".";
  } else if (lastComma > -1) {
    // Only commas. Treat as decimal when it looks like cents (",dd" at the end
    // and no second comma that would imply thousands grouping).
    decSep = /^\d+,\d{1,2}$/.test(s) ? "," : null;
  } else if (lastDot > -1) {
    // Only dots. US-first: a single dot is the decimal point no matter how
    // many digits follow — receipts print 3-decimal unit prices and quantities
    // ("$3.499/gal", "11.204 GAL") constantly, and reading them as thousands
    // grouping turned gallons into $11,204. Multiple dots ("1.234.567") are
    // EU thousands grouping.
    decSep = s.indexOf(".") === lastDot ? "." : null;
  }

  let normalized: string;
  if (decSep === ",") {
    normalized = s.replace(/\./g, "").replace(",", "."); // strip dots, comma→dot
  } else if (decSep === ".") {
    normalized = s.replace(/,/g, ""); // strip thousands commas
  } else {
    normalized = s.replace(/[.,]/g, ""); // all separators are grouping
  }

  const n = Number.parseFloat(normalized);
  if (!Number.isFinite(n)) return null;
  const value = neg ? -n : n;
  // Reject absurd magnitudes that indicate a misread. The sign is preserved
  // here — `safeAmount` is the negative clamp for anything persisted/exported.
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) return null;
  return Math.round(value * 100) / 100;
}

/** Guard used before persisting/exporting any amount. */
export function safeAmount(n: number): number {
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return 0;
  return Math.round(n * 100) / 100;
}

// The app is USD-only: every amount renders as US dollars.
const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatMoney(n: number): string {
  return usdFmt.format(safeAmount(n));
}
