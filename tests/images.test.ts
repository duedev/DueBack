import { test } from "node:test";
import assert from "node:assert/strict";
import { bandRect, sourceRect } from "../src/export/images.ts";

// The canvas half of export/images.ts needs a browser (the e2e drives it);
// these pin the pure rectangle math the packet strips and the legacy-page
// trim are drawn from.

test("bandRect narrows the packet's field band to the content columns", () => {
  // A legacy Chevron page (1237×1600) whose print sits in a 395-px column:
  // the strip prints the column, not a band of blank sheet.
  assert.deepEqual(bandRect({ x: 16, y: 0, w: 395, h: 1203 }, 0, 0.425, 1600), {
    x: 16,
    y: 0,
    w: 395,
    h: 680,
  });
});

test("bandRect clips the band's rows to the content", () => {
  assert.deepEqual(bandRect({ x: 0, y: 100, w: 500, h: 400 }, 0.02, 0.9, 1000), {
    x: 0,
    y: 100,
    w: 500,
    h: 400,
  });
});

test("bandRect over the whole image is the old strip math", () => {
  assert.deepEqual(bandRect({ x: 0, y: 0, w: 800, h: 1000 }, 0.1, 0.4, 1000), {
    x: 0,
    y: 100,
    w: 800,
    h: 300,
  });
});

test("bandRect never yields an empty rect when the band misses the content", () => {
  assert.deepEqual(bandRect({ x: 10, y: 0, w: 100, h: 200 }, 0.5, 0.7, 1000), {
    x: 10,
    y: 500,
    w: 100,
    h: 200,
  });
});

test("bandRect never runs past the image bottom (odd heights round up)", () => {
  // The old strip math drew round(999·0.5) = 500 rows from row 500 of a
  // 999-row image: one past the end, a black line under the strip.
  const r = bandRect({ x: 0, y: 0, w: 800, h: 999 }, 0.5, 1, 999);
  assert.ok(r.y + r.h <= 999, JSON.stringify(r));
  assert.equal(r.y, 500);
});

test("sourceRect scales an analysis box back out to whole, in-bounds pixels", () => {
  // 1237×1600 analysed at 480/1600 = 0.3 → a 371×480 copy.
  const s = 0.3;
  assert.deepEqual(sourceRect({ x: 9, y: 0, w: 109, h: 316 }, s, 1237, 1600), {
    x: 30,
    y: 0,
    w: 364, // ceil(118 / 0.3) = 394 → 394 − 30
    h: 1054, // ceil(316 / 0.3)
  });
  // A box reaching the analysis copy's rounded edge stays inside the image.
  const flush = sourceRect({ x: 300, y: 400, w: 71, h: 80 }, s, 1237, 1600);
  assert.ok(flush.x + flush.w <= 1237 && flush.y + flush.h <= 1600, JSON.stringify(flush));
});
