import { IMAGE_PREP } from "../config/constants.ts";

// Multi-page PDF intake. A scanner PDF is a *stack* of receipts — one per
// page — so PDFs are expanded here, at add time, into one JPEG per page and
// each page becomes its own receipt. (The pipeline's decode() keeps a
// first-page fallback only for PDFs stored by older versions of the app.)
//
// Pages render at a scale that puts the long edge near the OCR render size
// (IMAGE_PREP.ocrMaxEdge): scanner PDFs embed the scan as an image, and
// rasterizing a letter-size page at pdf.js's nominal 72 dpi would throw away
// most of the print the OCR needs.

export interface PdfPageImage {
  blob: Blob;
  pageNumber: number;
  pageCount: number;
}

let workerWired = false;

async function pdfjsLib(): Promise<typeof import("pdfjs-dist")> {
  // Lazy-load pdf.js so the (large) renderer is only pulled in for PDFs.
  const pdfjs = await import("pdfjs-dist");
  if (!workerWired) {
    // Vite resolves this worker URL at build time.
    pdfjs.GlobalWorkerOptions.workerSrc = (
      await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
    ).default;
    workerWired = true;
  }
  return pdfjs;
}

/** Render every page of a PDF to a JPEG blob sized for OCR. Throws on
 *  unreadable input — the caller falls back to storing the PDF as-is. */
export async function expandPdf(file: File | Blob): Promise<PdfPageImage[]> {
  const pdfjs = await pdfjsLib();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  try {
    const pages: PdfPageImage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(
        1,
        Math.min(4, IMAGE_PREP.ocrMaxEdge / Math.max(base.width, base.height)),
      );
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas 2d context unavailable");
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", IMAGE_PREP.ocrQuality),
      );
      if (!blob) throw new Error(`PDF page ${n} rendered empty`);
      pages.push({ blob, pageNumber: n, pageCount: doc.numPages });
      page.cleanup();
    }
    return pages;
  } finally {
    void doc.destroy();
  }
}

/** "scan.pdf" + page 2/8 → the intake fileName + display originalFileName. */
export function pdfPageNames(
  baseName: string,
  pageNumber: number,
  pageCount: number,
): { fileName: string; originalFileName: string } {
  const stem = baseName.replace(/\.pdf$/i, "") || "receipt";
  return pageCount > 1
    ? {
        fileName: `${stem}_p${pageNumber}.jpg`,
        originalFileName: `${baseName} (page ${pageNumber} of ${pageCount})`,
      }
    : { fileName: `${stem}.jpg`, originalFileName: baseName };
}
