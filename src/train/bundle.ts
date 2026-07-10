import { repo } from "../store/repo.ts";
import { getCorrections } from "./corrections.ts";
import { buildZip } from "../export/zip.ts";
import { toCsv } from "../export/csv.ts";
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
}

export async function buildTuningBundle(receipts: Receipt[]): Promise<TuningBundle> {
  const enc = new TextEncoder();
  const corrections = await getCorrections();
  const entries: { name: string; data: Uint8Array }[] = [
    { name: "corrections.json", data: enc.encode(JSON.stringify(corrections, null, 2)) },
    {
      name: "extraction.json",
      data: enc.encode(
        JSON.stringify(
          receipts.map((r) => ({
            id: r.id,
            fileName: r.fileName,
            originalFileName: r.originalFileName,
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
    { name: "report.csv", data: enc.encode(toCsv(receipts)) },
  ];
  const used = new Set(entries.map((e) => e.name));
  const uniq = (base: string): string => {
    let n = base;
    for (let i = 2; used.has(n); i++) {
      const dot = base.lastIndexOf(".");
      n = dot > 0 ? `${base.slice(0, dot)}_${i}${base.slice(dot)}` : `${base}_${i}`;
    }
    used.add(n);
    return n;
  };
  for (const r of receipts) {
    const orig = await repo.getBlob(r.fileKey);
    if (orig) {
      entries.push({
        name: uniq(`images/original/${r.originalFileName ?? r.fileName}`),
        data: new Uint8Array(await orig.arrayBuffer()),
      });
    }
    const annKey = r.annotatedKey ?? r.cleanedKey;
    const ann = annKey ? await repo.getBlob(annKey) : undefined;
    if (ann) {
      entries.push({
        name: uniq(`images/annotated/${r.fileName}`),
        data: new Uint8Array(await ann.arrayBuffer()),
      });
    }
  }
  const blob = await buildZip(entries);
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return {
    blob,
    fileName: `dueback_tuning_${stamp}.zip`,
    receiptCount: receipts.length,
    correctionCount: corrections.length,
  };
}

/** Trigger a browser download of the bundle. */
export function downloadBundle(bundle: TuningBundle): void {
  const url = URL.createObjectURL(bundle.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = bundle.fileName;
  a.click();
  URL.revokeObjectURL(url);
}
