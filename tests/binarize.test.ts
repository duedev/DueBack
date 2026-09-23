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
  inkContentBox,
  padBox,
  toSourceBox,
  isFullPageAspect,
  ANALYSIS_MAX_EDGE,
  type PaperBox,
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

// inkContentBox — the crop for (nearly) all-paper frames ---------------------

// A US Letter page at the analysis size (ANALYSIS_MAX_EDGE on the long edge).
const PH = ANALYSIS_MAX_EDGE;
const PW = Math.round((PH * 8.5) / 11); // 371

function page(v = 255, w = PW, h = PH): Float32Array {
  return new Float32Array(w * h).fill(v);
}

function paint(g: Float32Array, w: number, x0: number, y0: number, rw: number, rh: number, v: number): void {
  for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) g[y * w + x] = v;
}

/** One printed line: 3-px-tall word blobs with 3-px gaps from x0 to x1. */
function wordLine(g: Float32Array, w: number, x0: number, x1: number, y: number, v = 90): void {
  for (let x = x0, k = 0; x < x1; k++) {
    const len = Math.min(x1 - x, 6 + ((k * 7) % 11));
    paint(g, w, x, y, len, 3, v);
    x += len + 3;
  }
}

/** Lines every 6 px from y0 to y1 (px), spanning x0..x1. */
function column(g: Float32Array, w: number, x0: number, x1: number, y0: number, y1: number, v = 90): void {
  for (let y = y0; y + 3 <= y1; y += 6) wordLine(g, w, x0, x1, y, v);
}

const nx = (px: number): number => Math.round(PW * px);
const ny = (py: number): number => Math.round(PH * py);

/** A Chevron-app e-receipt: a narrow text column top-left on a white page
 *  (the owner's pages print at x 0.065–0.46, y 0.03–0.81; this one is
 *  narrower still). */
function chevronPage(): Float32Array {
  const g = page();
  column(g, PW, nx(0.065), nx(0.28), ny(0.02), ny(0.63));
  return g;
}

const edges = (b: PaperBox) => ({
  x1: b.x / PW,
  y1: b.y / PH,
  x2: (b.x + b.w) / PW,
  y2: (b.y + b.h) / PH,
});

test("inkContentBox trims a digital Letter page to its narrow text column", () => {
  const box = inkContentBox(chevronPage(), PW, PH);
  assert.ok(box, "a crop was found");
  const e = edges(box!);
  assert.ok(e.x1 <= 0.065 && e.y1 <= 0.02 && e.x2 >= 0.28 && e.y2 >= 0.63, `covers the column ${JSON.stringify(e)}`);
  assert.ok(e.x2 >= 0.3, `keeps a margin (${e.x2})`);
  assert.ok(e.x2 <= 0.36 && e.y2 <= 0.7, `trims the blank page ${JSON.stringify(e)}`);
});

test("inkContentBox ignores dust specks and edge-hugging scanner shadows", () => {
  const clean = inkContentBox(chevronPage(), PW, PH);
  const g = chevronPage();
  paint(g, PW, nx(0.9), ny(0.95), 1, 1, 60); // single-pixel speck
  paint(g, PW, nx(0.7), ny(0.85), 1, 2, 60); // 1×2 speck
  paint(g, PW, PW - 3, 0, 3, PH, 120); // lid shadow down the right edge…
  paint(g, PW, 0, PH - 2, PW, 2, 110); // …meeting one along the bottom (an L)
  assert.deepEqual(inkContentBox(g, PW, PH), clean);
});

test("inkContentBox keeps faint gray logos and thin rules as content", () => {
  const g = chevronPage();
  paint(g, PW, nx(0.35), ny(0.05), nx(0.1), ny(0.05), 228); // pale logo right of the column
  paint(g, PW, nx(0.065), ny(0.7), nx(0.2), 1, 150); // 1-px rule under it
  const e = edges(inkContentBox(g, PW, PH)!);
  assert.ok(e.x2 >= 0.45, `logo kept (${e.x2})`);
  assert.ok(e.y2 >= 0.7, `rule kept (${e.y2})`);
});

test("inkContentBox keeps light-gray fine print on a white page (the lenient cut)", () => {
  // An area-averaging downscale lightens a thin #CCC footer ("Customer
  // Copy") to ~241 at the analysis size; on page-white paper that is ink.
  const g = chevronPage();
  wordLine(g, PW, nx(0.1), nx(0.25), ny(0.76), 241);
  const e = edges(inkContentBox(g, PW, PH)!);
  assert.ok(e.y2 >= 0.77, `footer inside the box (${e.y2})`);
});

test("inkContentBox keeps a top-edge text line of separate words", () => {
  const g = page();
  column(g, PW, nx(0.065), nx(0.28), 0, ny(0.5));
  const box = inkContentBox(g, PW, PH)!;
  assert.equal(box.y, 0);
  assert.ok(edges(box).x2 >= 0.28);
});

test("inkContentBox keeps the lettering of a full-bleed dark header bar", () => {
  const g = page();
  paint(g, PW, 0, 0, PW, 24, 30); // dark banner across the top…
  for (let x = 20; x < PW - 20; x += 14) paint(g, PW, x, 6, 8, 12, 250); // …with white lettering
  column(g, PW, nx(0.065), nx(0.28), 30, ny(0.6));
  const box = inkContentBox(g, PW, PH);
  // The walk may shave the banner's plain rows, never its lettering.
  assert.ok(box === null || (box.y <= 6 && box.y + box.h >= 18), JSON.stringify(box));
});

test("inkContentBox keeps a long receipt's full length while trimming its sides", () => {
  const g = page();
  column(g, PW, nx(0.32), nx(0.57), 10, PH - 12);
  const box = inkContentBox(g, PW, PH)!;
  assert.ok(box, "cropped sideways");
  const e = edges(box);
  assert.ok(e.x1 > 0.2 && e.x2 < 0.7, `sides trimmed ${JSON.stringify(e)}`);
  assert.ok(box.y <= 10 && box.y + box.h >= PH - 12, `no line lost ${JSON.stringify(box)}`);
});

test("inkContentBox says null when there is nothing worth trimming", () => {
  // Print filling the frame (a receipt scan, the e2e fuel receipt).
  const full = page();
  column(full, PW, nx(0.03), nx(0.97), ny(0.02), ny(0.97));
  assert.equal(inkContentBox(full, PW, PH), null);
  assert.equal(inkContentBox(page(), PW, PH), null, "blank page");
  assert.equal(inkContentBox(page(40), PW, PH), null, "dark frame (a photo)");
  // Heavy texture: 40% of the pixels well below a 235 paper.
  const tex = page(235);
  for (let p = 0; p < tex.length; p++) if (p % 5 < 2) tex[p] = 170;
  assert.equal(inkContentBox(tex, PW, PH), null, "texture");
});

test("inkContentBox needs page-white paper (minPaper)", () => {
  // A receipt photographed on a light table: paper ~220, not a page.
  const g = page(220);
  column(g, PW, nx(0.3), nx(0.5), ny(0.1), ny(0.6), 60);
  assert.equal(inkContentBox(g, PW, PH), null, "default 235 floor");
  assert.ok(inkContentBox(g, PW, PH, { minPaper: 160 }), "an explicit lower floor crops");
});

test("inkContentBox honours the caller's dark scan-border insets", () => {
  // The darkBorderInsets fixture: a sawtooth strip on the top 6 rows over
  // 40% of the width. Each row is only 40% dark, so the ink crop's own
  // full-edge walk keeps it — imagePrep's inset has to be passed in.
  const g = page(240);
  paint(g, PW, Math.round(PW * 0.6), 0, PW - Math.round(PW * 0.6), 6, 10);
  column(g, PW, nx(0.1), nx(0.35), ny(0.05), ny(0.6));
  const inset = darkBorderInsets(g, PW, PH);
  assert.equal(inset.top, 6);
  const box = inkContentBox(g, PW, PH, { exclude: inset })!;
  assert.ok(box, "cropped to the column");
  assert.ok(box.y >= 6, `strip rows excluded (y ${box.y})`);
  assert.ok(box.x + box.w < 0.6 * PW, `strip columns excluded (right ${box.x + box.w})`);
  // Without the exclusion the strip comes back in (why imagePrep passes it).
  const bare = inkContentBox(g, PW, PH);
  assert.ok(bare === null || bare.y < 6, JSON.stringify(bare));
});

test("inkContentBox is idempotent on its own crop", () => {
  const g = chevronPage();
  const b = inkContentBox(g, PW, PH)!;
  const cropped = new Float32Array(b.w * b.h);
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) cropped[y * b.w + x] = g[(b.y + y) * PW + (b.x + x)]!;
  }
  assert.equal(inkContentBox(cropped, b.w, b.h), null);
});

test("padBox clamps BOTH ends of the frame", () => {
  const flush = padBox({ x: 50, y: 60, w: 50, h: 40 }, 0.03, 100, 100);
  assert.equal(flush.x, 48.5);
  assert.ok(Math.abs(flush.y - 58.8) < 1e-9);
  assert.ok(flush.x + flush.w <= 100 && flush.y + flush.h <= 100, JSON.stringify(flush));
  // Clamping the near side must not widen the far one.
  const corner = padBox({ x: 1, y: 1, w: 20, h: 20 }, 0.1, 100, 100);
  assert.equal(corner.x, 0);
  assert.equal(corner.x + corner.w, 23);
});

test("toSourceBox never runs a crop past the source frame", () => {
  // 999 px at scale 0.48 rounds UP to a 480-px analysis copy: its full
  // width maps back to 1000 px — one past the image, which drawImage used
  // to leave transparent and the JPEG stored as a black column.
  const s = 0.48;
  const full = toSourceBox({ x: 0, y: 0, w: 480, h: 480 }, s, 999, 999);
  assert.deepEqual(full, { x: 0, y: 0, w: 999, h: 999 });
  // A slab flush with the right/bottom edge, padded the way imagePrep pads.
  const slab = toSourceBox(padBox({ x: 300, y: 400, w: 180, h: 80 }, 0.03, 480, 480), s, 999, 999);
  assert.ok(slab.x + slab.w <= 999 && slab.y + slab.h <= 999, JSON.stringify(slab));
  // Degenerate boxes still yield a drawable 1-px rect inside the frame.
  const edge = toSourceBox({ x: 479.9, y: 0, w: 5, h: 5 }, s, 999, 999);
  assert.ok(edge.x <= 998 && edge.w >= 1 && edge.x + edge.w <= 999, JSON.stringify(edge));
});

test("isFullPageAspect recognizes whole Letter/A4/Legal pages only", () => {
  for (const [w, h] of [
    [1237, 1600], // Letter as stored (pdf.ts renders 2010×2600)
    [760, 983], // the workbook's copy
    [1131, 1600], // A4
    [972, 1600], // Legal
    [1600, 1237], // landscape
  ] as const) {
    assert.ok(isFullPageAspect(w, h), `${w}×${h}`);
  }
  for (const [w, h] of [
    [1200, 1600], // a 3:4 phone photo
    [1000, 1600], // 0.625: a short slab-cropped receipt near Legal
    [1180, 1600], // 0.7375: near A4
    [570, 1600], // a cropped receipt
    [0, 0],
  ] as const) {
    assert.ok(!isFullPageAspect(w, h), `${w}×${h}`);
  }
});
