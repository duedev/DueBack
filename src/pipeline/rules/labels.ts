import { labelFold } from "./text.ts";

// The label vocabulary the rules share: total/subtotal/tax/tender/date/tip/
// discount/refund line shapes, and the lenient-total rule extraction and
// post-hoc location must agree on.

export const TOTAL_LABELS = [
  { re: /\b(grand\s*total|amount\s*due|balance\s*due|balance\s+to\s+pay|total\s*due|total\s*paid)\b/i, weight: 1.0 },
  { re: /\btotal\b/i, weight: 0.85 },
  // Gas pumps print "FUEL SALE $31.86" with no other total line; ranked below
  // a plain TOTAL so a combined fuel + car-wash TOTAL still wins.
  { re: /\bfuel\s+(?:total|sale)\b/i, weight: 0.8 },
];

export const SUBTOTAL_RE = /\bsub[\s-]?total\b/i;

// A generic "total" line that is really something else — subtotal/tax/tender/
// change/savings/discount/points/item-count, or a PRE-discount subtotal
// variant ("MERCHANDISE TOTAL", "TOTAL BEFORE COUPONS", "ORIGINAL TOTAL")
// that department and drug stores print above the coupon line — is not the
// grand total. Adapted from the original app's _NON_GRAND_LINE_RE so these
// never win the amount (the largest value wins within a tier, so a
// pre-coupon total would otherwise beat the real one by the coupon amount).
export const NON_GRAND_RE =
  /\b(sub[\s-]?total|tax|savings|discounts?|coupons?|merch(?:andise)?|before|original|tender(?:ed)?|tend|cash|change|points|rewards?|items?|qty|quantity|count)\b/i;

// Payment/tender lines whose money value can exceed the total (cash given, card
// charged). Excluded when finding the largest plausible amount so they don't
// masquerade as the grand total or trip the reconcile "larger amount" check.
export const PAYMENT_RE =
  /\b(cash|change|tender(?:ed)?|tend|card|visa|master\s*card|mastercard|amex|american\s*express|debit|credit|approval|auth|points|rewards?)\b/i;

export const TAX_RE = /\b(sales\s*tax|tax|vat|gst|hst|tps|tvq)\b/i;

// Registration/ID lines carry a tax KEYWORD but never a tax amount — "VAT No
// 123 4567 89" donated 89 to footing math, which then "corrected" a correct
// total. Tested against the label-folded text, like TAX_RE.
export const TAX_ID_RE =
  /\b(?:sales\s*tax|tax|vat|gst|hst|tps|tvq)\b[\s:.#-]*(?:(?:id|no\.?|num(?:ber)?|reg(?:istration)?|invoice|exempt(?:ion)?|ein|abn|rn)\b|#)/i;
// Rate lines quote a percentage ("TAX RATE 8.25%"), not the tax amount.
export const TAX_RATE_RE = /\brate\b/i;

// A printed "TOTAL TAX" line is the sum of the component tax lines by
// definition (STATE/COUNTY/CITY TAX above it).
export const TOTAL_TAX_RE = /\b(total\s+tax(?:es)?|tax(?:es)?\s+total)\b/i;
/** A tax above this share of the subtotal is a garble (a decimal slip on the
 *  TAX line, or a misread SUBTOTAL), never a rate — footing math must not
 *  ADOPT subtotal + such a tax over the printed total. */
export const TAX_MAX_RATIO = 0.5;

export const DATE_LABEL_RE = /\b(date|invoice\s*date|order\s*date|transaction\s*date)\b/i;

// A line that names the transaction a refund/return — only meaningful on the
// total's own line ("REFUND TOTAL 12.00") or as a value echo ("REFUND TO AMEX
// 107.17"); a "RETURN POLICY" footer never flags anything.
export const REFUND_LABEL_RE = /\b(refund|return|credit\s+memo|reversal)\b/i;
export const REFUND_ECHO_RE = /\brefund\b/i;

export const TIP_RE = /\b(tip|gratuity)\b/i;

// Lines that legitimately pull the grand total BELOW the printed subtotal.
export const DISCOUNT_RE =
  /\b(discount|coupon|savings?|saved|promo(?:tion)?|markdown|rebate|voucher|gift\s*card)\b/i;

/** Lines findAmount reads LENIENTLY — a labeled total whose generic label
 *  isn't disqualified by NON_GRAND_RE — so a bare integer ("TOTAL 9") counts.
 *  Post-hoc location (locateValue/readValueInBox) must accept exactly what
 *  extraction accepts, so they share this rule. */
export function lenientTotalLine(text: string): boolean {
  const folded = labelFold(text);
  if (SUBTOTAL_RE.test(folded)) return false;
  const label = TOTAL_LABELS.find((l) => l.re.test(folded));
  return !!label && !(label.weight < 1 && NON_GRAND_RE.test(folded));
}

/** True when a labeled-total line is just the label plus a value ("TOTAL 9",
 *  "Total Amount USD 9") — no other words that would make it a header/body
 *  line. `folded` is `labelFold(raw)` (same length, so the folded match's
 *  offsets slice the RAW text — the fold turns "10" into "lo", which would
 *  read as letters), `labelRe` already matched it. The lenient bare-integer
 *  read is for these lines only: a merchant header that merely contains the
 *  word ("TOTAL WINE & MORE #1234") must not donate its store number. */
export function isLabelValueLine(raw: string, folded: string, labelRe: RegExp): boolean {
  const m = labelRe.exec(folded);
  if (!m || m.index === undefined) return false;
  const residue = raw.slice(0, m.index) + raw.slice(m.index + m[0].length);
  return !/[A-Za-z]{2,}/.test(residue.replace(/\b(?:usd|us|amount|due|paid)\b/gi, ""));
}
