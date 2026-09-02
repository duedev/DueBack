import type { Category } from "../types.ts";

// Receipt file naming — the original Python app's convention, adopted
// verbatim (process_receipts.rename_receipt_image):
//   {category}_{MM-DD-YY}_{vendor}.jpg   e.g.  fuel_12-30-24_chevron.jpg
// Its category prefixes were fuel/mats/misc; this app's richer taxonomy maps
// onto short lowercase prefixes in the same spirit.

const CATEGORY_PREFIX: Record<Category, string> = {
  Fuel: "fuel",
  Materials: "mats",
  "Meals": "meals",
  Travel: "travel",
  Lodging: "lodging",
  "Ground Transportation": "transport",
  "Office Supplies": "office",
  "Software & Subscriptions": "software",
  "Utilities & Phone": "utilities",
  "Shipping & Postage": "shipping",
  "Professional Services": "services",
  Other: "misc",
};

/** Fold accented Latin letters to their ASCII base ("Café" → "Cafe",
 *  "Güero" → "Guero"): NFKD splits a precomposed letter into base + combining
 *  marks, and the marks are dropped. Letters with no ASCII decomposition
 *  (CJK, Cyrillic, "ß") pass through unchanged for the caller's ASCII strip.
 *  Shared by every file-name builder (receipts, workbook, print packet) so
 *  an accented employee or vendor keeps its letters instead of losing them. */
export function foldToAscii(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}+/gu, "");
}

/** Port of the original `sanitize_filename_part`. Diverges deliberately in
 *  one place: accents are FOLDED before the ASCII strip (Café → cafe) where
 *  the Python original dropped the letter (caf). File names stay ASCII on
 *  purpose — the print packet renders non-ASCII as "?" in WinAnsi Helvetica —
 *  so non-Latin scripts sanitize to "" and the receipt falls back to the
 *  vendor-less `{cat}_{date}` form. */
export function sanitizeFilePart(s: string): string {
  return foldToAscii(s)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/** Port of the original `_format_date_mmddyy`: ISO → MM-DD-YY. */
export function dateMMDDYY(iso: string): string {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec((iso || "").trim());
  if (!m) return sanitizeFilePart(iso) || "unknown";
  const mm = String(Number(m[2])).padStart(2, "0");
  const dd = String(Number(m[3])).padStart(2, "0");
  return `${mm}-${dd}-${m[1]!.slice(2)}`;
}

/** The receipt's display/file name in the original app's convention. The
 *  extension is always `.jpg`: the app stores and exports every receipt as
 *  JPEG (imagePrep/annotate re-encode whatever was uploaded), so a `.heic`
 *  or `.png` upload must not lend its extension to JPEG bytes. The upload's
 *  own name — extension included — lives in `Receipt.originalFileName`. */
export function receiptFileName(r: {
  category: Category;
  date: string;
  vendor: string;
}): string {
  const ext = ".jpg";
  // Renamed categories that predate stored data ("Meals & Entertainment")
  // are normalized on repo reads, but belt-and-braces here too.
  const LEGACY_PREFIX: Record<string, string> = { "Meals & Entertainment": "meals" };
  const prefix = CATEGORY_PREFIX[r.category] ?? LEGACY_PREFIX[r.category as string] ?? "misc";
  const vendor = sanitizeFilePart(r.vendor || "");
  const stem = vendor
    ? `${prefix}_${dateMMDDYY(r.date)}_${vendor}`
    : `${prefix}_${dateMMDDYY(r.date)}`;
  return `${stem}${ext}`;
}
