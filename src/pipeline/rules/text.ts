import type { BBox, OcrLine } from "../../types.ts";

// Line-geometry and label-folding helpers shared by every rules module.

/** Smallest box covering every box given (undefined when none). */
export function unionBBox(boxes: BBox[]): BBox | undefined {
  if (boxes.length === 0) return undefined;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Fold digit-glyph OCR confusions for LABEL matching only ("T0TAL" → "total",
 *  "5UBTOTAL" → "subtotal"). Values are always parsed from the raw text. */
export function labelFold(s: string): string {
  return s.toLowerCase().replace(/0/g, "o").replace(/1/g, "l").replace(/5/g, "s");
}

/** Proportional slice of a line's bbox for a substring match — keeps fallback
 *  markers tight to the value instead of spanning the full line. */
export function sliceBBox(line: OcrLine, start: number, end: number): BBox | undefined {
  const b = line.bbox;
  if (!b || b.w <= 0) return b;
  const len = Math.max(1, line.text.length);
  const x = b.x + (b.w * Math.max(0, start)) / len;
  const w = Math.min((b.w * Math.max(1, end - start)) / len, b.x + b.w - x);
  return { x, y: b.y, w, h: b.h };
}
