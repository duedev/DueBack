import type { BBox, Field, OcrLine } from "../../types.ts";
import { parseAmount } from "../../util/money.ts";
import { SUBTOTAL_RE, TAX_ID_RE, TAX_RATE_RE, TAX_RE, TOTAL_TAX_RE } from "./labels.ts";
import { rightmostAmount } from "./money.ts";
import { labelFold, unionBBox } from "./text.ts";

// The receipt's tax: component lines, a printed TOTAL TAX, rate/ID rejects.

/** Percent-suffixed numbers on a line ("8.25%") — rates, never amounts. */
function percentValues(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d[\d.,]*)\s?%/g)) {
    const v = parseAmount(m[1]!);
    if (v !== null) out.push(v);
  }
  return out;
}

/** The receipt's tax. US receipts routinely print several component lines
 *  (STATE / COUNTY / CITY TAX) and often a "TOTAL TAX" sum; `subtotal` and
 *  `total` (the pre-footing pick) let the components be summed when the
 *  receipt's own arithmetic corroborates the sum. */
export function findTax(
  lines: OcrLine[],
  subtotal: number | null = null,
  total: number | null = null,
): Field<number> | null {
  const hits: { field: Field<number>; isTotal: boolean }[] = [];
  for (const line of lines) {
    const folded = labelFold(line.text);
    if (TAX_RE.test(folded) && !SUBTOTAL_RE.test(folded)) {
      // ID/registration and rate lines carry the keyword but not the amount —
      // keep scanning; the real tax line may still follow.
      if (TAX_ID_RE.test(folded) || TAX_RATE_RE.test(folded)) continue;
      const hit = rightmostAmount(line, true);
      if (hit && hit.value >= 0) {
        // The chosen value is a percentage — a rate, not the amount.
        if (percentValues(line.text).some((v) => Math.abs(v - hit.value) < 0.005)) {
          continue;
        }
        const field: Field<number> = {
          value: hit.value,
          confidence: 0.8 * (line.confidence / 100 || 0.7),
        };
        if (hit.bbox) field.bbox = hit.bbox;
        hits.push({ field, isTotal: TOTAL_TAX_RE.test(folded) });
      }
    }
  }
  if (hits.length === 0) return null;
  // A printed TOTAL TAX line is the sum by definition (NON_GRAND_RE already
  // keeps it from being read as the grand total).
  const printedSum = hits.find((h) => h.isTotal);
  if (printedSum) return printedSum.field;
  // Several component lines and no printed sum: add them up ONLY when
  // total − subtotal corroborates the sum — never blindly, or a duplicated
  // customer/merchant copy would double the tax.
  if (hits.length >= 2 && subtotal !== null && total !== null) {
    const expected = Math.round((total - subtotal) * 100) / 100;
    const sum = Math.round(hits.reduce((s, h) => s + h.field.value, 0) * 100) / 100;
    const tol = Math.max(0.02, expected * 0.005);
    if (expected > 0 && Math.abs(sum - expected) <= tol) {
      const field: Field<number> = {
        value: sum,
        confidence: Math.min(...hits.map((h) => h.field.confidence)),
      };
      const box = unionBBox(hits.map((h) => h.field.bbox).filter((b): b is BBox => !!b));
      if (box) field.bbox = box;
      return field;
    }
  }
  return hits[0]!.field;
}
