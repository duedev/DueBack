import test from "node:test";
import assert from "node:assert/strict";
import { challengeSuite, linesToOcr } from "./suite.ts";
import { scoreExtraction, formatScorecard, type BenchmarkRow } from "./score.ts";
import { parseReceipt } from "../../src/pipeline/extract.ts";
import { fuseVendorIdentity } from "../../src/pipeline/logo/fuse.ts";

// The accuracy gate: every change must keep the deterministic rules tier at or
// above this bar on the fixed challenge suite (ported from the original app's
// receipt_testkit.py). If a change drops a challenge, this test names it.

const OVERALL_GATE = 0.95;
const FIELD_GATE = 0.85;

test("challenge suite meets the accuracy gate", () => {
  const rows: BenchmarkRow[] = challengeSuite().map((ch) => {
    const ocr = linesToOcr(ch.lines, ch.confidence ?? 90);
    const ex = parseReceipt(ocr);
    const got = {
      vendor: ex.vendor.value,
      date: ex.date.value,
      amount: ex.amount.value,
      category: ex.category.value,
    };
    const sc = scoreExtraction(ch.truth, got);
    return { id: ch.id, description: ch.description, truth: ch.truth, got, ...sc };
  });

  console.log("\n" + formatScorecard(rows) + "\n");

  const overall = rows.reduce((s, r) => s + r.score, 0) / rows.length;
  const failing = rows.filter((r) => r.score < 0.9);
  assert.ok(
    overall >= OVERALL_GATE,
    `overall ${(overall * 100).toFixed(1)}% < gate ${OVERALL_GATE * 100}%` +
      (failing.length
        ? ` — failing: ${failing.map((r) => `${r.id}(${JSON.stringify(r.got)})`).join(", ")}`
        : ""),
  );

  for (const field of ["vendor", "amount", "date", "category"] as const) {
    const rate = rows.filter((r) => r.fields[field]).length / rows.length;
    assert.ok(
      rate >= FIELD_GATE,
      `${field} accuracy ${(rate * 100).toFixed(0)}% < ${FIELD_GATE * 100}%`,
    );
  }
});

test("logo-only receipt: visual identity completes an unreadable vendor", () => {
  // The killer case for the visual layer: the merchant name is a logo the OCR
  // can't spell — only generic body text survives.
  const lines = [
    "", // logo region — nothing machine-readable
    "STORE #4821",
    "-".repeat(28),
    `${"Wiper blades".padEnd(18)}${(34.99).toFixed(2).padStart(8)}`,
    "-".repeat(28),
    `${"TOTAL".padEnd(18)}${(34.99).toFixed(2).padStart(8)}`,
    "",
    "Date: 05/20/2026",
  ];
  const ex = parseReceipt(linesToOcr(lines));
  assert.equal(ex.vendor.value, "", "vendor should be blank before the logo layer");

  // The embedding index recognizes the header band (fused as in the pipeline).
  const fusion = fuseVendorIdentity(ex, null, {
    name: "AutoZone",
    category: "Other",
    score: 0.88,
  });
  assert.equal(fusion.vendor?.value, "AutoZone");
  assert.equal(fusion.logoMatch?.source, "logo");

  const sc = scoreExtraction(
    { vendor: "AutoZone", date: "2026-05-20", amount: 34.99, category: "Other" },
    {
      vendor: fusion.vendor?.value ?? ex.vendor.value,
      date: ex.date.value,
      amount: ex.amount.value,
      category: fusion.category?.value ?? ex.category.value,
    },
  );
  assert.equal(sc.score, 1);
});
