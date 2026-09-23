import { FLAGS } from "../../config/constants.ts";
import type { Field, Flag, OcrLine } from "../../types.ts";
import { findHitByValue } from "./fuel.ts";
import { PAYMENT_RE, SUBTOTAL_RE, TAX_MAX_RATIO, TAX_RE, TIP_RE } from "./labels.ts";
import { moneyHitsFromLine, type MoneyHit } from "./money.ts";
import { labelFold } from "./text.ts";

// Footing math (subtotal + tax [+ tip] vs the total) and the advisory
// reconcile flags.

/** Correct the amount with the receipt's own footing: when SUBTOTAL + TAX are
 *  printed and some OTHER printed money value equals their sum, that sum is
 *  the grand total — an OCR-garbled "total" (e.g. "2@19.28" read as a
 *  plausible-looking $2,819.28) loses to arithmetic the receipt itself
 *  provides. Only ever corrects TO a printed value, mirroring the original
 *  app's reconcile_amount. */

export function applyFootingMath(
  lines: OcrLine[],
  amount: Field<number> | null,
  subtotal: number | null,
  tax: Field<number> | null,
): { amount: Field<number> | null; flags: Flag[] } {
  if (!amount || subtotal === null) return { amount, flags: [] };

  // A tip/gratuity line legitimately lifts the grand total above SUBTOTAL +
  // TAX — footing must widen its expectations instead of "correcting" the
  // tip away (a verified silent under-reimbursement).
  const tipPresent = lines.some((l) => TIP_RE.test(l.text));

  // Without a readable tax line, fall back to a WINDOW check: the grand total
  // sits in [subtotal, subtotal × 1.35] (× 2 when a tip line is printed). An
  // amount far outside it (the glued "2@19.28" → $2,819 class) is replaced by
  // the largest printed money value inside the window from a
  // non-subtotal/tax/payment line.
  if (!tax || tax.value <= 0) {
    const lo = subtotal - 0.01;
    const hi = subtotal * (tipPresent ? 2 : 1.35) + 0.5;
    if (amount.value >= lo && amount.value <= hi) return { amount, flags: [] };
    if (tipPresent) {
      // A tip makes the total unverifiable from the subtotal alone — never
      // "correct" it (the tip line's own value would win the window), just
      // demand a human look.
      return {
        amount,
        flags: [
          {
            code: "total_suspect",
            severity: "warn",
            message: `Total ${amount.value.toFixed(2)} can't be verified against subtotal ${subtotal.toFixed(2)} with a tip printed — needs review.`,
          },
        ],
      };
    }
    let bestInWindow: MoneyHit | null = null;
    for (const line of lines) {
      const folded = labelFold(line.text);
      if (SUBTOTAL_RE.test(folded) || TAX_RE.test(folded) || PAYMENT_RE.test(folded)) continue;
      if (TIP_RE.test(line.text)) continue;
      for (const h of moneyHitsFromLine(line)) {
        if (h.value < lo || h.value > hi) continue;
        if (!bestInWindow || h.value > bestInWindow.value) bestInWindow = h;
      }
    }
    if (!bestInWindow) return { amount, flags: [] };
    // The window's floor is the subtotal itself, so on a single-item receipt
    // the item price "recovers" a garbled total with the tax dropped — that
    // is a plausible but unverified value, so it gates review; a recovery
    // ABOVE the subtotal is the usual tax-inclusive total and stays advisory.
    const taxless = bestInWindow.value <= subtotal + 0.01;
    return {
      amount: {
        value: bestInWindow.value,
        confidence: 0.9,
        ...(bestInWindow.bbox ? { bbox: bestInWindow.bbox } : {}),
      },
      flags: [
        taxless
          ? {
              code: "total_suspect",
              severity: "warn",
              message: `Total ${amount.value.toFixed(2)} is far outside subtotal (${subtotal.toFixed(2)}); took ${bestInWindow.value.toFixed(2)}, which equals the subtotal — no tax recovered, needs review.`,
            }
          : {
              code: "total_mismatch",
              severity: "info",
              message: `Amount corrected: ${amount.value.toFixed(2)} is far outside subtotal (${subtotal.toFixed(2)}) — took the largest printed value in the subtotal window.`,
            },
      ],
    };
  }

  const expected = Math.round((subtotal + tax.value) * 100) / 100;
  const tol = Math.max(0.02, expected * 0.005);
  if (Math.abs(amount.value - expected) <= tol) return { amount, flags: [] };
  if (tipPresent && amount.value >= expected - tol) {
    // SUBTOTAL + TAX + tip: the printed total legitimately exceeds the sum.
    if (amount.value > expected * 2) {
      return {
        amount,
        flags: [
          {
            code: "total_suspect",
            severity: "warn",
            message: `Total ${amount.value.toFixed(2)} is far above subtotal + tax (${expected.toFixed(2)}) — needs review.`,
          },
        ],
      };
    }
    return { amount, flags: [] };
  }
  // Subtotal and tax round independently, so the printed grand total can sit
  // a couple of cents off the sum — search ±3¢ and take the closest.
  const printed = findHitByValue(lines, expected, 0.03);
  const wildlyOff = Math.abs(amount.value - expected) > Math.max(1, expected * 0.35);
  if (!printed && !wildlyOff) return { amount, flags: [] };
  if (!printed && tax.value > subtotal * TAX_MAX_RATIO) {
    // The only thing contradicting the printed total is a sum whose tax is
    // an impossible share of the goods ("TAX 34.60" under "SUBTOTAL 42.00" —
    // a decimal slip, or a misread subtotal): never adopt that arithmetic.
    // Keep the printed total and demand a human look.
    return {
      amount,
      flags: [
        {
          code: "total_suspect",
          severity: "warn",
          message: `Total ${amount.value.toFixed(2)} doesn't foot with subtotal + tax (${expected.toFixed(2)}) and the tax looks garbled — needs review.`,
        },
      ],
    };
  }
  const corrected: Field<number> = printed
    ? {
        value: printed.value,
        confidence: 0.93,
        ...(printed.bbox ? { bbox: printed.bbox } : {}),
      }
    : // No printed grand total survived OCR, but the amount contradicts the
      // receipt's own arithmetic by an order of magnitude — the sum wins.
      { value: expected, confidence: 0.8 };
  return {
    amount: corrected,
    flags: [
      {
        code: "total_mismatch",
        severity: "info",
        message: `Amount corrected: ${amount.value.toFixed(2)} didn't foot with subtotal + tax (${expected.toFixed(2)}).`,
      },
    ],
  };
}

/** Reconcile the chosen amount against the printed totals (§5). */
export function reconcile(
  amount: Field<number> | null,
  tax: Field<number> | null,
  subtotal: number | null,
  allMax: MoneyHit | null,
): Flag[] {
  const flags: Flag[] = [];
  if (!amount) return flags;
  const total = amount.value;
  const tol = Math.max(FLAGS.reconcileTolerance, total * 0.005);

  // The grand total should be the largest money value on the receipt.
  if (allMax && allMax.value - total > tol) {
    flags.push({
      code: "total_mismatch",
      severity: "warn",
      message: `A larger amount (${allMax.value.toFixed(2)}) appears above the total — double-check.`,
    });
  }
  // subtotal + tax should foot to total.
  if (subtotal !== null && tax) {
    if (Math.abs(subtotal + tax.value - total) > tol) {
      flags.push({
        code: "total_mismatch",
        severity: "warn",
        message: `Subtotal ${subtotal.toFixed(2)} + tax ${tax.value.toFixed(2)} ≠ total ${total.toFixed(2)}.`,
      });
    }
  }
  return flags;
}
