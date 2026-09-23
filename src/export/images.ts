// Export-time image compression (§8). Originals/cleaned images stay sharp for
// OCR; only here, when building the workbook, do we shrink them to keep the
// file small. Runs on a <canvas> in the browser.
//
// Every receipt-image EXPORT goes through `thumbnail`/`stripThumbnail`, which
// also trim a receipt stored as a whole blank page (see `contentRect`). The
// tuning bundle must NOT trim: the normalized boxes in its extraction.json
// have to stay aligned with its images, so the full bundle ships the stored
// blobs verbatim and the compact one calls `thumbnail(…, trim = false)` — a
// uniform downscale moves no box.

import {
  ANALYSIS_MAX_EDGE,
  inkContentBox,
  isFullPageAspect,
  toGrayscale,
  type PaperBox,
} from "../pipeline/binarize.ts";

export interface Thumb {
  buffer: ArrayBuffer;
  width: number;
  height: number;
  ext: "jpeg";
}

/** A source rectangle on the stored image, in whole pixels. */
export interface SrcRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Scale an analysis-copy box back to the width × height image (÷ `s`),
 *  rounded OUTWARD to whole pixels and clamped at both ends — a source rect
 *  past the image draws a transparent sliver that the JPEG stores black.
 *  Pure; Node-tested. */
export function sourceRect(box: PaperBox, s: number, width: number, height: number): SrcRect {
  const x = Math.max(0, Math.min(width - 1, Math.floor(box.x / s)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(box.y / s)));
  return {
    x,
    y,
    w: Math.max(1, Math.min(width, Math.ceil((box.x + box.w) / s)) - x),
    h: Math.max(1, Math.min(height, Math.ceil((box.y + box.h) / s)) - y),
  };
}

/** The part of a stored receipt image worth exporting. A receipt stored as a
 *  whole blank page (Letter/A4/Legal aspect within 0.003: a digital PDF page
 *  read before intake learned the ink crop — the Chevron-app e-receipts)
 *  trims to its print, approximating what a fresh read now stores (this
 *  analyzes the 1600-px stored copy rather than the intake render). The
 *  paper must be page-white (≥ 245): a photo almost never auto-exposes that
 *  bright, so a slab-cropped photo that happens to land on a page aspect is
 *  used whole — the export never newly crops what intake deliberately
 *  didn't. The highlight outlines are baked into the pixels, so they travel
 *  with the crop. */
function contentRect(bmp: ImageBitmap): SrcRect {
  const whole = { x: 0, y: 0, w: bmp.width, h: bmp.height };
  if (!isFullPageAspect(bmp.width, bmp.height)) return whole;
  const s = Math.min(1, ANALYSIS_MAX_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return whole;
  ctx.drawImage(bmp, 0, 0, w, h);
  const gray = toGrayscale(ctx.getImageData(0, 0, w, h).data, w, h);
  const box = inkContentBox(gray, w, h, { minPaper: 245 });
  return box ? sourceRect(box, s, bmp.width, bmp.height) : whole;
}

/** The print packet's strip rect: the field band (normalized y0..y1 of the
 *  stored image) narrowed to the content rect. Columns always come from the
 *  content; rows are clipped where the two overlap (the fields are content,
 *  so they do). A band that misses the content keeps its own rows rather
 *  than drawing nothing. Rows are clamped to the image — the old strip math
 *  could round its bottom one row past the image (a black line under the
 *  strip). Pure; Node-tested. */
export function bandRect(content: SrcRect, y0: number, y1: number, height: number): SrcRect {
  const by0 = Math.max(0, Math.min(height - 1, Math.round(height * y0)));
  const by1 = Math.max(by0 + 1, Math.min(height, Math.round(height * y1)));
  const top = Math.max(by0, content.y);
  const bottom = Math.min(by1, content.y + content.h);
  return bottom - top >= 1
    ? { x: content.x, y: top, w: content.w, h: bottom - top }
    : { x: content.x, y: by0, w: content.w, h: by1 - by0 };
}

async function encodeJpeg(canvas: HTMLCanvasElement, quality: number, what: string): Promise<ArrayBuffer> {
  const out = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error(`${what} encode failed`))),
      "image/jpeg",
      quality,
    ),
  );
  return out.arrayBuffer();
}

/** Draw `src` of the bitmap onto a fresh white canvas of w × h. */
function drawRegion(bmp: ImageBitmap, src: SrcRect, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, src.x, src.y, src.w, src.h, 0, 0, w, h);
  return canvas;
}

/** `trim` (default ON — every caller is a receipt-image export) applies
 *  `contentRect`; the returned width/height are the trimmed thumbnail's,
 *  which is what the workbook sizes its image block from. */
export async function thumbnail(
  blob: Blob,
  maxEdge = 520,
  quality = 0.72,
  fit: "edge" | "width" = "edge",
  trim = true,
): Promise<Thumb> {
  const bmp = await createImageBitmap(blob);
  let canvas: HTMLCanvasElement;
  try {
    const src = trim ? contentRect(bmp) : { x: 0, y: 0, w: bmp.width, h: bmp.height };
    // "edge" caps the long edge (downloads, previews). "width" caps the width
    // only: the workbook embeds display every receipt at a fixed column width,
    // and a portrait receipt capped by its (long) height encodes far fewer
    // horizontal pixels than the column shows — blurry at any zoom.
    const limit = fit === "width" ? src.w : Math.max(src.w, src.h);
    const scale = Math.min(1, maxEdge / limit);
    const w = Math.max(1, Math.round(src.w * scale));
    const h = Math.max(1, Math.round(src.h * scale));
    canvas = drawRegion(bmp, src, w, h);
  } finally {
    bmp.close();
  }
  const buffer = await encodeJpeg(canvas, quality, "thumbnail");
  return { buffer, width: canvas.width, height: canvas.height, ext: "jpeg" };
}

/** Like `thumbnail`, but cropped to a vertical band of the image first —
 *  the print packet's "field strip" (vendor→total plus padding), so a long
 *  receipt prints as just the part an office actually checks. `y0`/`y1` are
 *  normalized [0..1] against the source height. With `trim` (default ON)
 *  the band's columns narrow to `contentRect` too, so a digital page stored
 *  whole prints its column, not a strip of blank sheet. */
export async function stripThumbnail(
  blob: Blob,
  y0: number,
  y1: number,
  maxEdge = 520,
  quality = 0.72,
  trim = true,
): Promise<Thumb> {
  const bmp = await createImageBitmap(blob);
  let canvas: HTMLCanvasElement;
  try {
    const content = trim ? contentRect(bmp) : { x: 0, y: 0, w: bmp.width, h: bmp.height };
    const src = bandRect(content, y0, y1, bmp.height);
    const scale = Math.min(1, maxEdge / Math.max(src.w, src.h));
    const w = Math.max(1, Math.round(src.w * scale));
    const h = Math.max(1, Math.round(src.h * scale));
    canvas = drawRegion(bmp, src, w, h);
  } finally {
    bmp.close();
  }
  const buffer = await encodeJpeg(canvas, quality, "strip");
  return { buffer, width: canvas.width, height: canvas.height, ext: "jpeg" };
}
