import test from "node:test";
import assert from "node:assert/strict";
import {
  matchVendor,
  normalizeGlyphs,
  fuzzyMatchVendor,
  similarityRatio,
  FUZZY_RATIO,
  FUZZY_RENAME_RATIO,
  ALL_VENDORS,
} from "../src/config/vendors.ts";

// The glyph / slogan / fuzzy passes ported from the original app's
// vendor_db.py (its 7-Eleven "7-ELEUEN" and Home Depot logo-slogan lessons).

test("normalizeGlyphs folds letter OCR confusions, never digits", () => {
  // The canonical case: V misread as U still normalizes to the same key.
  assert.equal(normalizeGlyphs("7-ELEUEN"), normalizeGlyphs("7-ELEVEN"));
  // rn→m, vv→w, cl→d, u→v
  assert.equal(normalizeGlyphs("BARN"), normalizeGlyphs("BAM"));
  assert.equal(normalizeGlyphs("VV"), "w");
  assert.equal(normalizeGlyphs("CLEAN"), "dean");
  // digits stay intact (protects numeric brands like "76")
  assert.equal(normalizeGlyphs("76"), "76");
  assert.equal(normalizeGlyphs("STORE #76"), "store 76");
});

test("glyph pass resolves 7-ELEUEN → 7-Eleven (the original bug)", () => {
  const m = matchVendor("7-ELEUEN\n123 MAIN ST\nTOTAL $12.00");
  assert.ok(m, "expected a glyph-pass match");
  assert.equal(m.name, "7-Eleven");
  assert.equal(m.via, "glyph");
});

test("exact pass still wins first and is labeled exact", () => {
  const m = matchVendor("SHELL OIL 57444\nTOTAL $45.00");
  assert.ok(m);
  assert.equal(m.name, "Shell");
  assert.equal(m.via, "exact");
});

test("slogan names a logo-only receipt (Home Depot tagline)", () => {
  // No brand text at all — only the printed slogan survives OCR.
  const m = matchVendor("How doers get more done.\n1234 CONTRACTOR BLVD\nTOTAL $88.12");
  assert.ok(m, "expected the slogan alias to match");
  assert.equal(m.name, "The Home Depot");
});

test("glyph pass does not create numeric false positives", () => {
  assert.equal(matchVendor("ITEM TOTAL $45.76"), null);
  assert.equal(matchVendor("INVOICE 76234"), null);
});

test("similarityRatio behaves like a ratio", () => {
  assert.equal(similarityRatio("abc", "abc"), 1);
  assert.equal(similarityRatio("abc", "xyz"), 0);
  assert.ok(similarityRatio("7eleven", "7eleuen") > 0.8);
});

test("fuzzy backstop: near-miss vendor names resolve, whole receipts never do", () => {
  const hit = fuzzyMatchVendor("CHEVR0N");
  assert.ok(hit, "expected a fuzzy hit for CHEVR0N (0→o fold + similarity)");
  assert.equal(hit.name, "Chevron");
  assert.ok(hit.ratio >= FUZZY_RATIO);

  // A long multi-line candidate is refused outright (guard, not similarity).
  assert.equal(
    fuzzyMatchVendor("CHEVRON STATION 123 MAIN ST SPRINGFIELD IL 62704 USA"),
    null,
  );
  // Unrelated names miss.
  assert.equal(fuzzyMatchVendor("MOM'S DINER"), null);
});

test("rename threshold is stricter than hint threshold", () => {
  assert.ok(FUZZY_RENAME_RATIO > FUZZY_RATIO);
});

test("merged DB is present (curated + exported original brands)", () => {
  assert.ok(ALL_VENDORS.length >= 100, `expected the merged DB, got ${ALL_VENDORS.length}`);
  const sheetz = ALL_VENDORS.find((v) => v.name === "Sheetz");
  assert.ok(sheetz, "expected Sheetz from the original fuel DB");
  assert.equal(sheetz.category, "Fuel");
});
