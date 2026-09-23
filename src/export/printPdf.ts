// Print packet: the receipts laid out for PAPER. Offices still staple
// physical copies behind a reimbursement form, so this builds a Letter-size
// PDF of the receipt images — cropped to the strip that matters when the
// field boxes allow it — packed two columns to a page, large enough that the
// printed text survives an 8.5"×11" run. Every page carries the employee
// header, and every image carries its own section label ("Fuel #2"), file
// name, amount and job caption. The job is the batch's today, but it is
// stamped per image so a per-receipt job later needs no layout change.
//
// Dependency-free by design (like export/zip.ts): the images are already
// JPEG (canvas-recompressed), which PDF embeds verbatim via DCTDecode, so
// "building a PDF" is object bookkeeping, not encoding. Pure — no DOM — so
// Node tests can cover the layout and structure.

import type { BBox } from "../types.ts";
import { employeeFilePart } from "../util/rename.ts";

export interface PrintImage {
  /** JPEG bytes (canvas output: 3-component YCbCr → DeviceRGB). */
  jpeg: Uint8Array;
  /** Pixel dimensions of `jpeg`. */
  width: number;
  height: number;
  /** Caption line under the image (the receipt's file name). */
  name: string;
  /** Section label that precedes the name — the workbook's "Fuel #2" — so
   *  the paper packet reads alongside the Summary. Optional. */
  label?: string;
  /** Right-hand caption (formatted amount), optional. */
  amount?: string;
  /** Second caption line: the job name/number (the batch's, per image so a
   *  batch may span jobs later), optional. */
  job?: string;
}

export interface PrintMeta {
  employee?: string;
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
/** Caption font sizes (pt): the label/name/amount line and the job line. */
const CAPTION_PT = 8;
const JOB_PT = 7.5;
/** Space kept between the caption text and the right-aligned amount (pt). */
const AMOUNT_GAP = 6;

/** A stored OCR line's text and box — `Receipt.ocrLines` entries fit. */
export interface StripLine {
  text: string;
  bbox: BBox;
}

export interface StripOptions {
  /** Padding above and below the band (normalized). */
  pad?: number;
  /** The receipt's stored OCR lines (`Receipt.ocrLines`, the same
   *  normalized frame as the field boxes). The band's bottom follows the
   *  tender/total lines printed under the amount; without lines it gets a
   *  fixed extra pad instead. */
  lines?: readonly StripLine[];
}

/** Lines under the grand total that belong with it on paper: the echo total
 *  ("TOTAL = $ 107.62" under a Chevron "FUEL TOTAL"), the tender and the
 *  change. Word-bounded, so SUBTOTAL/CASHIER/EXCHANGE don't count. */
const TENDER_LINE_RE =
  /\b(?:total|credit|debit|cash|change|balance|visa|master\s?card|amex|american\s?express)\b/i;
/** How far (in line heights) the next tender line may sit below the band's
 *  current bottom. The Chevron app leaves blank lines between FUEL TOTAL and
 *  its "TOTAL =" echo — 4.0–6.6 line heights across the owner's 37
 *  e-receipts — and CREDIT follows ~2.5 below that. */
const TENDER_GAP_LINES = 8;
/** Extra bottom padding when there are no stored lines to follow. */
const TENDER_PAD_FALLBACK = 0.03;

/** Bottom (normalized) of the amount plus the chain of tender/total lines
 *  printed under it: each must start within TENDER_GAP_LINES line heights
 *  of the band's bottom so far, so the walk stops at the first real gap
 *  instead of wandering into a footer. */
function tenderBottom(amount: BBox, lines: readonly StripLine[]): number {
  const valid = lines.filter((l) => l.bbox && l.bbox.w > 0 && l.bbox.h > 0);
  const heights = valid.map((l) => l.bbox.h).sort((p, q) => p - q);
  const unit = heights.length ? heights[heights.length >> 1]! : amount.h;
  let reach = amount.y + amount.h;
  const below = valid
    .filter((l) => l.bbox.y > amount.y + amount.h / 2) // not the amount's own line
    .sort((p, q) => p.bbox.y - q.bbox.y);
  for (const l of below) {
    if (l.bbox.y - reach > TENDER_GAP_LINES * unit) break;
    if (TENDER_LINE_RE.test(l.text)) reach = Math.max(reach, l.bbox.y + l.bbox.h);
  }
  return reach;
}

/**
 * The vertical band of the receipt that holds the vendor, date and total,
 * with padding — the part worth printing. `boxes` are the field boxes with
 * the AMOUNT's LAST (ExportBar passes vendor, date, amount). Null unless all
 * of them are known (a partial crop risks cutting the very line someone
 * needs), or when the strip wouldn't actually shorten the receipt.
 * Normalized [0..1].
 *
 * The TOP edge comes only from the amount and the fields above it: a field
 * found below the amount's top (a brand named in a footer ad, a date printed
 * under the tender lines) only ever extends the bottom. The BOTTOM edge runs
 * past the amount through the tender/total lines printed right under it
 * (`tenderBottom`) — the owner's Chevron strips ended at FUEL TOTAL and cut
 * off "TOTAL = $107.62" and "CREDIT $107.62".
 *
 * A bare number as `opts` is the padding (the pre-options signature).
 */
export function receiptStrip(
  boxes: (BBox | undefined)[],
  opts: StripOptions | number = {},
): { y0: number; y1: number } | null {
  const { pad = 0.045, lines } = typeof opts === "number" ? { pad: opts } : opts;
  if (boxes.length === 0 || boxes.some((b) => !b || b.w <= 0 || b.h <= 0)) return null;
  const fields = boxes as BBox[];
  const amount = fields[fields.length - 1]!;
  let y0 = amount.y;
  let y1 = lines?.length
    ? tenderBottom(amount, lines)
    : amount.y + amount.h + TENDER_PAD_FALLBACK;
  for (const b of fields) {
    if (b.y < amount.y) y0 = Math.min(y0, b.y);
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

/** Sanitize for the PDF's WinAnsi Helvetica. WinAnsi's 0xA0–0xFF is
 *  byte-identical to Latin-1, so é/ñ/ü render as themselves (they used to
 *  degrade to "?" on the employee's own header line); NFC first so a
 *  decomposed "é" collapses to one code point instead of "e?". Common
 *  typographic punctuation degrades to ASCII; anything past U+00FF (Ł, CJK)
 *  is still "?". The content stream must then be encoded as Latin-1 bytes,
 *  never UTF-8 (`latin1` below). Widths are measured on THIS form. */
function winAnsi(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[—–·]/g, "-")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
}

/** Escape the ()\ string delimiters — last, after any measuring. */
function escapePdf(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Sanitized and escaped: ready to drop between ( ) in a content stream. */
function pdfText(s: string): string {
  return escapePdf(winAnsi(s));
}

/** Helvetica advance widths (1/1000 em) from the standard AFM, for WinAnsi
 *  0x20–0x7E and 0xA0–0xFF — the only codes `winAnsi` emits. */
// prettier-ignore
const HELV_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
// prettier-ignore
const HELV_LATIN1 = [
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

/** Rendered width (pt) of `winAnsi` text in Helvetica at `size` pt. */
export function textWidth(s: string, size: number): number {
  let units = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    units +=
      c >= 0x20 && c <= 0x7e
        ? HELV_ASCII[c - 0x20]!
        : c >= 0xa0 && c <= 0xff
          ? HELV_LATIN1[c - 0xa0]!
          : 556;
  }
  return (units * size) / 1000;
}

/** `s` cut (with "...") to fit `maxW` pt at `size` pt; "" when not even the
 *  ellipsis fits. Measured, so "fuel_…_bubble_machine_car_wash" gives way
 *  by what it actually occupies — a fixed character budget either spilled
 *  wide names (W, M) into the amount or cut narrow ones (i, l, _) early. */
export function fitText(s: string, size: number, maxW: number): string {
  if (textWidth(s, size) <= maxW) return s;
  const budget = maxW - textWidth("...", size);
  if (budget <= 0) return "";
  let w = 0;
  let i = 0;
  for (; i < s.length; i++) {
    const cw = textWidth(s[i]!, size);
    if (w + cw > budget) break;
    w += cw;
  }
  return `${s.slice(0, i).trimEnd()}...`;
}

/** A caption's file name without the ".jpg" every stored receipt carries
 *  (util/rename.ts) — it says nothing on paper and cost the name its tail. */
function captionStem(name: string): string {
  return name.replace(/\.jpe?g$/i, "");
}

function headerLine(meta: PrintMeta): string {
  const who = meta.employee?.trim() || "";
  return who ? `Receipt packet - ${who}` : "Receipt packet";
}

/** Build the PDF file bytes. */
export function buildPrintPdf(images: PrintImage[], meta: PrintMeta): Uint8Array {
  const enc = new TextEncoder();
  // Content streams carry pdfText output, which is Latin-1 by construction;
  // TextEncoder is UTF-8 and would render "é" as "Ã©" under WinAnsi.
  const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
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
    const pageLabel = winAnsi(`Page ${p + 1} of ${pageCount}`);
    const plW = textWidth(pageLabel, 9);
    cs += `BT /F1 9 Tf ${(PAGE_W - MARGIN - plW).toFixed(2)} ${headerY} Td (${escapePdf(pageLabel)}) Tj ET\n`;
    const ruleY = CONTENT_TOP + 14;
    cs += `0.8 0.8 0.8 RG 0.75 w ${MARGIN} ${ruleY} m ${PAGE_W - MARGIN} ${ruleY} l S\n`;

    for (const pl of onPage) {
      const img = images[pl.index]!;
      const y = pl.yTop - pl.h;
      cs += `q ${pl.w.toFixed(2)} 0 0 ${pl.h.toFixed(2)} ${pl.x.toFixed(2)} ${y.toFixed(2)} cm /Im${pl.index} Do Q\n`;

      const cellX = pl.x + pl.w / 2 - CELL_W / 2;
      const left = Math.max(MARGIN, cellX);
      const capY = y - 10;
      // Widths are MEASURED (Helvetica AFM): the amount right-aligns on its
      // real width, and the file name — never the label ("Fuel #2") — gives
      // way so the caption clears it.
      const amt = img.amount ? winAnsi(img.amount) : "";
      const aw = amt ? textWidth(amt, CAPTION_PT) : 0;
      const label = img.label ? `${winAnsi(img.label)}  ` : "";
      const room = CELL_W - (amt ? aw + AMOUNT_GAP : 0) - textWidth(label, CAPTION_PT);
      const cap = `${label}${fitText(captionStem(winAnsi(img.name)), CAPTION_PT, room)}`.trimEnd();
      cs += `BT /F1 ${CAPTION_PT} Tf ${left.toFixed(2)} ${capY.toFixed(2)} Td (${escapePdf(cap)}) Tj ET\n`;
      if (amt) {
        cs += `BT /F1 ${CAPTION_PT} Tf ${(left + CELL_W - aw).toFixed(2)} ${capY.toFixed(2)} Td (${escapePdf(amt)}) Tj ET\n`;
      }
      if (img.job) {
        const job = escapePdf(fitText(winAnsi(img.job), JOB_PT, CELL_W));
        cs += `0.45 0.45 0.45 rg BT /F1 ${JOB_PT} Tf ${left.toFixed(2)} ${(capY - CAPTION_LINE).toFixed(2)} Td (${job}) Tj ET 0 0 0 rg\n`;
      }
    }

    const csBytes = latin1(cs);
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
  // Accents fold to ASCII (the same rule as the workbook's file name).
  const who = employeeFilePart(employee);
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return `Receipt_Packet_${who}_${stamp}.pdf`;
}
