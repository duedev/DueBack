// Print packet: the receipts laid out for PAPER. Offices still staple
// physical copies behind a reimbursement form, so this builds a Letter-size
// PDF with two receipts per page — large enough that the printed text
// survives an 8.5"×11" run — labeled with the employee/job header on every
// page and each receipt's file name + amount under its image.
//
// Dependency-free by design (like export/zip.ts): the images are already
// JPEG (canvas-recompressed), which PDF embeds verbatim via DCTDecode, so
// "building a PDF" is object bookkeeping, not encoding. Pure — no DOM — so
// Node tests can cover the layout and structure.

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
const CAPTION_H = 16;
const GUTTER = 18;
/** Receipts per page: two side-by-side columns keep a thermal receipt near
 *  its natural print width (~3.4"), so the text stays legible on paper. */
const COLS = 2;

const CELL_W = (PAGE_W - MARGIN * 2 - GUTTER * (COLS - 1)) / COLS;
const CELL_H = PAGE_H - MARGIN * 2 - HEADER_H;

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
  const parts = [
    meta.employee?.trim() || "",
    meta.jobName?.trim() || "",
    meta.jobNumber?.trim() ? `#${meta.jobNumber.trim()}` : "",
  ].filter(Boolean);
  return parts.length ? `Receipt packet - ${parts.join(" - ")}` : "Receipt packet";
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

  // Object ids: 1 catalog · 2 pages · 3 font · then per page (page, contents)
  // and per image (XObject), assigned up front so refs can be written inline.
  const pageCount = Math.max(1, Math.ceil(images.length / COLS));
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
    const slice = images.slice(p * COLS, p * COLS + COLS);

    // Content stream: header text, rule, then each image + caption.
    let cs = "";
    const headerY = PAGE_H - MARGIN - 12;
    cs += `BT /F1 11 Tf ${MARGIN} ${headerY} Td (${title}) Tj ET\n`;
    const pageLabel = pdfText(`Page ${p + 1} of ${pageCount}`);
    // Right-aligned-ish: Helvetica ~0.5em average advance at 9pt.
    const plW = pageLabel.length * 4.5;
    cs += `BT /F1 9 Tf ${PAGE_W - MARGIN - plW} ${headerY} Td (${pageLabel}) Tj ET\n`;
    const ruleY = PAGE_H - MARGIN - HEADER_H + 14;
    cs += `0.8 0.8 0.8 RG 0.75 w ${MARGIN} ${ruleY} m ${PAGE_W - MARGIN} ${ruleY} l S\n`;

    slice.forEach((img, i) => {
      const cellX = MARGIN + i * (CELL_W + GUTTER);
      const cellTop = PAGE_H - MARGIN - HEADER_H;
      const boxH = CELL_H - CAPTION_H;
      // Fit, allowing modest upscale so small receipts stay readable but a
      // low-res photo isn't blown into a blur.
      const scale = Math.min(CELL_W / img.width, boxH / img.height, 1.8);
      const w = img.width * scale;
      const h = img.height * scale;
      const x = cellX + (CELL_W - w) / 2;
      const y = cellTop - h; // top-aligned in the cell
      const n = p * COLS + i;
      cs += `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im${n} Do Q\n`;

      const cap = pdfText(img.name.length > 46 ? `${img.name.slice(0, 45)}…` : img.name);
      const capY = y - 11;
      cs += `BT /F1 8 Tf ${cellX} ${capY.toFixed(2)} Td (${cap}) Tj ET\n`;
      if (img.amount) {
        const amt = pdfText(img.amount);
        const aw = amt.length * 4;
        cs += `BT /F1 8 Tf ${(cellX + CELL_W - aw).toFixed(2)} ${capY.toFixed(2)} Td (${amt}) Tj ET\n`;
      }
    });

    const csBytes = enc.encode(cs);
    const xobjects = slice
      .map((_, i) => `/Im${p * COLS + i} ${imageIds[p * COLS + i]} 0 R`)
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
