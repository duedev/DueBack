import { repo } from "../store/repo.ts";
import { locateValue } from "../pipeline/extract.ts";
import type { Receipt, BBox, OcrLine } from "../types.ts";

// The improvement loop: every human correction made in review is recorded
// with WHERE the right value actually sits on the receipt (re-located on the
// stored OCR lines) and what the pipeline believed beforehand. The log is a
// labeled dataset over the user's own receipts — download it (the tuning
// bundle in bundle.ts packs it with every receipt's extraction and its
// original + annotated images, keyed by receiptId/fileName) and tune the
// rules (or train a model) against real failures instead of guesses.

export interface CorrectionRecord {
  ts: number;
  receiptId: string;
  fileName: string;
  field: "vendor" | "date" | "amount" | "tax" | "category";
  from: string | number;
  to: string | number;
  /** Whether the corrected value was found printed on the receipt. */
  located: boolean;
  /** Normalized box of the corrected value on the cleaned image, if found. */
  bbox?: BBox;
  /** The OCR line the corrected value sits on, for context. */
  lineText?: string;
  /** What the pipeline believed: overall confidence + extraction method. */
  confidence: number;
  method: string;
}

const KEY = "training.log";
const MAX_RECORDS = 2000;

/** Pure diff of a review patch against the stored receipt (Node-testable). */
export function buildCorrectionRecords(
  before: Receipt,
  patch: Partial<Receipt>,
  lines: OcrLine[],
  now = Date.now(),
): CorrectionRecord[] {
  const out: CorrectionRecord[] = [];
  const base = {
    ts: now,
    receiptId: before.id,
    fileName: patch.fileName ?? before.fileName,
    confidence: before.confidence,
    method: before.methodDetail ?? before.methodUsed,
  };

  const push = (
    field: CorrectionRecord["field"],
    from: string | number,
    to: string | number,
    locatable: "amount" | "vendor" | "date" | null,
  ): void => {
    if (from === to) return;
    const rec: CorrectionRecord = { ...base, field, from, to, located: false };
    if (locatable) {
      const hit = locateValue(lines, locatable, to);
      if (hit) {
        rec.located = true;
        rec.bbox = hit.bbox;
        rec.lineText = hit.lineText;
      }
    }
    out.push(rec);
  };

  if (patch.vendor) push("vendor", before.vendor.value, patch.vendor.value, "vendor");
  if (patch.date) push("date", before.date.value, patch.date.value, "date");
  if (patch.amount) push("amount", before.amount.value, patch.amount.value, "amount");
  if (patch.tax) push("tax", before.tax.value, patch.tax.value, null);
  if (patch.category) push("category", before.category.value, patch.category.value, null);
  return out;
}

/** Pure: fold new records into the log, collapsing edit churn. Typing
 *  through a date field fires a save per segment ("0002-09-11" →
 *  "0020-09-11" → … → "2024-09-11"); only the original → final correction is
 *  worth learning from. A correction that ends back at the original value
 *  disappears entirely. */
export function mergeCorrections(
  log: CorrectionRecord[],
  records: CorrectionRecord[],
): CorrectionRecord[] {
  const out = [...log];
  for (const rec of records) {
    const last = out[out.length - 1];
    if (
      last &&
      last.receiptId === rec.receiptId &&
      last.field === rec.field &&
      String(last.to) === String(rec.from)
    ) {
      if (String(last.from) === String(rec.to)) {
        out.pop(); // net-zero: reverted to the original value
      } else {
        out[out.length - 1] = { ...rec, from: last.from };
      }
      continue;
    }
    out.push(rec);
  }
  return out.slice(-MAX_RECORDS);
}

export async function appendCorrections(records: CorrectionRecord[]): Promise<void> {
  if (records.length === 0) return;
  const cur = (await repo.getSetting<CorrectionRecord[]>(KEY)) ?? [];
  await repo.setSetting(KEY, mergeCorrections(cur, records));
}

export async function getCorrections(): Promise<CorrectionRecord[]> {
  return (await repo.getSetting<CorrectionRecord[]>(KEY)) ?? [];
}

export async function clearCorrections(): Promise<void> {
  await repo.setSetting(KEY, []);
}
