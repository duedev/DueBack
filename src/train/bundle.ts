import { repo } from "../store/repo.ts";
import { getCorrections } from "./corrections.ts";
import { buildZip } from "../export/zip.ts";
import { toCsvBytes } from "../export/csv.ts";
import type { Receipt } from "../types.ts";

// One ZIP with everything a tuning session needs: the corrections log, every
// receipt's full extraction (fields, flags, OCR text + line geometry), the
// report CSV, and the original + highlighted images — so failures can be
// reproduced from the exact inputs. Used by Settings ("Download tuning
// bundle") and the contact form's attach checkbox.

export interface TuningBundle {
  blob: Blob;
  fileName: string;
  receiptCount: number;
  correctionCount: number;
  /** Originals left out to keep the archive under the budget (the
   *  annotated 1600px copy is still included for each). */
  omittedOriginals: number;
}

/** Originals are stored verbatim (up to 25 MB each, 200 per batch): a
 *  phone-photo batch could ask for gigabytes of ArrayBuffers plus the ZIP's
 *  own copy. Past this budget the original is left out — the annotated copy
 *  carries the geometry a tuning session needs. */
export const BUNDLE_ORIGINALS_BUDGET = 200 * 1024 * 1024;

/** Archive entry name for an original: "trip.zip › 2026/03/scan.pdf (page
 *  2 of 8)" must not nest folders or lose its extension. */
export function originalEntryName(r: Pick<Receipt, "fileName" | "originalFileName" | "mimeType">, blobType?: string): string {
  const raw = (r.originalFileName ?? r.fileName).replace(/\s*›\s*/g, "__").replace(/[\\/]/g, "_");
  if (/\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?|pdf)$/i.test(raw)) return raw;
  const type = (blobType || r.mimeType || "").toLowerCase();
  const ext = type.includes("png")
    ? ".png"
    : type.includes("webp")
      ? ".webp"
      : type.includes("pdf")
        ? ".pdf"
        : type.includes("heic") || type.includes("heif")
          ? ".heic"
          : ".jpg";
  return raw + ext;
}

export async function buildTuningBundle(receipts: Receipt[]): Promise<TuningBundle> {
  const enc = new TextEncoder();
  const corrections = await getCorrections();
  const omitted = new Set<string>();
  const images: { name: string; data: Uint8Array; compress: false }[] = [];
  const used = new Set(["corrections.json", "extraction.json", "report.csv"]);
  const uniq = (base: string): string => {
    let n = base;
    for (let i = 2; used.has(n); i++) {
      const dot = base.lastIndexOf(".");
      n = dot > 0 ? `${base.slice(0, dot)}_${i}${base.slice(dot)}` : `${base}_${i}`;
    }
    used.add(n);
    return n;
  };
  let originalBytes = 0;
  for (const r of receipts) {
    const orig = await repo.getBlob(r.fileKey);
    if (orig) {
      if (originalBytes + orig.size > BUNDLE_ORIGINALS_BUDGET) {
        omitted.add(r.id);
      } else {
        originalBytes += orig.size;
        images.push({
          name: uniq(`images/original/${originalEntryName(r, orig.type)}`),
          data: new Uint8Array(await orig.arrayBuffer()),
          compress: false,
        });
      }
    }
    const annKey = r.annotatedKey ?? r.cleanedKey;
    const ann = annKey ? await repo.getBlob(annKey) : undefined;
    if (ann) {
      // The annotated/cleaned copy is always JPEG; name it by the receipt's
      // stem + .jpg so a receipt renamed by an older version (which kept the
      // upload's .heic/.png) still lands with an honest extension.
      const stem = r.fileName.replace(/\.[a-z0-9]{2,5}$/i, "") || "receipt";
      images.push({
        name: uniq(`images/annotated/${stem}.jpg`),
        data: new Uint8Array(await ann.arrayBuffer()),
        compress: false,
      });
    }
  }
  const entries: { name: string; data: Uint8Array; compress?: boolean }[] = [
    { name: "corrections.json", data: enc.encode(JSON.stringify(corrections, null, 2)) },
    {
      name: "extraction.json",
      data: enc.encode(
        JSON.stringify(
          receipts.map((r) => ({
            id: r.id,
            fileName: r.fileName,
            originalFileName: r.originalFileName,
            ...(omitted.has(r.id) ? { originalOmitted: true } : {}),
            status: r.status,
            approved: r.approved,
            reviewRequired: r.reviewRequired,
            vendor: r.vendor,
            date: r.date,
            amount: r.amount,
            tax: r.tax,
            category: r.category,
            currency: r.currency,
            confidence: r.confidence,
            flags: r.flags,
            method: r.methodDetail ?? r.methodUsed,
            ocrText: r.ocrText,
            ocrLines: r.ocrLines,
          })),
          null,
          2,
        ),
      ),
    },
    { name: "report.csv", data: toCsvBytes(receipts) },
    ...images,
  ];
  const blob = await buildZip(entries);
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return {
    blob,
    fileName: `dueback_tuning_${stamp}.zip`,
    receiptCount: receipts.length,
    correctionCount: corrections.length,
    omittedOriginals: omitted.size,
  };
}

/** Trigger a browser download of the bundle. */
export function downloadBundle(bundle: TuningBundle): void {
  const url = URL.createObjectURL(bundle.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = bundle.fileName;
  a.click();
  // Deferred like ExportBar's download(): a synchronous revoke can abort the
  // download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
