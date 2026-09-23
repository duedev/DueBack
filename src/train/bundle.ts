import { repo } from "../store/repo.ts";
import { getCorrections } from "./corrections.ts";
import { buildZip } from "../export/zip.ts";
import { toCsvBytes } from "../export/csv.ts";
import { isLegacyAiRead, ocrLinesText, parseLegacyMethod, tailCap } from "../pipeline/vision/provenance.ts";
import type { Receipt } from "../types.ts";

// One ZIP with everything a tuning session needs: the corrections log, every
// receipt's full extraction (fields, flags, OCR text + line geometry, cost,
// and — for an AI read — its provenance: backend, model, one-shot vs
// agentic, the model's own answer and the rules read it replaced), the
// report CSV, and the original + highlighted images — so failures can be
// reproduced from the exact inputs. Used by Settings ("Download tuning
// bundle") and the contact form's attach checkbox.
//
// Two modes. FULL ships every original verbatim plus the stored 1600px
// highlighted copy — what an OCR-tuning session needs to re-read the exact
// input. COMPACT is for SHARING (with an AI assistant, or by email where
// attachments cap near 25 MB): the same three data files, no originals, and
// each highlighted copy re-encoded at COMPACT_IMAGE_EDGE / _QUALITY. A real
// 67-receipt batch (two scanned PDFs + a 37-page e-receipt PDF) came out too
// big to upload anywhere, and the owner had to delete the images by hand.

export type BundleMode = "full" | "compact";

/** Compact mode's long edge (px) and JPEG quality for the highlighted
 *  copies: receipt text stays legible to a reader (human or model), and a
 *  60–100 receipt batch lands well under 25 MB. */
export const COMPACT_IMAGE_EDGE = 1100;
export const COMPACT_IMAGE_QUALITY = 0.7;

export interface TuningBundle {
  blob: Blob;
  fileName: string;
  mode: BundleMode;
  receiptCount: number;
  correctionCount: number;
  /** Originals left out: past the budget in full mode (the annotated
   *  1600px copy is still included for each); every row in compact mode. */
  omittedOriginals: number;
}

/** The I/O a bundle needs, injectable so Node tests build real archives
 *  from fakes (no IndexedDB, no canvas). */
export interface BundleDeps {
  getBlob(key: string): Promise<Blob | undefined>;
  getCorrections(): Promise<unknown[]>;
  /** Compact mode's re-encode of a stored highlighted JPEG. UNTRIMMED
   *  (`thumbnail(…, trim = false)`): a uniform downscale keeps every
   *  normalized box in extraction.json on the same pixels, where the export
   *  trim would crop a legacy whole page and shift them all. */
  shrink(blob: Blob): Promise<Uint8Array>;
}

const APP_DEPS: BundleDeps = {
  getBlob: (key) => repo.getBlob(key),
  getCorrections,
  async shrink(blob) {
    const { thumbnail } = await import("../export/images.ts");
    const t = await thumbnail(blob, COMPACT_IMAGE_EDGE, COMPACT_IMAGE_QUALITY, "edge", false);
    return new Uint8Array(t.buffer);
  },
};

/** "dueback_tuning_20260923.zip" / "dueback_tuning_compact_20260923.zip"
 *  (local date, like the report's stamp). Pure; Node-tested. */
export function bundleFileName(mode: BundleMode, now = new Date()): string {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return `dueback_tuning_${mode === "compact" ? "compact_" : ""}${stamp}.zip`;
}

/** Archive entry name for a receipt's highlighted copy. That copy is always
 *  JPEG, so it is named by the receipt's stem + .jpg: a receipt renamed by
 *  an older version (which kept the upload's .heic/.png) still lands with
 *  an honest extension. Pure; Node-tested. */
export function annotatedEntryName(r: Pick<Receipt, "fileName">): string {
  const stem = r.fileName.replace(/\.[a-z0-9]{2,5}$/i, "") || "receipt";
  return `images/annotated/${stem}.jpg`;
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

/** One receipt's extraction.json row. An AI read carries its `assist`
 *  provenance; a row stored before provenance existed (`isLegacyAiRead`)
 *  held the MODEL'S answer in `ocrText`, so its old `methodDetail` is parsed
 *  into provider/model/strategy, the answer moves to `assist.rawAnswer`, and
 *  `ocrText` is rebuilt from the OCR lines. Pure; Node-tested. */
export function extractionEntry(r: Receipt, originalOmitted = false): Record<string, unknown> {
  const legacy = isLegacyAiRead(r);
  return {
    id: r.id,
    fileName: r.fileName,
    originalFileName: r.originalFileName,
    ...(originalOmitted ? { originalOmitted: true } : {}),
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
    ...(r.assist
      ? { assist: r.assist }
      : legacy
        ? {
            assist: {
              legacy: true,
              ...parseLegacyMethod(r.methodDetail),
              rawAnswer: tailCap(r.ocrText ?? ""),
            },
          }
        : {}),
    cost: r.cost,
    ocrText: legacy ? ocrLinesText(r.ocrLines) : r.ocrText,
    ocrLines: r.ocrLines,
  };
}

export async function buildTuningBundle(
  receipts: Receipt[],
  opts: { mode?: BundleMode; deps?: BundleDeps; now?: Date } = {},
): Promise<TuningBundle> {
  const mode = opts.mode ?? "full";
  const deps = opts.deps ?? APP_DEPS;
  const enc = new TextEncoder();
  const corrections = await deps.getCorrections();
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
    if (mode === "compact") {
      // Compact never ships originals, and says so on every row.
      omitted.add(r.id);
    } else {
      const orig = await deps.getBlob(r.fileKey);
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
    }
    const annKey = r.annotatedKey ?? r.cleanedKey;
    const ann = annKey ? await deps.getBlob(annKey) : undefined;
    if (ann) {
      const stored = new Uint8Array(await ann.arrayBuffer());
      let data: Uint8Array = stored;
      if (mode === "compact") {
        // Never bigger than the stored copy (a small, already-light JPEG can
        // grow on re-encode), and a failed decode ships the stored bytes
        // rather than drop the receipt's only image.
        try {
          const shrunk = await deps.shrink(ann);
          if (shrunk.length > 0 && shrunk.length < stored.length) data = shrunk;
        } catch {
          /* keep the stored copy */
        }
      }
      images.push({ name: uniq(annotatedEntryName(r)), data, compress: false });
    }
  }
  const entries: { name: string; data: Uint8Array; compress?: boolean }[] = [
    { name: "corrections.json", data: enc.encode(JSON.stringify(corrections, null, 2)) },
    {
      name: "extraction.json",
      data: enc.encode(
        JSON.stringify(
          receipts.map((r) => extractionEntry(r, omitted.has(r.id))),
          null,
          2,
        ),
      ),
    },
    { name: "report.csv", data: toCsvBytes(receipts) },
    ...images,
  ];
  const blob = await buildZip(entries);
  return {
    blob,
    fileName: bundleFileName(mode, opts.now),
    mode,
    receiptCount: receipts.length,
    correctionCount: corrections.length,
    omittedOriginals: omitted.size,
  };
}

/** "18.4 MB" / "640 KB" — the bundle's size for the toast, so a sender knows
 *  before attaching whether it fits (mail caps near 25 MB). Pure. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
