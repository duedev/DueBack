import { IMAGE_PREP, LIMITS } from "../config/constants.ts";

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

export interface PdfExpansion {
  pages: PdfPageImage[];
  /** 1-based numbers of pages that failed to render (corrupt streams). */
  failedPages: number[];
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

/** True for pdf.js's password-protected-document error; the caller tells
 *  the user instead of queuing a receipt that is guaranteed to fail. */
export function isPasswordProtectedPdf(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "PasswordException";
}

/** Render the pages of a PDF to JPEG blobs sized for OCR. Throws on
 *  unreadable input — the caller falls back to storing the PDF as-is. A
 *  single page that fails to render is skipped (its number is reported in
 *  `failedPages`) rather than discarding the pages that did render.
 *  Rendering stops at `maxPages` (the caller passes its remaining batch
 *  capacity) and at the `LIMITS.maxPdfPages` backstop — rasterizing pages the
 *  batch cap would discard anyway burns minutes and memory. Each returned
 *  page still reports the document's full `pageCount`, so the caller can see
 *  how many pages went unrendered. */
export async function expandPdf(
  file: File | Blob,
  maxPages = LIMITS.maxPdfPages,
): Promise<PdfExpansion> {
  const pdfjs = await pdfjsLib();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  try {
    const pages: PdfPageImage[] = [];
    const failedPages: number[] = [];
    const last = Math.min(doc.numPages, maxPages, LIMITS.maxPdfPages);
    for (let n = 1; n <= last; n++) {
      try {
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
        // Release the rasterized page before the next one — a 300-page scan
        // otherwise held every ~21 MB canvas until the loop ended.
        canvas.width = 0;
        canvas.height = 0;
      } catch (err) {
        // One corrupt page must not throw away the pages that rendered.
        failedPages.push(n);
        console.warn(`[pdf] page ${n} failed to render`, err);
      }
    }
    if (pages.length === 0 && failedPages.length > 0) {
      throw new Error(`no page of this PDF could be rendered`);
    }
    return { pages, failedPages };
  } finally {
    void doc.destroy();
  }
}

/** "scan.pdf" + page 2/8 → the intake fileName + display originalFileName.
 *  `displayName` defaults to the file's own name but differs when the PDF
 *  came out of an archive, where the card should show its path inside it. */
export function pdfPageNames(
  baseName: string,
  pageNumber: number,
  pageCount: number,
  displayName: string = baseName,
): { fileName: string; originalFileName: string } {
  const stem = baseName.replace(/\.pdf$/i, "") || "receipt";
  return pageCount > 1
    ? {
        fileName: `${stem}_p${pageNumber}.jpg`,
        originalFileName: `${displayName} (page ${pageNumber} of ${pageCount})`,
      }
    : { fileName: `${stem}.jpg`, originalFileName: displayName };
}
