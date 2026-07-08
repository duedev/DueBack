import type { BBox } from "../types.ts";

// Bake highlighter marks onto a copy of the cleaned receipt — the digital
// version of running a highlighter over the vendor, date and total before
// filing the paper. The annotated copy is what exports (workbook, image zip)
// and board thumbnails show; the review modal keeps the clean image with its
// live overlays.

export interface HighlightMark {
  bbox: BBox;
  /** CSS color of the highlighter stroke. */
  color: string;
}

export const HIGHLIGHT_COLORS = {
  vendor: "#1d4ed8",
  date: "#147246",
  amount: "#d9480f",
} as const;

/** Draw translucent highlighter marks over the given normalized boxes. */
export async function annotateReceipt(
  blob: Blob,
  marks: HighlightMark[],
): Promise<Blob | null> {
  const usable = marks.filter((m) => m.bbox.w > 0 && m.bbox.h > 0);
  if (usable.length === 0 || typeof document === "undefined") return null;
  const bmp = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);

    for (const m of usable) {
      const padX = m.bbox.w * 0.08 * bmp.width + 2;
      const padY = m.bbox.h * 0.3 * bmp.height + 2;
      const x = m.bbox.x * bmp.width - padX;
      const y = m.bbox.y * bmp.height - padY;
      const w = m.bbox.w * bmp.width + padX * 2;
      const h = m.bbox.h * bmp.height + padY * 2;
      const r = Math.min(6, h / 3);
      // Translucent fill (multiply keeps the print legible underneath) plus a
      // thin solid edge so the mark reads even on gray thermal paper.
      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = m.color;
      ctx.lineWidth = Math.max(2, bmp.width / 640);
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.stroke();
      ctx.restore();
    }

    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85),
    );
  } catch {
    return null;
  } finally {
    bmp.close();
  }
}
