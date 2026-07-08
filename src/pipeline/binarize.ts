// Pure image math for the OCR pre-pass: grayscale, adaptive (Bradley)
// binarization, and projection-profile skew estimation. No DOM — everything
// operates on plain typed arrays so Node tests can cover it; the canvas glue
// lives in imagePrep.ts. These are the two preprocessing steps quality-focused
// Tesseract front-ends apply that we previously skipped: local thresholding
// rescues unevenly lit thermal paper, and deskew rescues slightly tilted
// phone photos (Tesseract's line finder degrades fast past ~1–2°).

/** Luminance (0..255) from RGBA pixel data. */
export function toGrayscale(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): Float32Array {
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] =
      0.299 * (data[i] ?? 0) +
      0.587 * (data[i + 1] ?? 0) +
      0.114 * (data[i + 2] ?? 0);
  }
  return gray;
}

export interface BinarizeOptions {
  /** Sliding-window size as a fraction of the longer edge. */
  windowFrac?: number;
  /** Ink threshold: a pixel is ink when darker than (1 - t) × local mean. */
  t?: number;
}

/**
 * Bradley adaptive thresholding via an integral image — O(n), window mean per
 * pixel. Returns a mask (1 = ink, 0 = background). Unlike a global (Otsu)
 * threshold, it handles the shadowed/gradient lighting of receipt photos.
 */
export function bradleyBinarize(
  gray: Float32Array,
  w: number,
  h: number,
  opts: BinarizeOptions = {},
): Uint8Array {
  const windowFrac = opts.windowFrac ?? 0.125;
  const t = opts.t ?? 0.15;
  const mask = new Uint8Array(w * h);
  if (w < 2 || h < 2) return mask;

  // Integral image (row-major, (w+1)×(h+1) with a zero border). Uint32 is
  // safe — 255 × the largest frame we ever binarize (≈9M px) stays under
  // 2^32 — and halves the allocation vs Float64 on the hot rescue path.
  const iw = w + 1;
  const integral = new Uint32Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += ((gray[y * w + x] ?? 0) + 0.5) | 0;
      integral[(y + 1) * iw + (x + 1)] = (integral[y * iw + (x + 1)] ?? 0) + rowSum;
    }
  }

  const half = Math.max(2, Math.round((Math.max(w, h) * windowFrac) / 2));
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(w - 1, x + half);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        (integral[(y1 + 1) * iw + (x1 + 1)] ?? 0) -
        (integral[y0 * iw + (x1 + 1)] ?? 0) -
        (integral[(y1 + 1) * iw + x0] ?? 0) +
        (integral[y0 * iw + x0] ?? 0);
      if ((gray[y * w + x] ?? 0) * count < sum * (1 - t)) {
        mask[y * w + x] = 1;
      }
    }
  }
  return mask;
}

export interface SkewOptions {
  /** Search range in degrees (± around 0). */
  maxAngle?: number;
  /** Coarse/fine step sizes in degrees. */
  coarseStep?: number;
  fineStep?: number;
  /** Required score improvement over 0° before an angle is reported. */
  minGain?: number;
  /** Smallest angle worth correcting, in degrees. */
  minAngle?: number;
}

/**
 * Estimate the small skew angle of (mostly horizontal) text from an ink mask,
 * by shear-projecting ink pixels onto rows and maximizing the projection
 * profile's energy — text lines aligned with the x-axis concentrate ink into
 * few rows (high sum of squared row counts); tilted text smears it out.
 *
 * Returns the angle in degrees to ROTATE THE IMAGE BY to straighten it
 * (i.e. the negative of the detected text tilt), or 0 when no confident,
 * meaningful skew is found.
 */
export function estimateSkewAngle(
  mask: Uint8Array,
  w: number,
  h: number,
  opts: SkewOptions = {},
): number {
  const maxAngle = opts.maxAngle ?? 8;
  const coarseStep = opts.coarseStep ?? 0.5;
  const fineStep = opts.fineStep ?? 0.1;
  const minGain = opts.minGain ?? 1.05;
  const minAngle = opts.minAngle ?? 0.3;

  // Collect ink coordinates once (x centered so shearing doesn't drift rows).
  const xs: number[] = [];
  const ys: number[] = [];
  const cx = w / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        xs.push(x - cx);
        ys.push(y);
      }
    }
  }
  // Too little ink to say anything (noise floor).
  if (xs.length < Math.max(64, w)) return 0;

  const bins = new Float64Array(h + 2);
  const score = (deg: number): number => {
    bins.fill(0);
    const tan = Math.tan((deg * Math.PI) / 180);
    for (let i = 0; i < xs.length; i++) {
      const row = Math.round((ys[i] ?? 0) + (xs[i] ?? 0) * tan);
      if (row >= 0 && row <= h + 1) bins[row] = (bins[row] ?? 0) + 1;
    }
    let s = 0;
    for (let i = 0; i <= h + 1; i++) s += (bins[i] ?? 0) * (bins[i] ?? 0);
    return s;
  };

  const base = score(0);
  let bestDeg = 0;
  let bestScore = base;
  for (let deg = -maxAngle; deg <= maxAngle + 1e-9; deg += coarseStep) {
    const s = score(deg);
    if (s > bestScore) {
      bestScore = s;
      bestDeg = deg;
    }
  }
  // Refine around the coarse winner, clamped so the reported correction can
  // never exceed the promised ±maxAngle search range.
  const lo = Math.max(-maxAngle, bestDeg - coarseStep);
  const hi = Math.min(maxAngle, bestDeg + coarseStep);
  for (let deg = lo; deg <= hi + 1e-9; deg += fineStep) {
    const s = score(deg);
    if (s > bestScore) {
      bestScore = s;
      bestDeg = deg;
    }
  }

  if (Math.abs(bestDeg) < minAngle) return 0;
  if (bestScore < base * minGain) return 0;
  // The text is tilted by bestDeg (shearing by +bestDeg straightened it);
  // rotate the image by the same signed amount to undo the tilt.
  return bestDeg;
}

/** Mean RGB of the outer `thickness`-pixel ring — the photo's background
 *  color. Used as the fill behind deskew rotation so the uncovered corner
 *  wedges blend into the real background instead of injecting bright white
 *  edges that defeat the auto-crop on dark-background photos. */
export function borderColor(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  thickness = 2,
): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const add = (x: number, y: number): void => {
    const i = (y * w + x) * 4;
    r += data[i] ?? 0;
    g += data[i + 1] ?? 0;
    b += data[i + 2] ?? 0;
    n++;
  };
  const t = Math.max(1, thickness);
  for (let ty = 0; ty < Math.min(t, h); ty++) {
    for (let x = 0; x < w; x++) {
      add(x, ty);
      if (h - 1 - ty > ty) add(x, h - 1 - ty);
    }
  }
  for (let tx = 0; tx < Math.min(t, w); tx++) {
    for (let y = t; y < h - t; y++) {
      add(tx, y);
      if (w - 1 - tx > tx) add(w - 1 - tx, y);
    }
  }
  if (n === 0) return [255, 255, 255];
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** Apply an ink mask back onto RGBA pixels: ink → black, background → white. */
export function maskToRgba(
  mask: Uint8Array,
  data: Uint8ClampedArray,
): void {
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const v = mask[p] ? 0 : 255;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
}

/** Insets (px) of near-black scan borders at each frame edge — the sawtooth
 *  strips scan apps (CamScanner et al.) leave behind. Those strips carry
 *  edge energy, so the content-box crop alone keeps them. A line belongs to
 *  the border while ≥ `frac` of its pixels are darker than `darkPx`; the
 *  walk-in stops at the first non-dark line or at `maxFrac` of the frame
 *  (sparse dark TEXT rows never reach the fraction). */
export function darkBorderInsets(
  gray: Float32Array,
  w: number,
  h: number,
  opts: { darkPx?: number; frac?: number; maxFrac?: number } = {},
): { left: number; top: number; right: number; bottom: number } {
  const darkPx = opts.darkPx ?? 80;
  const frac = opts.frac ?? 0.3;
  const maxFrac = opts.maxFrac ?? 0.08;
  const rowDark = (y: number): number => {
    let n = 0;
    for (let x = 0; x < w; x++) if ((gray[y * w + x] ?? 255) < darkPx) n++;
    return n / w;
  };
  const colDark = (x: number): number => {
    let n = 0;
    for (let y = 0; y < h; y++) if ((gray[y * w + x] ?? 255) < darkPx) n++;
    return n / h;
  };
  const maxV = Math.floor(h * maxFrac);
  const maxH = Math.floor(w * maxFrac);
  let top = 0;
  while (top < maxV && rowDark(top) >= frac) top++;
  let bottom = 0;
  while (bottom < maxV && rowDark(h - 1 - bottom) >= frac) bottom++;
  let left = 0;
  while (left < maxH && colDark(left) >= frac) left++;
  let right = 0;
  while (right < maxH && colDark(w - 1 - right) >= frac) right++;
  return { left, top, right, bottom };
}
