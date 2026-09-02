import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain .mjs script, no declaration file
import { tessdataFailureIsFatal } from "../scripts/vendor-tesseract.mjs";

// A failed language-data download must fail the build unless the build
// explicitly opted into the CDN path — the app has no runtime fallback, so a
// green deploy without local tessdata ships 404ing OCR.
test("tessdata download failure is fatal unless VITE_TESSDATA_LOCAL=0", () => {
  assert.equal(tessdataFailureIsFatal({}), true, "default builds expect local data");
  assert.equal(tessdataFailureIsFatal({ VITE_TESSDATA_LOCAL: "1" }), true);
  assert.equal(tessdataFailureIsFatal({ VITE_TESSDATA_LOCAL: "" }), true);
  assert.equal(tessdataFailureIsFatal({ VITE_TESSDATA_LOCAL: "0" }), false, "CDN mode skips");
});

// ── Audit round (2026-09) ─────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
// @ts-expect-error plain .mjs script, no declaration file
import { tesseractVendorDir } from "../scripts/vendor-tesseract.mjs";

test("the vendored Tesseract path is versioned and the three sources agree", () => {
  assert.equal(tesseractVendorDir("5.1.1"), "vendor/tesseract/5.1.1");
  const ocr = readFileSync(new URL("../src/pipeline/ocr.ts", import.meta.url), "utf8");
  assert.match(ocr, /vendor\/tesseract\/\$\{TESSERACT_VERSION/);
  assert.match(ocr, /__TESSERACT_VERSION__/);
  const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(vite, /__TESSERACT_VERSION__: JSON\.stringify\(TESSERACT_VERSION\)/);
  assert.match(vite, /tesseract\.js\/package\.json/);
});
