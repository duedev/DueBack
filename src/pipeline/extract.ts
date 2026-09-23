import { categorize } from "../config/categories.ts";
import { CONFIDENCE, CURRENCY_DEFAULT, FLAGS } from "../config/constants.ts";
import { FUZZY_HINT_RATIO, fuzzyMatchVendor, fuzzyMatchVendorLines, type FuzzyVendorMatch } from "../config/vendors.ts";
import type { BBox, Category, Field, Flag, OcrLine, OcrResult } from "../types.ts";
import { findAmount } from "./rules/amount.ts";
import { dateFlags, findDate } from "./rules/date.ts";
import { applyFootingMath, reconcile } from "./rules/footing.ts";
import { applyPumpMath } from "./rules/fuel.ts";
import { DISCOUNT_RE, REFUND_ECHO_RE, REFUND_LABEL_RE, TIP_RE } from "./rules/labels.ts";
import { moneyHitsFromLine } from "./rules/money.ts";
import { findTax } from "./rules/tax.ts";
import { findVendor, fuzzyHeaderLines, lineBBoxForAlias, matchKnownVendor, siteIdBrand } from "./rules/vendor.ts";

// Extract structured fields from OCR text with rules/heuristics (§5 step 3).
// Deterministic, free, portable. The goal isn't perfection — it's "right often
// enough that a quick human review fixes the rest in seconds" (§1). Every field
// carries its own confidence and the box it came from, to power the review UX.

export interface Extraction {
  vendor: Field<string>;
  date: Field<string>;
  amount: Field<number>;
  tax: Field<number>;
  currency: string;
  category: Field<Category>;
  confidence: number;
  flags: Flag[];
}

/** Combine field signals + OCR quality into one overall confidence. */
function overallConfidence(
  ocr: number,
  amount: Field<number> | null,
  date: Field<string> | null,
  vendor: Field<string> | null,
  flags: Flag[],
): number {
  const ocrC = Math.min(1, Math.max(0, ocr / 100));
  const parts = [
    { w: 3, v: amount?.confidence ?? 0 },
    { w: 2, v: date?.confidence ?? 0 },
    { w: 2, v: vendor?.confidence ?? 0 },
    { w: 1, v: ocrC },
  ];
  const sumW = parts.reduce((s, p) => s + p.w, 0);
  let score = parts.reduce((s, p) => s + p.w * p.v, 0) / sumW;
  // Errors and warnings erode trust.
  for (const f of flags) {
    if (f.severity === "error") score -= 0.15;
    else if (f.severity === "warn") score -= 0.07;
  }
  return Math.max(0, Math.min(1, score));
}

/** Flags that force a human review even when extraction "succeeded".
 *  Suspicious totals and garbled vendors are accepted as one-offs the rules
 *  can't fix — but they must never ship to a report without a human look.
 *  `date_suspect` is a date more than two years old (`rules/date.ts
 *  dateFlags` — a misread year, "2012-12-12") or the AI tier's date the OCR
 *  can't corroborate (vision/provenance.ts `corroborate`). */
export function forcesManualReview(flags: Flag[]): boolean {
  return flags.some(
    (f) =>
      f.severity === "error" ||
      (f.severity === "warn" &&
        (f.code === "total_suspect" || f.code === "date_suspect" || f.code === "vendor_unclear")),
  );
}

export function parseReceipt(ocr: OcrResult): Extraction {
  const lines = ocr.lines.length
    ? ocr.lines
    : ocr.text
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map<OcrLine>((text) => ({
          text,
          confidence: ocr.confidence,
          bbox: { x: 0, y: 0, w: 1, h: 0 },
          words: [],
        }));

  const found = findAmount(lines);
  const { subtotal, allMax } = found;
  // The pre-footing pick only corroborates a multi-line tax sum; the tax
  // itself is settled before footing math consumes it.
  let tax = findTax(lines, subtotal, found.amount?.value ?? null);
  // A tax larger than the goods is a garble (id digits, misread cents) —
  // drop it so footing math never "corrects" the total with it.
  if (tax && subtotal !== null && tax.value > subtotal) tax = null;
  // Fuel receipts carry their own ground truth: gallons × price/gal; other
  // receipts often carry SUBTOTAL + TAX, which must foot to the total.
  const pump = applyPumpMath(lines, found.amount);
  const footing = pump.verified
    ? { amount: pump.amount, flags: [] as Flag[] }
    : applyFootingMath(lines, pump.amount, subtotal, tax);
  const amount = footing.amount;
  // Without a printed subtotal the guard above can't fire; a tax at or above
  // the settled total is still impossible ("TAX 289.00" on a 43.20 sale) —
  // drop it so the stored field never carries a garble. Runs after pump/
  // footing math so it never changes how the total is chosen.
  if (tax && amount && tax.value >= amount.value) tax = null;
  const date = findDate(lines);
  const currency = CURRENCY_DEFAULT; // USD-only app — nothing detects currency.

  // Vendor: prefer a recognized brand (names the merchant, not the store address —
  // the lesson ported from the original app's vendor DB). Fall back to the
  // address-skipping line heuristic when no known brand is present.
  let known = matchKnownVendor(lines, ocr.text);
  let vendor = findVendor(lines);
  const ocrVendor = vendor;
  // No brand and no merchant-shaped line (the Chevron app prints only the
  // address block — "Anaheim, ca" used to win): a distinctive brand glued
  // into the SITE ID names it. Never over a printed merchant line — "G&M OIL
  // #185" operating a Chevron-branded pump stays the vendor of record.
  let knownBox: BBox | undefined;
  if (!known && !vendor) {
    const id = siteIdBrand(lines);
    if (id) {
      known = id.match;
      knownBox = id.bbox;
    }
  }
  let fuzzy: FuzzyVendorMatch | null = null;
  if (known) {
    const field: Field<string> = { value: known.name, confidence: 0.92 };
    const bbox = knownBox ?? lineBBoxForAlias(lines, known.alias);
    if (bbox) field.bbox = bbox;
    vendor = field;
  } else {
    // Fuzzy sweep over merchant-shaped header lines only: a brand read one-
    // or-two letters off ("MOBTL", "CTATER", "FARMER 80YS") is assumed to be
    // the brand. Address, item, city/state and eatery lines never feed it —
    // one edit turned "MILTON, FL" into Hilton and "BLACK COFFEE" into Slack.
    fuzzy = fuzzyMatchVendorLines(fuzzyHeaderLines(lines));
    if (!fuzzy && vendor?.value) fuzzy = fuzzyMatchVendor(vendor.value);
    if (fuzzy && fuzzy.ratio >= FUZZY_HINT_RATIO) {
      vendor = {
        value: fuzzy.name,
        confidence: Math.max(vendor?.confidence ?? 0, 0.85),
        ...(vendor?.bbox ? { bbox: vendor.bbox } : {}),
      };
    } else {
      // Too weak to name the vendor is too weak to set the category.
      fuzzy = null;
    }
  }

  const hintText = lines.slice(0, 8).map((l) => l.text).join(" ");
  let cat: { category: Category; matched: boolean };
  if (fuzzy && fuzzy.ratio < 1) {
    // The brand needed real edits (digit folds are free): a generic keyword
    // on the receipt is direct evidence and beats the edited brand's
    // category — "PUBLIC PARKING" is not Publix.
    const kw = categorize(hintText, "", null);
    if (kw.matched && kw.category !== fuzzy.category) {
      vendor = ocrVendor;
      fuzzy = null;
      cat = kw;
    } else {
      cat = kw.matched ? kw : { category: fuzzy.category, matched: true };
    }
  } else if (fuzzy) {
    cat = { category: fuzzy.category, matched: true };
  } else {
    cat = categorize(vendor?.value ?? "", hintText, known);
  }
  // GALLONS + PRICE/GAL structure is definitionally a fuel receipt; a KNOWN
  // non-fuel brand (Costco, Walmart, Kroger fuel centers print the retail
  // brand) yields only when the pump math actually foots — paint is sold
  // "per gallon" at Home Depot too.
  if (pump.isPump && (!cat.matched || (pump.verified && cat.category !== "Fuel"))) {
    cat = { category: "Fuel", matched: true };
  }
  const category: Field<Category> = {
    value: cat.category,
    confidence: cat.matched ? 0.85 : 0.4,
  };

  const flags: Flag[] = [];
  if (!amount) flags.push({ code: "no_amount", severity: "error", message: "No total found." });
  if (!date) flags.push({ code: "no_date", severity: "warn", message: "No date found." });
  if (!vendor) flags.push({ code: "no_vendor", severity: "warn", message: "No vendor found." });
  // A tiny or vowel-less vendor no brand table recognized is usually an OCR
  // fragment ("nob") — accept it as a one-off, but demand a human look.
  if (vendor && !known && vendor.value !== fuzzy?.name) {
    const name = vendor.value.trim();
    const compact = name.replace(/[^A-Za-z0-9]/g, "");
    if (compact.length > 0 && (compact.length <= 3 || !/[aeiouy0-9]/i.test(name))) {
      flags.push({
        code: "vendor_unclear",
        severity: "warn",
        message: `Vendor "${name}" looks garbled — confirm the name.`,
      });
    }
  }
  if (!cat.matched) flags.push({ code: "uncategorized", severity: "info", message: "Category is a guess." });
  if (amount && amount.value > FLAGS.largeAmount) {
    flags.push({
      code: "large_amount",
      severity: "info",
      message: "Unusually large amount — verify.",
    });
  }
  // When pump math vouches for the amount, the "larger amount appears above"
  // reconcile warning is noise (stray gallons/garbled tokens) — drop it.
  const corrected = footing.flags.length > 0;
  const reconcileFlags = reconcile(amount, tax, subtotal, allMax).filter(
    (f) => (!pump.verified && !corrected) || f.code !== "total_mismatch",
  );
  flags.push(...reconcileFlags, ...pump.flags, ...footing.flags);
  // A printed SUBTOTAL with no readable tax caps what the total could foot
  // to; a chosen total far above it that no pump/footing net vouched for is
  // probably a garbled token the nets couldn't recover — demand a human look.
  // A printed tip widens the ceiling exactly like footing's own window does.
  const tipPresent = lines.some((l) => TIP_RE.test(l.text));
  if (
    amount && subtotal !== null && (!tax || tax.value <= 0) &&
    !pump.verified && !corrected
  ) {
    if (amount.value > subtotal * (tipPresent ? 2 : 1.5) + 0.02) {
      flags.push({
        code: "total_suspect",
        severity: "warn",
        message: `Total ${amount.value.toFixed(2)} is far above the printed subtotal ${subtotal.toFixed(2)} — needs review.`,
      });
    } else if (
      // Mirror image: a total BELOW the subtotal that nothing on the receipt
      // explains (no discount/coupon/savings line) is a dropped leading digit
      // ("24.05" → "4.05") — never ship it silently.
      amount.value < subtotal - 0.02 &&
      !lines.some((l) => DISCOUNT_RE.test(l.text))
    ) {
      flags.push({
        code: "total_suspect",
        severity: "warn",
        message: `Total ${amount.value.toFixed(2)} is below the printed subtotal ${subtotal.toFixed(2)} — needs review.`,
      });
    }
  }
  // Return/refund slips: the total keeps its magnitude (nothing downstream
  // handles a negative), but a negative sign on the total's own line, a
  // refund/return label on it, or a "REFUND TO …" line echoing the value
  // means this is money coming BACK — a human confirms before it's
  // reimbursed as a purchase. Bare policy text ("RETURN POLICY") never flags.
  if (amount) {
    const donorRefund = found.donor ? REFUND_LABEL_RE.test(found.donor.text) : false;
    const echoed = lines.some(
      (l) =>
        REFUND_ECHO_RE.test(l.text) &&
        moneyHitsFromLine(l).some(
          (h) => Math.abs(h.value - amount.value) <= FLAGS.reconcileTolerance,
        ),
    );
    if (found.negative || donorRefund || echoed) {
      flags.push({
        code: "total_suspect",
        severity: "warn",
        message: "Looks like a refund/return — confirm before reimbursing.",
      });
    }
  }
  flags.push(...dateFlags(date));

  const confidence = overallConfidence(ocr.confidence, amount, date, vendor, flags);
  if (confidence < CONFIDENCE.reviewBelow) {
    flags.push({
      code: "low_confidence",
      severity: "info",
      message: "Low confidence — please review.",
    });
  }

  return {
    vendor: vendor ?? { value: "", confidence: 0 },
    date: date ?? { value: "", confidence: 0 },
    amount: amount ?? { value: 0, confidence: 0 },
    tax: tax ?? { value: 0, confidence: 0 },
    currency,
    category,
    confidence,
    flags,
  };
}

// The rules' public surface (callers import from here, not from rules/).
export { TAX_MAX_RATIO } from "./rules/labels.ts";
export { locateValue, readValueInBox } from "./rules/locate.ts";
export { looksLikeMoney } from "./rules/money.ts";
export { dateFlags, findDateEvidence } from "./rules/date.ts";
export { WINDOW_RECOVERY_NOTE } from "./rules/footing.ts";
export {
  brandFieldFromLines,
  findAliasOnLines,
  matchKnownVendor,
  VENDOR_STOPWORD_RE,
  vendorNameProblem,
} from "./rules/vendor.ts";
