// Print packet: the receipts laid out for PAPER. Offices still staple
// physical copies behind a reimbursement form, so this builds a Letter-size
// PDF of the receipt images — cropped to the strip that matters when the
// field boxes allow it — packed two columns to a page, large enough that the
// printed text survives an 8.5"×11" run. Every page carries the employee
// header, and every image carries its own file-name/amount/job caption (a
// batch may serve several jobs; the caption is per receipt, not per page).
//
// Dependency-free by design (like export/zip.ts): the images are already
// JPEG (canvas-recompressed), which PDF embeds verbatim via DCTDecode, so
// "building a PDF" is object bookkeeping, not encoding. Pure — no DOM — so
// Node tests can cover the layout and structure.

import type { BBox } from "../types.ts";

export interface PrintImage {
  /** JPEG bytes (canvas output: 3-component YCbCr → DeviceRGB). */
  jpeg: Uint8Array;
  /** Pixel dimensions of `jpeg`. */
  width: number;
  height: number;
  /** Caption line under the image (the receipt's file name). */
  name: string;
  /** Right-hand caption (formatted amount), optional. */
  amount?: string;
  /** Second caption line: this receipt's job name/number, optional. */
  job?: string;
}

export interface PrintMeta {
  employee?: string;
  jobName?: string;
  jobNumber?: string;
}

// Letter, portrait, in PDF points.
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 36;
const HEADER_H = 34; // title + rule under it
const CAPTION_LINE = 12;
const BLOCK_GAP = 14;
/** Two side-by-side columns keep a thermal receipt near its natural print
 *  width (~3.4"), so the text stays legible on paper; short field-strip
 *  crops stack several to a column. */
const COLS = 2;
const GUTTER = 18;
const CELL_W = (PAGE_W - MARGIN * 2 - GUTTER * (COLS - 1)) / COLS;
const CONTENT_TOP = PAGE_H - MARGIN - HEADER_H;
const CONTENT_BOTTOM = MARGIN;

/**
 * The vertical band of the receipt that holds the vendor, date and total,
 * with padding — the part worth printing. Null unless all three boxes are
 * known (a partial crop risks cutting the very line someone needs), or when
 * the strip wouldn't actually shorten the receipt. Normalized [0..1].
 */
export function receiptStrip(
  boxes: (BBox | undefined)[],
  pad = 0.045,
): { y0: number; y1: number } | null {
  if (boxes.length === 0 || boxes.some((b) => !b || b.w <= 0 || b.h <= 0)) return null;
  let y0 = 1;
  let y1 = 0;
  for (const b of boxes as BBox[]) {
    y0 = Math.min(y0, b.y);
    y1 = Math.max(y1, b.y + b.h);
  }
  y0 = Math.max(0, y0 - pad);
  y1 = Math.min(1, y1 + pad);
  if (y1 - y0 <= 0.02) return null; // degenerate boxes
  if (y1 - y0 >= 0.9) return null; // spans the receipt anyway — keep it whole
  return { y0, y1 };
}

export interface Placement {
  /** Index into the images array. */
  index: number;
  page: number;
  /** Left edge (pt). */
  x: number;
  /** TOP edge in PDF coordinates (origin bottom-left). */
  yTop: number;
  w: number;
  h: number;
  captionLines: number;
}

/** Column-flow packing: each image scaled to its column, placed in whichever
 *  column has the most room, new page when neither fits. Pure, so the layout
 *  is testable without writing a PDF. */
export function layoutPrintPages(
  images: { width: number; height: number; job?: string }[],
): Placement[] {
  const placements: Placement[] = [];
  let page = 0;
  // Remaining ceiling (yTop) per column on the current page.
  let colTop = [CONTENT_TOP, CONTENT_TOP];
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    const captionLines = img.job ? 2 : 1;
    const capH = captionLines * CAPTION_LINE + 4;
    const maxImgH = CONTENT_TOP - CONTENT_BOTTOM - capH;
    const scale = Math.min(CELL_W / img.width, maxImgH / img.height, 1.8);
    const w = img.width * scale;
    const h = img.height * scale;
    const blockH = h + capH + BLOCK_GAP;

    let col = colTop[0]! >= colTop[1]! ? 0 : 1;
    if (colTop[col]! - blockH < CONTENT_BOTTOM - BLOCK_GAP) {
      // Doesn't fit the roomier column → fresh page.
      page++;
      colTop = [CONTENT_TOP, CONTENT_TOP];
      col = 0;
    }
    const cellX = MARGIN + col * (CELL_W + GUTTER);
    placements.push({
      index: i,
      page,
      x: cellX + (CELL_W - w) / 2,
      yTop: colTop[col]!,
      w,
      h,
      captionLines,
    });
    colTop[col] = colTop[col]! - blockH;
  }
  return placements;
}

/** ASCII-sanitize for the PDF's WinAnsi Helvetica + escape ()\ delimiters.
 *  Common typographic punctuation degrades to ASCII instead of "?". */
function pdfText(s: string): string {
  return s
    .replace(/[—–·]/g, "-")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function headerLine(meta: PrintMeta): string {
  const who = meta.employee?.trim() || "";
  return who ? `Receipt packet - ${who}` : "Receipt packet";
}

/** Build the PDF file bytes. */
export function buildPrintPdf(images: PrintImage[], meta: PrintMeta): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = []; // byte offset per object id (1-based)
  let length = 0;

  const push = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    length += bytes.length;
  };
  const pushStr = (s: string): void => push(enc.encode(s));
  const beginObj = (id: number): void => {
    offsets[id] = length;
    pushStr(`${id} 0 obj\n`);
  };

  const placements = layoutPrintPages(images);
  const pageCount = Math.max(1, (placements[placements.length - 1]?.page ?? 0) + 1);

  // Object ids: 1 catalog · 2 pages · 3 font · then per page (page, contents)
  // and per image (XObject), assigned up front so refs can be written inline.
  const pageIds: number[] = [];
  const contentIds: number[] = [];
  const imageIds: number[] = [];
  let nextId = 4;
  for (let p = 0; p < pageCount; p++) {
    pageIds.push(nextId++);
    contentIds.push(nextId++);
  }
  for (let i = 0; i < images.length; i++) imageIds.push(nextId++);

  pushStr("%PDF-1.4\n%âãÏÓ\n");

  beginObj(1);
  pushStr(`<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  beginObj(2);
  pushStr(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>\nendobj\n`,
  );
  beginObj(3);
  pushStr(
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`,
  );

  const title = pdfText(headerLine(meta));
  for (let p = 0; p < pageCount; p++) {
    const onPage = placements.filter((pl) => pl.page === p);

    // Content stream: header text, rule, then each image + captions.
    let cs = "";
    const headerY = PAGE_H - MARGIN - 12;
    cs += `BT /F1 11 Tf ${MARGIN} ${headerY} Td (${title}) Tj ET\n`;
    const pageLabel = pdfText(`Page ${p + 1} of ${pageCount}`);
    // Right-aligned-ish: Helvetica ~0.5em average advance at 9pt.
    const plW = pageLabel.length * 4.5;
    cs += `BT /F1 9 Tf ${PAGE_W - MARGIN - plW} ${headerY} Td (${pageLabel}) Tj ET\n`;
    const ruleY = CONTENT_TOP + 14;
    cs += `0.8 0.8 0.8 RG 0.75 w ${MARGIN} ${ruleY} m ${PAGE_W - MARGIN} ${ruleY} l S\n`;

    for (const pl of onPage) {
      const img = images[pl.index]!;
      const y = pl.yTop - pl.h;
      cs += `q ${pl.w.toFixed(2)} 0 0 ${pl.h.toFixed(2)} ${pl.x.toFixed(2)} ${y.toFixed(2)} cm /Im${pl.index} Do Q\n`;

      const cellX = pl.x + pl.w / 2 - CELL_W / 2;
      const cap = pdfText(img.name.length > 46 ? `${img.name.slice(0, 45)}…` : img.name);
      const capY = y - 10;
      cs += `BT /F1 8 Tf ${Math.max(MARGIN, cellX).toFixed(2)} ${capY.toFixed(2)} Td (${cap}) Tj ET\n`;
      if (img.amount) {
        const amt = pdfText(img.amount);
        const aw = amt.length * 4;
        cs += `BT /F1 8 Tf ${(Math.max(MARGIN, cellX) + CELL_W - aw).toFixed(2)} ${capY.toFixed(2)} Td (${amt}) Tj ET\n`;
      }
      if (img.job) {
        const job = pdfText(img.job.length > 56 ? `${img.job.slice(0, 55)}…` : img.job);
        cs += `0.45 0.45 0.45 rg BT /F1 7.5 Tf ${Math.max(MARGIN, cellX).toFixed(2)} ${(capY - CAPTION_LINE).toFixed(2)} Td (${job}) Tj ET 0 0 0 rg\n`;
      }
    }

    const csBytes = enc.encode(cs);
    const xobjects = onPage
      .map((pl) => `/Im${pl.index} ${imageIds[pl.index]} 0 R`)
      .join(" ");
    beginObj(pageIds[p]!);
    pushStr(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 3 0 R >> /XObject << ${xobjects} >> >> ` +
        `/Contents ${contentIds[p]} 0 R >>\nendobj\n`,
    );
    beginObj(contentIds[p]!);
    pushStr(`<< /Length ${csBytes.length} >>\nstream\n`);
    push(csBytes);
    pushStr(`\nendstream\nendobj\n`);
  }

  images.forEach((img, i) => {
    beginObj(imageIds[i]!);
    pushStr(
      `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${img.jpeg.length} >>\nstream\n`,
    );
    push(img.jpeg);
    pushStr(`\nendstream\nendobj\n`);
  });

  // xref + trailer
  const xrefStart = length;
  const count = nextId; // ids 0..nextId-1 (0 is the free head)
  pushStr(`xref\n0 ${count}\n`);
  pushStr(`0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) {
    pushStr(`${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`);
  }
  pushStr(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/** "Receipt_Packet_<employee>_<yyyymmdd>.pdf", matching the workbook's stamp. */
export function printPdfFileName(employee: string | undefined, now = new Date()): string {
  const who = (employee || "Employee").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_") || "Employee";
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return `Receipt_Packet_${who}_${stamp}.pdf`;
}
