import type { Field, Flag, OcrLine } from "../../types.ts";
import { parseAmount } from "../../util/money.ts";
import { PAYMENT_RE } from "./labels.ts";
import { moneyHitsFromLine, type MoneyHit } from "./money.ts";

// Fuel and EV-charging structure: pump quantities/rates and the pump-math
// reconcile (gallons × price/gal is ground truth OCR can't fake).

// ── Pump-math reconciliation ─────────────────────────────────────────────────
// Fuel receipts print GALLONS and PRICE/GAL alongside the total, so the total
// is *checkable*: gallons × price ≈ total (pumps round to the cent). This is a
// deterministic ground truth OCR misreads can't fake — a garbled "$3,188.00"
// against 6.927 gal × $4.599 is caught immediately.

// The slash class is REQUIRED in the "price/g" form — OCR reads the slash as
// Z/7/l/1/\ ("PRICEZG"), but an *optional* slash let "PRICE GOOD THRU 7.15"
// pass as a per-gallon price and corrupt a correct total.
export const FUEL_UNIT_RE =
  /(?:price\s*[\/z7l1\\]\s*g(?:al(?:lon)?)?\b|(?:price\s+)?per\s+gal(?:lon)?|\$\s*\/\s*g)/i;
// Loyalty/discount lines quote per-gallon RATES ("DISCOUNT 1.00/GAL", "FUEL
// SAVINGS EARNED 1.00 PER GALLON") — never pump quantities or prices.
const FUEL_PROMO_RE =
  /\b(discount|save[ds]?|savings?|rewards?|earned|redeem\w*|loyalty|off)\b/i;
// The gallons count must sit adjacent to its keyword. The keyword must LEAD
// the line in the after form ("GALLONS: 6.927"), so item lines like
// "MILK 1 GAL 4.99" can't donate their price as a quantity; the before form
// is the pump's own "11.204 GAL".
export const QTY_AFTER_RE =
  /^[^A-Za-z0-9]*(?:fuel\s+|unleaded\s+|diesel\s+)?(?:gallons?|gal|litres?|liters?)\b[\s:.#=]*(\d+\.\d{1,3})/i;
export const QTY_BEFORE_RE = /(\d+\.\d{1,3})\s*(?:gallons?|gal|litres?|liters?)\b/i;
// A keyword-less per-gallon rate ("UNL $4.599/GAL", comma-misread "$4,599/GAL"):
// money-or-3-decimal token right before the (possibly glyph-garbled) /GAL.
export const FUEL_RATE_RE = /\d[.,]\d{2,3}\s*[\/z7l1\\]\s*g(?:al(?:lon)?)?\b/i;
const PLAIN_NUM_RE = /\d+\.\d{1,3}/g;

// EV charging is the electric pump, and its quantity line is the one that
// misleads: a session prints its ENERGY in kWh ("42.31 kWh") right next to a
// much smaller dollar total ($15.23). That quantity parses as strict money,
// so left alone it becomes reconcile's "a larger amount appears above the
// total" — a warn that forces *every* charging receipt into manual review.
// Only the kWh QUANTITY is dropped, never the whole line: a session line can
// carry the charge itself ("42.31 kWh    $15.23").
const ENERGY_QTY_SRC = String.raw`(\d+(?:[.,]\d{1,3})?)\s*k\s*w\s*h\b`;
export const ENERGY_QTY_RE = new RegExp(ENERGY_QTY_SRC, "i");

/** The kWh quantities printed on a line, for exclusion from the money scan. */
export function energyQuantities(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(new RegExp(ENERGY_QTY_SRC, "gi"))) {
    const v = parseAmount((m[1] ?? "").replace(",", "."));
    if (v !== null) out.push(v);
  }
  return out;
}

/** gallons × price/gal from the printed pump lines, or null. */
function pumpMathTotal(lines: OcrLine[]): number | null {
  let qty: number | null = null;
  let unit: number | null = null;
  for (const line of lines) {
    if (FUEL_PROMO_RE.test(line.text)) continue;
    const isUnitLine = FUEL_UNIT_RE.test(line.text) || FUEL_RATE_RE.test(line.text);
    if (qty === null && !isUnitLine) {
      const m = QTY_AFTER_RE.exec(line.text) ?? QTY_BEFORE_RE.exec(line.text);
      const v = m ? Number(m[1]) : NaN;
      if (v > 0 && v < 300) qty = v;
    } else if (unit === null && isUnitLine) {
      const nums = (line.text.match(PLAIN_NUM_RE) ?? []).map(Number);
      const v = nums.filter((n) => n > 0.5 && n < 20);
      if (v.length) unit = v[v.length - 1]!;
    }
  }
  if (qty === null || unit === null) return null;
  const product = Math.round(qty * unit * 100) / 100;
  return product >= 1 && product <= 2000 ? product : null;
}

/** How many money hits across the receipt sit within `tol` of `value`. */
function countHitsNear(lines: OcrLine[], value: number, tol: number): number {
  let n = 0;
  for (const line of lines) {
    for (const h of moneyHitsFromLine(line)) {
      if (Math.abs(h.value - value) <= tol) n++;
    }
  }
  return n;
}

/** Closest money hit to `value` within `tol` (non-payment lines preferred).
 *  Whether the winning hit sits on a payment/tender line is reported — a
 *  tender equal to the pump product means the charge WAS fuel-only, which
 *  reads very differently from a printed FUEL TOTAL sub-line. */
export function findHitByValue(
  lines: OcrLine[],
  value: number,
  tol: number,
): (MoneyHit & { payment: boolean }) | null {
  let best: { hit: MoneyHit; diff: number; payment: boolean } | null = null;
  for (const line of lines) {
    const payment = PAYMENT_RE.test(line.text);
    for (const h of moneyHitsFromLine(line)) {
      const diff = Math.abs(h.value - value);
      if (diff > tol) continue;
      if (
        !best ||
        (best.payment && !payment) ||
        (best.payment === payment && diff < best.diff)
      ) {
        best = { hit: h, diff, payment };
      }
    }
  }
  return best ? { ...best.hit, payment: best.payment } : null;
}

/** Cross-check/correct the amount with pump math. Returns flags plus whether
 *  the amount now agrees with gallons × price (which silences the noisy
 *  larger-amount reconcile warning — the math is stronger evidence). */
export function applyPumpMath(
  lines: OcrLine[],
  amount: Field<number> | null,
): { amount: Field<number> | null; verified: boolean; isPump: boolean; flags: Flag[] } {
  const expected = pumpMathTotal(lines);
  if (expected === null) {
    // The math needs both gallons and a unit price; a per-gallon price line
    // alone still proves fuel STRUCTURE ("GALLONS: 18153" loses its decimal
    // to OCR, but the receipt is definitionally a pump receipt).
    const fuelStructure = lines.some(
      (l) =>
        !FUEL_PROMO_RE.test(l.text) &&
        (FUEL_UNIT_RE.test(l.text) || FUEL_RATE_RE.test(l.text)),
    );
    return { amount, verified: false, isPump: fuelStructure, flags: [] };
  }
  const tol = 0.05;

  if (amount && Math.abs(amount.value - expected) <= tol) {
    // The printed total foots with the pump math — highest confidence.
    return {
      amount: { ...amount, confidence: Math.max(amount.confidence, 0.95) },
      verified: true,
      isPump: true,
      flags: [],
    };
  }

  // The chosen amount disagrees with gallons × price/gal. The product only
  // covers the FUEL portion of the receipt, so a larger printed total is
  // often legitimate (fuel + car wash / store items) — decide by how the
  // receipt's own numbers corroborate each side rather than assuming the
  // printed total is the misread one.
  const anchor = findHitByValue(lines, expected, tol); // the printed fuel-only value
  if (amount) {
    const ratio = amount.value / expected;
    const suspect: Flag = {
      code: "total_suspect",
      severity: "warn",
      message: `Total ${amount.value.toFixed(2)} doesn't match gallons × price/gal (≈ ${expected.toFixed(2)}) — needs review.`,
    };
    // A vanished decimal point multiplies by exactly ×10/×100 — and it
    // vanishes on EVERY line printing that value (same faint dot), so a
    // tender-line echo can't vouch for a slip-scale total.
    const decimalSlip = [10, 100, 1000, 0.1, 0.01].some(
      (k) => Math.abs(ratio - k) / k <= 0.03,
    );
    if (decimalSlip) {
      // …but a printed fuel-only line (non-payment anchor) under a larger
      // total is real fuel+extras evidence: a $100 total over a $10 FUEL
      // TOTAL is indistinguishable from a ×10 slip — a human decides.
      if (anchor && !anchor.payment && amount.value > expected) {
        return { amount, verified: false, isPump: true, flags: [suspect] };
      }
      // Uncorroborated slip: the garbled-total class this net exists for —
      // fall through and correct.
    } else {
      // Another line echoing the chosen total (the tender line usually does)
      // means two independent reads agree — the computed product loses.
      if (countHitsNear(lines, amount.value, tol) >= 2) {
        return { amount, verified: false, isPump: true, flags: [] };
      }
      if (anchor?.payment) {
        // The tender equals the pump product: the charge WAS the fuel-only
        // value and the larger "total" is the misread — fall through and
        // correct toward the printed tender.
      } else if (amount.value > expected && anchor && ratio < 2) {
        // The fuel-only value is printed elsewhere (FUEL TOTAL) and the total
        // is plausibly fuel + extras — keep the larger combined total.
        return { amount, verified: false, isPump: true, flags: [] };
      } else {
        // Unexplained disagreement: never silently swap in either direction
        // (the gallons digits are misread as often as the total) — keep the
        // printed total and demand a human look.
        return { amount, verified: false, isPump: true, flags: [suspect] };
      }
    }
  }

  // Prefer a printed money value that matches the product (keeps an on-image
  // box); else adopt the computed product.
  const corrected: Field<number> = anchor
    ? { value: anchor.value, confidence: 0.92, ...(anchor.bbox ? { bbox: anchor.bbox } : {}) }
    : { value: expected, confidence: 0.85 };
  const note = amount
    ? `Amount corrected: ${amount.value.toFixed(2)} didn't match gallons × price/gal (≈ ${expected.toFixed(2)}).`
    : `Amount taken from gallons × price/gal (≈ ${expected.toFixed(2)}).`;
  return {
    amount: corrected,
    verified: true,
    isPump: true,
    flags: [{ code: "total_mismatch", severity: "info", message: note }],
  };
}
