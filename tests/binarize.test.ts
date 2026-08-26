import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toGrayscale,
  bradleyBinarize,
  estimateSkewAngle,
  maskToRgba,
  borderColor,
  darkBorderInsets,
  paperRegionBox,
} from "../src/pipeline/binarize.ts";

// Synthetic-image helpers ----------------------------------------------------

/** RGBA buffer of a solid gray value. */
function rgba(w: number, h: number, v: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }
  return d;
}

function setPx(d: Uint8ClampedArray, w: number, x: number, y: number, v: number): void {
  const i = (y * w + x) * 4;
  d[i] = v;
  d[i + 1] = v;
  d[i + 2] = v;
}

/** Ink mask with horizontal text-line bars sheared by `tiltDeg` (positive =
 *  lines slope downward to the right, i.e. the image looks rotated clockwise). */
function tiltedLinesMask(w: number, h: number, tiltDeg: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  const tan = Math.tan((tiltDeg * Math.PI) / 180);
  const cx = w / 2;
  for (let line = 0; line < 8; line++) {
    const y0 = 30 + line * 24;
    for (let x = 10; x < w - 10; x++) {
      for (let dy = 0; dy < 3; dy++) {
        const y = Math.round(y0 + (x - cx) * tan) + dy;
        if (y >= 0 && y < h) mask[y * w + x] = 1;
      }
    }
  }
  return mask;
}

// toGrayscale -----------------------------------------------------------------

test("toGrayscale computes luminance", () => {
  const d = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
  const g = toGrayscale(d, 2, 1);
  assert.ok(Math.abs((g[0] ?? 0) - 0.299 * 255) < 0.01);
  assert.ok(Math.abs((g[1] ?? 0) - 0.587 * 255) < 0.01);
});

// bradleyBinarize --------------------------------------------------------------

test("bradley binarization finds dark text on a lighting gradient", () => {
  // Background brightness slides 220 → 90 across the image (a shadowed photo);
  // a global threshold that keeps the bright side loses the dark side. Text
  // glyphs are only ~50 darker than their LOCAL background.
  const w = 200;
  const h = 80;
  const d = rgba(w, h, 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      setPx(d, w, x, y, Math.round(220 - (130 * x) / w));
    }
  }
  const textPx: Array<[number, number]> = [];
  for (const gx of [20, 60, 100, 140, 180]) {
    for (let y = 35; y < 45; y++) {
      for (let x = gx; x < gx + 8; x++) {
        const bg = 220 - (130 * x) / w;
        setPx(d, w, x, y, Math.round(bg - 55));
        textPx.push([x, y]);
      }
    }
  }
  const gray = toGrayscale(d, w, h);
  const mask = bradleyBinarize(gray, w, h);
  const hit = textPx.filter(([x, y]) => mask[y * w + x]).length / textPx.length;
  assert.ok(hit > 0.9, `text coverage ${(hit * 100).toFixed(0)}%`);
  // Background must stay mostly clean (the gradient itself is not ink).
  let bgInk = 0;
  let bgTotal = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (y >= 30 && y < 50) continue; // skip the text band entirely
      bgTotal++;
      if (mask[y * w + x]) bgInk++;
    }
  }
  assert.ok(bgInk / bgTotal < 0.05, `background ink ${((bgInk / bgTotal) * 100).toFixed(1)}%`);
});

test("bradley binarization of a blank image finds no ink", () => {
  const w = 64;
  const h = 64;
  const gray = toGrayscale(rgba(w, h, 240), w, h);
  const mask = bradleyBinarize(gray, w, h);
  assert.equal(mask.reduce((s, v) => s + v, 0), 0);
});

// estimateSkewAngle -------------------------------------------------------------

test("skew estimate is 0 for straight text lines", () => {
  const w = 320;
  const h = 240;
  assert.equal(estimateSkewAngle(tiltedLinesMask(w, h, 0), w, h), 0);
});

test("skew estimate returns the corrective rotation for tilted lines", () => {
  const w = 320;
  const h = 240;
  // Lines tilted +3° (clockwise-looking) → rotate by -3° to straighten.
  const cw = estimateSkewAngle(tiltedLinesMask(w, h, 3), w, h);
  assert.ok(Math.abs(cw + 3) < 0.6, `expected ≈ -3, got ${cw}`);
  // And the mirror case.
  const ccw = estimateSkewAngle(tiltedLinesMask(w, h, -4), w, h);
  assert.ok(Math.abs(ccw - 4) < 0.6, `expected ≈ +4, got ${ccw}`);
});

test("skew estimate stays quiet on noise (no text structure)", () => {
  const w = 200;
  const h = 200;
  const mask = new Uint8Array(w * h);
  // Deterministic pseudo-random speckle.
  let seed = 12345;
  for (let i = 0; i < mask.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    if (seed % 17 === 0) mask[i] = 1;
  }
  const angle = estimateSkewAngle(mask, w, h);
  assert.equal(angle, 0, `noise produced angle ${angle}`);
});

// maskToRgba --------------------------------------------------------------------

test("maskToRgba writes pure black/white", () => {
  const mask = new Uint8Array([1, 0]);
  const d = rgba(2, 1, 128);
  maskToRgba(mask, d);
  assert.deepEqual([...d], [0, 0, 0, 255, 255, 255, 255, 255]);
});

test("skew estimate never exceeds the configured maxAngle", () => {
  const w = 320;
  const h = 240;
  // Text tilted just past the search boundary — the refine pass must clamp.
  const angle = estimateSkewAngle(tiltedLinesMask(w, h, 8.4), w, h, { maxAngle: 8 });
  assert.ok(Math.abs(angle) <= 8 + 1e-9, `angle ${angle} exceeds ±8`);
});

test("borderColor samples the photo's background ring", () => {
  const w = 40;
  const h = 30;
  // Dark background with a bright center block (the receipt).
  const d = rgba(w, h, 40);
  for (let y = 8; y < 22; y++) for (let x = 8; x < 32; x++) setPx(d, w, x, y, 245);
  const [r, g, b] = borderColor(d, w, h);
  assert.ok(r < 60 && g < 60 && b < 60, `expected dark border, got rgb(${r},${g},${b})`);
});

test("borderColor handles degenerate sizes", () => {
  assert.deepEqual(borderColor(new Uint8ClampedArray(0), 0, 0), [255, 255, 255]);
  const one = borderColor(new Uint8ClampedArray([10, 20, 30, 255]), 1, 1);
  assert.deepEqual(one, [10, 20, 30]);
});

test("darkBorderInsets trims black scan strips but not sparse text rows", () => {
  const w = 100;
  const h = 100;
  const gray = new Float32Array(w * h).fill(240); // white page
  // 3-row black strip at the top covering 40% of the width (sawtooth scan edge).
  for (let y = 0; y < 3; y++) for (let x = 60; x < 100; x++) gray[y * w + x] = 10;
  // A text-like row lower down: only 10% dark pixels.
  for (let x = 0; x < 10; x++) gray[50 * w + x] = 10;
  const inset = darkBorderInsets(gray, w, h);
  assert.equal(inset.top, 3, `top ${inset.top}`);
  assert.equal(inset.bottom, 0);
  assert.equal(inset.left, 0);
  assert.equal(inset.right, 0);

  const clean = new Float32Array(w * h).fill(240);
  const none = darkBorderInsets(clean, w, h);
  assert.deepEqual(none, { left: 0, top: 0, right: 0, bottom: 0 });
});

// paperRegionBox -------------------------------------------------------------

/** Paint a solid rectangle in a specific RGB color. */
function fillRect(
  d: Uint8ClampedArray,
  w: number,
  x0: number,
  y0: number,
  rw: number,
  rh: number,
  [r, g, b]: [number, number, number],
): void {
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) {
      const i = (y * w + x) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }
}

test("paperRegionBox finds a bright slab on a dark background", () => {
  const w = 120;
  const h = 160;
  const d = rgba(w, h, 40); // dark table
  fillRect(d, w, 30, 20, 50, 120, [235, 233, 228]); // the receipt
  const box = paperRegionBox(d, w, h);
  assert.ok(box, "slab found");
  assert.ok(Math.abs(box!.x - 30) <= 2 && Math.abs(box!.y - 20) <= 2);
  assert.ok(Math.abs(box!.w - 50) <= 3 && Math.abs(box!.h - 120) <= 3);
});

test("paperRegionBox ignores a bright but saturated object (food, packaging)", () => {
  const w = 160;
  const h = 120;
  const d = rgba(w, h, 45);
  fillRect(d, w, 10, 10, 50, 100, [230, 228, 224]); // receipt
  fillRect(d, w, 80, 10, 70, 100, [250, 210, 60]); // shredded-cheese yellow, larger
  const box = paperRegionBox(d, w, h);
  assert.ok(box, "slab found");
  assert.ok(box!.x + box!.w <= 66, `saturated blob excluded (right edge ${box!.x + box!.w})`);
});

test("paperRegionBox picks the big slab over scattered bright speckles", () => {
  const w = 160;
  const h = 120;
  const d = rgba(w, h, 50);
  fillRect(d, w, 10, 10, 60, 100, [230, 230, 230]); // receipt
  // grayscale-photo speckles (bright, desaturated, but fragmented)
  for (let i = 0; i < 40; i++) {
    const x = 100 + ((i * 7) % 50);
    const y = 10 + ((i * 13) % 100);
    fillRect(d, w, x, y, 2, 2, [220, 220, 220]);
  }
  const box = paperRegionBox(d, w, h);
  assert.ok(box, "slab found");
  assert.ok(box!.x + box!.w <= 76, "speckle field not merged into the slab");
});

test("paperRegionBox merges a fold-split slab", () => {
  const w = 120;
  const h = 160;
  const d = rgba(w, h, 40);
  fillRect(d, w, 30, 20, 50, 60, [235, 235, 235]); // top half
  fillRect(d, w, 30, 84, 50, 60, [235, 235, 235]); // bottom half (4px shadow gap)
  const box = paperRegionBox(d, w, h);
  assert.ok(box, "slab found");
  assert.ok(box!.h >= 120, `both halves kept (h ${box!.h})`);
});

test("paperRegionBox returns null for all-paper and all-dark frames", () => {
  // A scan that is already all paper: nothing to win.
  assert.equal(paperRegionBox(rgba(100, 100, 235), 100, 100), null);
  // A dark frame with no slab at all.
  assert.equal(paperRegionBox(rgba(100, 100, 30), 100, 100), null);
  // A tiny bright dot is not a slab.
  const d = rgba(100, 100, 30);
  fillRect(d, 100, 48, 48, 5, 5, [240, 240, 240]);
  assert.equal(paperRegionBox(d, 100, 100), null);
});
