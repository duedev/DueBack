import test from "node:test";
import assert from "node:assert/strict";
import {
  l2Normalize,
  cosineSimilarity,
} from "../src/pipeline/logo/embedder.ts";
import { fuseVendorIdentity, LOGO_ACCEPT } from "../src/pipeline/logo/fuse.ts";
import type { Extraction } from "../src/pipeline/extract.ts";
import type { VendorMatch } from "../src/config/vendors.ts";
import type { LogoHit } from "../src/pipeline/logo/index.ts";

// The visual-logo fusion layer (Layer 3): who names the vendor when the text
// matcher, the logo embedder, or both have an opinion.

function ex(vendor: string, confidence = 0.5): Extraction {
  return {
    vendor: { value: vendor, confidence },
    date: { value: "2026-06-24", confidence: 0.8 },
    amount: { value: 27.45, confidence: 0.9 },
    tax: { value: 1.68, confidence: 0.8 },
    currency: "USD",
    category: { value: "Other", confidence: 0.4 },
    confidence: 0.6,
    flags: [],
  };
}

const hd: VendorMatch = {
  name: "The Home Depot",
  category: "Office Supplies",
  alias: "home depot",
  via: "exact",
};

const logoShell: LogoHit = { name: "Shell", category: "Fuel", score: 0.91 };

test("embedding math: normalize + cosine", () => {
  const a = l2Normalize(new Float32Array([3, 4]));
  assert.ok(Math.abs(Math.hypot(a[0]!, a[1]!) - 1) < 1e-6);
  assert.ok(Math.abs(cosineSimilarity(a, a) - 1) < 1e-6);
  const b = l2Normalize(new Float32Array([-4, 3]));
  assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-6); // orthogonal
});

test("exact text identity is authoritative (logo not consulted)", () => {
  const f = fuseVendorIdentity(ex("HOME DEPOT"), hd, logoShell);
  assert.equal(f.vendor, undefined); // extract already adopted the brand
  assert.equal(f.logoMatch?.source, "ocr");
  assert.equal(f.logoMatch?.brand, "The Home Depot");
  assert.equal(f.flags.length, 0);
});

test("logo fills a blank vendor and sets the category", () => {
  const f = fuseVendorIdentity(ex(""), null, logoShell);
  assert.equal(f.vendor?.value, "Shell");
  assert.equal(f.category?.value, "Fuel");
  assert.equal(f.logoMatch?.source, "logo");
  assert.ok((f.logoMatch?.score ?? 0) >= LOGO_ACCEPT);
});

test("logo confirms an agreeing shaky vendor (glyph-mangled)", () => {
  const f = fuseVendorIdentity(ex("SHEL L", 0.5), null, logoShell);
  assert.equal(f.vendor?.value, "Shell");
  assert.equal(f.logoMatch?.source, "logo");
});

test("a conflicting confident logo becomes a review flag, not a silent rename", () => {
  const f = fuseVendorIdentity(ex("MOM'S DINER", 0.8), null, logoShell);
  assert.equal(f.vendor, undefined);
  assert.equal(f.category, undefined);
  assert.equal(f.flags[0]?.code, "logo_mismatch");
  assert.equal(f.logoMatch?.brand, "Shell");
});

test("a weak logo hit is ignored", () => {
  const weak: LogoHit = { ...logoShell, score: LOGO_ACCEPT - 0.05 };
  const f = fuseVendorIdentity(ex(""), null, weak);
  assert.equal(f.vendor, undefined);
  assert.equal(f.logoMatch, undefined);
  assert.equal(f.flags.length, 0);
});
