import { test } from "node:test";
import assert from "node:assert/strict";
import {
  receiptFileName,
  sanitizeFilePart,
  dateMMDDYY,
  foldToAscii,
} from "../src/util/rename.ts";

// The original app's {category}_{MM-DD-YY}_{vendor}.jpg convention
// (util/rename.ts). The extension is ALWAYS .jpg: every stored/exported
// receipt image is a JPEG re-encode, whatever was uploaded — the upload's own
// extension lives in `originalFileName`.

test("receiptFileName: category prefix, MM-DD-YY date, sanitized vendor, .jpg", () => {
  assert.equal(
    receiptFileName({ category: "Meals", date: "2026-03-14", vendor: "Shop" }),
    "meals_03-14-26_shop.jpg",
  );
  assert.equal(
    receiptFileName({ category: "Fuel", date: "2026-06-12", vendor: "Shell" }),
    "fuel_06-12-26_shell.jpg",
  );
  assert.equal(
    receiptFileName({ category: "Materials", date: "2024-12-30", vendor: "Lowe's" }),
    "mats_12-30-24_lowes.jpg",
  );
});

test("receiptFileName: a blank (or non-Latin) vendor drops to the vendor-less form", () => {
  assert.equal(
    receiptFileName({ category: "Other", date: "2026-03-14", vendor: "" }),
    "misc_03-14-26.jpg",
  );
  // CJK sanitizes to "" — file names stay ASCII (printPdf renders non-ASCII
  // as "?"), so the vendor-less form is the fallback, not a mangled stem.
  assert.equal(
    receiptFileName({ category: "Meals", date: "2026-03-14", vendor: "東京ラーメン" }),
    "meals_03-14-26.jpg",
  );
});

test("receiptFileName: an unparseable date becomes 'unknown' (or its sanitized text)", () => {
  assert.equal(
    receiptFileName({ category: "Travel", date: "", vendor: "Delta" }),
    "travel_unknown_delta.jpg",
  );
  assert.equal(
    receiptFileName({ category: "Travel", date: "n/a", vendor: "Delta" }),
    "travel_na_delta.jpg",
  );
});

test("receiptFileName: legacy 'Meals & Entertainment' still maps to meals", () => {
  assert.equal(
    receiptFileName({
      category: "Meals & Entertainment" as never,
      date: "2026-03-14",
      vendor: "Shop",
    }),
    "meals_03-14-26_shop.jpg",
  );
});

test("sanitizeFilePart: lowercases, joins on underscores, strips punctuation, caps at 40", () => {
  assert.equal(sanitizeFilePart("Lowe's"), "lowes");
  assert.equal(sanitizeFilePart("  Home   Depot  "), "home_depot");
  assert.equal(sanitizeFilePart("Chevron"), "chevron");
  assert.equal(sanitizeFilePart("7-Eleven"), "7_eleven");
  assert.equal(sanitizeFilePart("__a__b__"), "a_b");
  const long = "abcdefghij".repeat(5); // 50 chars
  assert.equal(sanitizeFilePart(long), long.slice(0, 40));
  assert.equal(sanitizeFilePart(long).length, 40);
});

test("sanitizeFilePart: accents fold to ASCII instead of dropping the letter", () => {
  // The Python original stripped the accented letter ('caf_berlin'); the
  // port deliberately folds it so the vendor keeps its name.
  assert.equal(sanitizeFilePart("Café Berlin"), "cafe_berlin");
  assert.equal(sanitizeFilePart("Taquería El Güero"), "taqueria_el_guero");
  assert.equal(sanitizeFilePart("Chevron"), "chevron");
  assert.equal(sanitizeFilePart("7-Eleven"), "7_eleven");
  // Non-Latin scripts have no ASCII fold — they sanitize to "" and the
  // receipt takes the vendor-less name.
  assert.equal(sanitizeFilePart("東京ラーメン"), "");
});

test("foldToAscii: strips combining marks, leaves everything else alone", () => {
  assert.equal(foldToAscii("José Álvarez"), "Jose Alvarez");
  assert.equal(foldToAscii("naïve façade"), "naive facade");
  assert.equal(foldToAscii("plain"), "plain");
  assert.equal(foldToAscii("東京"), "東京"); // no decomposition → unchanged
});

test("dateMMDDYY: ISO → MM-DD-YY, padded; junk falls back", () => {
  assert.equal(dateMMDDYY("2026-03-14"), "03-14-26");
  assert.equal(dateMMDDYY("2024-1-5"), "01-05-24");
  assert.equal(dateMMDDYY(" 2025-12-31 "), "12-31-25");
  assert.equal(dateMMDDYY(""), "unknown");
  assert.equal(dateMMDDYY("03/14/2026"), "03142026"); // sanitized text, not "unknown"
  assert.equal(dateMMDDYY("???"), "unknown");
});
