import { test } from "node:test";
import assert from "node:assert/strict";
import EXTRA from "../src/data/vendorDb.extra.json";
import { ALL_VENDORS } from "../src/config/vendors.ts";
import { CATEGORIES } from "../src/config/categories.ts";

// The generated brand table (src/data/vendorDb.extra.json) is data nobody
// reads by eye: a regeneration that emits a stale category name ("Meals &
// Entertainment") or a colliding alias must fail HERE, not silently file
// every affected brand as Other.

const CATS = new Set<string>(CATEGORIES);

test("every generated brand carries a category in the app's taxonomy", () => {
  for (const e of EXTRA as { name: string; category: string }[]) {
    assert.ok(CATS.has(e.category), `${e.name}: "${e.category}"`);
  }
});

test("every merged brand carries a category in the app's taxonomy", () => {
  for (const v of ALL_VENDORS) assert.ok(CATS.has(v.category), v.name);
});

test("aliases and slogans are non-empty, trimmed and lowercase", () => {
  for (const v of ALL_VENDORS) {
    for (const a of [...v.aliases, ...(v.slogans ?? [])]) {
      assert.ok(a.length > 0 && a === a.trim() && a === a.toLowerCase(), `${v.name}: "${a}"`);
    }
  }
});

test("no alias or slogan maps to two brands", () => {
  const owner = new Map<string, string>();
  for (const v of ALL_VENDORS) {
    for (const a of [...v.aliases, ...(v.slogans ?? [])]) {
      const prior = owner.get(a);
      assert.ok(prior === undefined || prior === v.name, `"${a}": ${prior} vs ${v.name}`);
      owner.set(a, v.name);
    }
  }
});

test("the only digit-only alias is the deliberate 76 (see the glyph-pass gotcha in CLAUDE.md)", () => {
  const digitOnly = ALL_VENDORS.flatMap((v) =>
    v.aliases.filter((a) => /^\d+$/.test(a)).map((a) => `${v.name}:${a}`),
  );
  assert.deepEqual(digitOnly, ["76:76"]);
});
