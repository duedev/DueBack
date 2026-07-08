import { IMAGE_PREP } from "../config/constants.ts";
import { isPdf } from "../util/files.ts";
import { correctPerspective, perspectiveEnabled } from "./perspective.ts";
import {
  toGrayscale,
  bradleyBinarize,
  estimateSkewAngle,
  maskToRgba,
  borderColor,
  darkBorderInsets,
} from "./binarize.ts";

// Image pre-pass (§5 step 1, §14). Runs entirely client-side on a <canvas>:
//   decode → auto-rotate (EXIF) → deskew (small tilt) → grayscale →
//   auto-crop background → downscale.
// Free, improves every downstream step, shrinks uploads, and lowers the cost
// of any optional paid call. Two renders come out of the same cleaned frame:
// a transient higher-res copy for OCR (small print survives) and the stored
// JPEG for display/export — identical content, so normalized OCR boxes land
// correctly on either.

export interface CleanedImage {
  blob: Blob;
  width: number;
  height: number;
  /** Transient higher-res render of the SAME frame, for OCR only (never
   *  persisted). Same aspect as `blob`, so normalized boxes are shared. */
  ocrBlob: Blob;
  ocrWidth: number;
  ocrHeight: number;
  /** Object URL for display; caller is responsible for revoking. */
  url: string;
}

/** Decode any supported input (image or first PDF page) into a bitmap. */
async function decode(file: File | Blob): Promise<ImageBitmap> {
  if (file instanceof File && isPdf(file)) {
    return decodePdfFirstPage(file);
  }
  try {
    // imageOrientation:'from-image' applies EXIF rotation automatically.
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return await createImageBitmap(file);
  }
}

async function decodePdfFirstPage(file: File): Promise<ImageBitmap> {
  // Lazy-load pdf.js so the (large) renderer is only pulled in for PDFs.
  const pdfjs = await import("pdfjs-dist");
  // Vite resolves this worker URL at build time.
  pdfjs.GlobalWorkerOptions.workerSrc = (
    await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
  ).default;
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d")!;
  await page.render({ canvasContext: ctx, viewport }).promise;
  const bmp = await createImageBitmap(canvas);
  doc.destroy();
  return bmp;
}

/** Compute a content bounding box by trimming low-energy (blank) margins. */
function detectContentBox(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } {
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // luminance
    gray[p] =
      0.299 * (data[i] ?? 0) +
      0.587 * (data[i + 1] ?? 0) +
      0.114 * (data[i + 2] ?? 0);
  }
  const rowEnergy = new Float32Array(h);
  const colEnergy = new Float32Array(w);
  let maxEnergy = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const gx = Math.abs((gray[idx + 1] ?? 0) - (gray[idx - 1] ?? 0));
      const gy = Math.abs((gray[idx + w] ?? 0) - (gray[idx - w] ?? 0));
      const e = gx + gy;
      rowEnergy[y] = (rowEnergy[y] ?? 0) + e;
      colEnergy[x] = (colEnergy[x] ?? 0) + e;
    }
  }
  for (let y = 0; y < h; y++) maxEnergy = Math.max(maxEnergy, rowEnergy[y] ?? 0);
  let maxCol = 0;
  for (let x = 0; x < w; x++) maxCol = Math.max(maxCol, colEnergy[x] ?? 0);

  const rowThresh = maxEnergy * 0.06;
  const colThresh = maxCol * 0.06;

  let top = 0,
    bottom = h - 1,
    left = 0,
    right = w - 1;
  while (top < h && (rowEnergy[top] ?? 0) < rowThresh) top++;
  while (bottom > top && (rowEnergy[bottom] ?? 0) < rowThresh) bottom--;
  while (left < w && (colEnergy[left] ?? 0) < colThresh) left++;
  while (right > left && (colEnergy[right] ?? 0) < colThresh) right--;

  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/** Draw a small (≤480px) analysis copy and return its pixels. */
function analysisFrame(
  src: ImageBitmap | HTMLCanvasElement,
): { data: Uint8ClampedArray; w: number; h: number; scale: number } {
  const srcW = src.width;
  const srcH = src.height;
  const aMax = 480;
  const scale = Math.min(1, aMax / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const ac = document.createElement("canvas");
  ac.width = w;
  ac.height = h;
  const actx = ac.getContext("2d", { willReadFrequently: true })!;
  actx.drawImage(src, 0, 0, w, h);
  return { data: actx.getImageData(0, 0, w, h).data, w, h, scale };
}

/** Rotate the full frame by `deg` (positive = clockwise) about its center —
 *  used for small deskew corrections only, so the clipped corner slivers are
 *  background, not content. The uncovered wedges are filled with the photo's
 *  own border color: a hard-coded white fill against a dark table injects
 *  bright corner edges that defeat the auto-crop's content detection. */
function rotateFrame(
  src: ImageBitmap | HTMLCanvasElement,
  deg: number,
  fill: [number, number, number] = [255, 255, 255],
): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = `rgb(${fill[0]},${fill[1]},${fill[2]})`;
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(src, -w / 2, -h / 2);
  return canvas;
}

/** Render a source region to a canvas capped at `maxEdge`, with the standard
 *  grayscale/contrast treatment. */
function renderRegion(
  src: ImageBitmap | HTMLCanvasElement,
  crop: { x: number; y: number; w: number; h: number },
  maxEdge: number,
): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(crop.w, crop.h));
  const outW = Math.max(1, Math.round(crop.w * scale));
  const outH = Math.max(1, Math.round(crop.h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d")!;
  if (IMAGE_PREP.grayscale && "filter" in ctx) {
    ctx.filter = "grayscale(1) contrast(1.08)";
  }
  ctx.drawImage(src, crop.x, crop.y, crop.w, crop.h, 0, 0, outW, outH);
  return canvas;
}

export async function cleanImage(file: File | Blob): Promise<CleanedImage> {
  const bmp = await decode(file);
  let src: ImageBitmap | HTMLCanvasElement = bmp;

  // Optional document straightening (angled phone photos). Best-effort and
  // opt-in (VITE_PERSPECTIVE=1 + a vendored OpenCV.js) — null keeps the
  // original decode.
  if (perspectiveEnabled()) {
    const warped = await correctPerspective(bmp).catch(() => null);
    if (warped) {
      bmp.close();
      src = warped;
    }
  }

  const bigEnough = src.width > 200 && src.height > 200;
  // One analysis copy serves both deskew and autocrop; it is only recomputed
  // when the frame was actually rotated.
  let a = bigEnough ? analysisFrame(src) : null;

  // --- deskew: estimate small tilt on the analysis copy, correct in full ---
  if (IMAGE_PREP.deskew && a) {
    const gray = toGrayscale(a.data, a.w, a.h);
    const mask = bradleyBinarize(gray, a.w, a.h);
    const angle = estimateSkewAngle(mask, a.w, a.h, {
      maxAngle: IMAGE_PREP.deskewMaxAngle,
    });
    if (angle !== 0) {
      const rotated = rotateFrame(src, angle, borderColor(a.data, a.w, a.h));
      if (src instanceof ImageBitmap) src.close();
      src = rotated;
      a = analysisFrame(src);
    }
  }

  const srcW = src.width;
  const srcH = src.height;

  // --- trim near-black scan borders (CamScanner-style sawtooth strips) ---
  // Pre-scanned uploads arrive already cropped/deskewed, but with black edge
  // strips the content-box crop alone keeps (they carry edge energy).
  let inset = { left: 0, top: 0, right: 0, bottom: 0 };
  if (a) {
    inset = darkBorderInsets(toGrayscale(a.data, a.w, a.h), a.w, a.h);
  }

  // --- auto-crop analysis on the small copy of the (now upright) frame ---
  let crop = { x: 0, y: 0, w: srcW, h: srcH };
  if (a && (inset.left || inset.top || inset.right || inset.bottom)) {
    crop = {
      x: inset.left / a.scale,
      y: inset.top / a.scale,
      w: Math.max(1, (a.w - inset.left - inset.right) / a.scale),
      h: Math.max(1, (a.h - inset.top - inset.bottom) / a.scale),
    };
  }
  if (IMAGE_PREP.autoCrop && a) {
    const box = detectContentBox(a.data, a.w, a.h);
    // Keep the content box inside the border-trimmed region.
    const x1 = Math.max(box.x, inset.left);
    const y1 = Math.max(box.y, inset.top);
    const x2 = Math.min(box.x + box.w, a.w - inset.right);
    const y2 = Math.min(box.y + box.h, a.h - inset.bottom);
    const nbox = { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
    const area = (nbox.w * nbox.h) / (a.w * a.h);
    // Only accept a crop that keeps a sensible region (guards over-cropping).
    if (area > 0.45 && nbox.w > a.w * 0.4 && nbox.h > a.h * 0.4) {
      const pad = 0.02;
      const px = nbox.w * pad;
      const py = nbox.h * pad;
      crop = {
        x: Math.max(0, (nbox.x - px) / a.scale),
        y: Math.max(0, (nbox.y - py) / a.scale),
        w: Math.min(srcW, (nbox.w + 2 * px) / a.scale),
        h: Math.min(srcH, (nbox.h + 2 * py) / a.scale),
      };
    }
  }

  // --- render the same frame twice: stored copy + transient OCR copy ---
  const stored = renderRegion(src, crop, IMAGE_PREP.maxEdge);
  const ocr = renderRegion(src, crop, IMAGE_PREP.ocrMaxEdge);
  if (src instanceof ImageBitmap) src.close();

  const blob = await canvasToBlob(stored, "image/jpeg", IMAGE_PREP.quality);
  const ocrBlob = await canvasToBlob(ocr, "image/jpeg", IMAGE_PREP.ocrQuality);
  return {
    blob,
    width: stored.width,
    height: stored.height,
    ocrBlob,
    ocrWidth: ocr.width,
    ocrHeight: ocr.height,
    url: URL.createObjectURL(blob),
  };
}

export interface BinarizedImage {
  blob: Blob;
  width: number;
  height: number;
}

/** Adaptively binarize an image blob (Bradley threshold → pure black/white).
 *  Used by the weak-read OCR rescue; the result is transient. The frame is
 *  capped at `maxEdge` (default: the stored-image size) — the rescue targets
 *  uneven LIGHTING, not resolution, and the pixel loops run synchronously on
 *  the main thread, so binarizing the full 2600px OCR render would stall the
 *  UI for hundreds of ms. Callers must use the RETURNED dimensions when
 *  normalizing OCR boxes. */
export async function binarizeBlob(
  blob: Blob,
  maxEdge: number = IMAGE_PREP.maxEdge,
): Promise<BinarizedImage> {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const img = ctx.getImageData(0, 0, w, h);
  const gray = toGrayscale(img.data, w, h);
  const mask = bradleyBinarize(gray, w, h);
  maskToRgba(mask, img.data);
  ctx.putImageData(img, 0, 0);
  const out = await canvasToBlob(canvas, "image/png", 1);
  return { blob: out, width: w, height: h };
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas encode failed"))),
      type,
      quality,
    );
  });
}
