import type { Field, OcrLine } from "../../types.ts";
import { energyQuantities, FUEL_RATE_RE, FUEL_UNIT_RE } from "./fuel.ts";
import { isLabelValueLine, NON_GRAND_RE, PAYMENT_RE, SUBTOTAL_RE, TOTAL_LABELS } from "./labels.ts";
import { moneyHitsFromLine, rightmostAmount, SIGNED_MONEY_RE, type MoneyHit } from "./money.ts";
import { labelFold } from "./text.ts";

// The grand total: labeled-total tiers, the line below a label-only TOTAL,
// and the largest-value fallback.

export function findAmount(lines: OcrLine[]): {
  amount: Field<number> | null;
  subtotal: number | null;
  allMax: MoneyHit | null;
  /** The line the chosen total was read from (the label line, or the line
   *  below a label-only line); null on the largest-value fallback. */
  donor: OcrLine | null;
  /** The donor line printed the value with a negative sign (refund/return). */
  negative: boolean;
} {
  let best: { hit: MoneyHit; weight: number; conf: number; donor: OcrLine } | null = null;
  let subtotal: number | null = null;
  let allMax: MoneyHit | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const text = labelFold(line.text);

    // Track the largest money value anywhere (used for reconciliation), but
    // skip payment/tender lines whose value can exceed the actual total, and
    // per-gallon price lines — "PRICE/G: $4,599" (comma-for-dot OCR) parses
    // as thousands and would flag every pump receipt for review.
    if (
      !PAYMENT_RE.test(text) &&
      !FUEL_UNIT_RE.test(line.text) &&
      !FUEL_RATE_RE.test(line.text)
    ) {
      const energy = energyQuantities(line.text);
      for (const h of moneyHitsFromLine(line)) {
        if (energy.some((q) => Math.abs(q - h.value) < 0.005)) continue;
        if (!allMax || h.value > allMax.value) allMax = h;
      }
    }

    if (SUBTOTAL_RE.test(text)) {
      const h = rightmostAmount(line);
      if (h) subtotal = h.value;
      continue; // never treat subtotal as the grand total
    }

    for (const label of TOTAL_LABELS) {
      if (!label.re.test(text)) continue;
      // A generic "total" line that is really subtotal/tax/tender/change/savings/
      // discount/points/item-count is not the grand total — skip it.
      if (label.weight < 1 && NON_GRAND_RE.test(text)) break;
      // Amount may be on the same line or the next (label-only line). The
      // label line itself gets the lenient scan ("TOTAL 9"); the next line
      // must look strictly like money — it is arbitrary receipt text (a date,
      // "STORE 0442 REG 2", …) and a lenient grab there turned dates into
      // totals.
      let hit = rightmostAmount(line, isLabelValueLine(line.text, text, label.re));
      let donor: OcrLine = line;
      if (!hit && lines[i + 1]) {
        // …and never a tender/change/savings line — "TOTAL" ↵ "CASH 20.00"
        // shipped the cash given as the total.
        const next = labelFold(lines[i + 1]!.text);
        if (!NON_GRAND_RE.test(next) && !PAYMENT_RE.test(next)) {
          hit = rightmostAmount(lines[i + 1]!, false);
          donor = lines[i + 1]!;
        }
      }
      if (hit && hit.value > 0) {
        const conf = label.weight * (line.confidence / 100 || 0.7);
        // Within the same tier the LARGEST value wins (e.g. FUEL TOTAL vs the
        // combined TOTAL on a fuel + car-wash receipt) — ported from the
        // original app's extract_best_total.
        if (
          !best ||
          label.weight > best.weight ||
          (label.weight === best.weight && hit.value > best.hit.value)
        ) {
          best = { hit, weight: label.weight, conf, donor };
        }
      }
      break;
    }
  }

  if (best) {
    const field: Field<number> = {
      value: best.hit.value,
      confidence: Math.max(0.5, Math.min(0.97, best.conf)),
    };
    if (best.hit.bbox) field.bbox = best.hit.bbox;
    return {
      amount: field,
      subtotal,
      allMax,
      donor: best.donor,
      negative: SIGNED_MONEY_RE.test(best.donor.text),
    };
  }

  // No labeled total — fall back to the largest money value on the receipt.
  if (allMax && allMax.value > 0) {
    const field: Field<number> = { value: allMax.value, confidence: 0.5 };
    if (allMax.bbox) field.bbox = allMax.bbox;
    return { amount: field, subtotal, allMax, donor: null, negative: false };
  }
  return { amount: null, subtotal, allMax, donor: null, negative: false };
}
