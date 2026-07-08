import type { Category } from "../types.ts";

// Receipt file naming — the original Python app's convention, adopted
// verbatim (process_receipts.rename_receipt_image):
//   {category}_{MM-DD-YY}_{vendor}.ext   e.g.  fuel_12-30-24_chevron.jpg
// Its category prefixes were fuel/mats/misc; this app's richer taxonomy maps
// onto short lowercase prefixes in the same spirit.

const CATEGORY_PREFIX: Record<Category, string> = {
  Fuel: "fuel",
  Materials: "mats",
  "Meals & Entertainment": "meals",
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

/** Port of the original `sanitize_filename_part`. */
export function sanitizeFilePart(s: string): string {
  return s
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

/** The receipt's display/file name in the original app's convention. */
export function receiptFileName(r: {
  category: Category;
  date: string;
  vendor: string;
  fileName: string;
}): string {
  const ext = (/\.[a-z0-9]{2,5}$/i.exec(r.fileName)?.[0] ?? ".jpg").toLowerCase();
  const prefix = CATEGORY_PREFIX[r.category] ?? "misc";
  const vendor = sanitizeFilePart(r.vendor || "");
  const stem = vendor
    ? `${prefix}_${dateMMDDYY(r.date)}_${vendor}`
    : `${prefix}_${dateMMDDYY(r.date)}`;
  return `${stem}${ext}`;
}
