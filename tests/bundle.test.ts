import { test } from "node:test";
import assert from "node:assert/strict";
import { originalEntryName, BUNDLE_ORIGINALS_BUDGET } from "../src/train/bundle.ts";

// The tuning bundle's original-image entries: the card's display name
// ("trip.zip › 2026/03/scan.pdf (page 2 of 8)") must become one flat,
// honestly-extended archive entry. The budget itself needs IndexedDB and is
// exercised in the browser.

test("archive paths flatten and page names get the JPEG extension they are", () => {
  assert.equal(
    originalEntryName({ fileName: "scan.pdf (page 2 of 8)", originalFileName: "trip.zip › 2026/03/scan.pdf (page 2 of 8)", mimeType: "image/jpeg" }),
    "trip.zip__2026_03_scan.pdf (page 2 of 8).jpg",
  );
  assert.equal(
    originalEntryName({ fileName: "IMG_1.HEIC", originalFileName: "IMG_1.HEIC", mimeType: "image/heic" }),
    "IMG_1.HEIC",
  );
  assert.equal(originalEntryName({ fileName: "photo", mimeType: "image/png" }), "photo.png");
  assert.equal(originalEntryName({ fileName: "photo", mimeType: "" }, "image/webp"), "photo.webp");
  assert.ok(BUNDLE_ORIGINALS_BUDGET >= 100 * 1024 * 1024);
});
