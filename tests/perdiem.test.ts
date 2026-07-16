import { test } from "node:test";
import assert from "node:assert/strict";
import {
  perDiemAmount,
  perDiemLabel,
  safePerDiemDays,
  PER_DIEM_MAX_DAYS,
} from "../src/util/perdiem.ts";

test("perDiemAmount is 0 unless enabled with sane inputs", () => {
  assert.equal(perDiemAmount(undefined), 0);
  assert.equal(perDiemAmount(null), 0);
  assert.equal(perDiemAmount({ enabled: false, rate: 75, days: 5 }), 0);
  assert.equal(perDiemAmount({ enabled: true, rate: 0, days: 5 }), 0);
  assert.equal(perDiemAmount({ enabled: true, rate: 75, days: 0 }), 0);
  assert.equal(perDiemAmount({ enabled: true, rate: NaN, days: 5 }), 0);
  assert.equal(perDiemAmount({ enabled: true, rate: 75, days: -2 }), 0);
});

test("perDiemAmount multiplies rate × days with money rounding", () => {
  assert.equal(perDiemAmount({ enabled: true, rate: 75, days: 5 }), 375);
  assert.equal(perDiemAmount({ enabled: true, rate: 100, days: 2.5 }), 250);
  // 0.1 × 3 floats to 0.30000000000000004 without the rounding.
  assert.equal(perDiemAmount({ enabled: true, rate: 0.1, days: 3 }), 0.3);
});

test("safePerDiemDays clamps typos, keeps half days", () => {
  assert.equal(safePerDiemDays(2.5), 2.5);
  assert.equal(safePerDiemDays(9999), PER_DIEM_MAX_DAYS);
  assert.equal(safePerDiemDays(Number.POSITIVE_INFINITY), 0);
  assert.equal(safePerDiemDays(-1), 0);
});

test("absurd rates are rejected like any other amount", () => {
  // safeAmount's 1M ceiling applies to the rate and to the product.
  assert.equal(perDiemAmount({ enabled: true, rate: 2_000_000, days: 1 }), 0);
  assert.equal(perDiemAmount({ enabled: true, rate: 900_000, days: 300 }), 0);
});

test("perDiemLabel reads naturally", () => {
  assert.equal(
    perDiemLabel({ enabled: true, rate: 75, days: 5 }),
    "5 days × $75.00/day",
  );
  assert.equal(
    perDiemLabel({ enabled: true, rate: 120.5, days: 1 }),
    "1 day × $120.50/day",
  );
});
