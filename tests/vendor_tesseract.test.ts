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
