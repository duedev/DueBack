import { test } from "node:test";
import assert from "node:assert/strict";
import { LEGACY_CATEGORIES, normalizeCategory, CATEGORIES } from "../src/config/categories.ts";

// Receipts stored by an older build (or pulled from a synced payload an older
// client wrote) carry retired category names; every repo read maps them to
// the current taxonomy so they land on a sheet that exists.

test("retired category names map to current ones; current names pass through", () => {
  assert.equal(normalizeCategory("Meals & Entertainment"), "Meals");
  for (const c of CATEGORIES) assert.equal(normalizeCategory(c), c);
  assert.equal(normalizeCategory("Fuel"), "Fuel");
});

test("every legacy target is a current category", () => {
  for (const target of Object.values(LEGACY_CATEGORIES)) {
    assert.ok(CATEGORIES.includes(target), `${target} is in the taxonomy`);
  }
});
