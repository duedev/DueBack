import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatMonthList,
  monthLabel,
  normalizeMonths,
  phoneServiceAmount,
  phoneServiceLabel,
  phoneServiceRate,
} from "../src/util/phone.ts";
import { PHONE_SERVICE_MONTHLY_USD } from "../src/config/constants.ts";

test("normalizeMonths filters junk, dedupes and sorts", () => {
  assert.deepEqual(normalizeMonths(undefined), []);
  assert.deepEqual(normalizeMonths(null), []);
  assert.deepEqual(
    normalizeMonths(["2026-03", "2026-01", "2026-03", "2026-13", "garbage", "2026-1"]),
    ["2026-01", "2026-03"],
  );
});

test("phoneServiceAmount is the default rate × selected months", () => {
  assert.equal(phoneServiceAmount(undefined), 0);
  assert.equal(phoneServiceAmount({ enabled: false, months: ["2026-01"] }), 0);
  assert.equal(phoneServiceAmount({ enabled: true, months: [] }), 0);
  assert.equal(
    phoneServiceAmount({ enabled: true, months: ["2026-01", "2026-02", "2026-03"] }),
    3 * PHONE_SERVICE_MONTHLY_USD,
  );
  // Duplicates and junk never inflate the total.
  assert.equal(
    phoneServiceAmount({ enabled: true, months: ["2026-01", "2026-01", "nope"] }),
    PHONE_SERVICE_MONTHLY_USD,
  );
});

test("monthLabel renders a friendly month", () => {
  assert.equal(monthLabel("2026-03"), "Mar 2026");
  assert.equal(monthLabel("2025-12"), "Dec 2025");
  assert.equal(monthLabel("junk"), "junk"); // display fallback, never throws
});

test("formatMonthList collapses consecutive runs", () => {
  assert.equal(formatMonthList([]), "");
  assert.equal(formatMonthList(["2026-02"]), "Feb 2026");
  assert.equal(formatMonthList(["2026-01", "2026-02", "2026-03"]), "Jan–Mar 2026");
  assert.equal(
    formatMonthList(["2026-05", "2026-01", "2026-02", "2026-03"]),
    "Jan–Mar 2026, May 2026",
  );
  // A run across the new year keeps both years visible.
  assert.equal(formatMonthList(["2025-12", "2026-01"]), "Dec 2025–Jan 2026");
  assert.equal(
    formatMonthList(["2025-11", "2026-02"]),
    "Nov 2025, Feb 2026",
  );
});

test("phoneServiceLabel reads naturally", () => {
  assert.equal(
    phoneServiceLabel({ enabled: true, months: ["2026-01", "2026-02", "2026-03"] }),
    "3 months × $63.00/month (Jan–Mar 2026)",
  );
  assert.equal(
    phoneServiceLabel({ enabled: true, months: ["2026-06"] }),
    "1 month × $63.00/month (Jun 2026)",
  );
});

// ── an adjustable monthly rate, defaulting to the constant ──────────────────

test("phoneServiceRate defaults, honours a set rate, and rejects garbage", () => {
  const months = ["2026-01"];
  // A batch stored before the rate was adjustable carries none.
  assert.equal(phoneServiceRate({ enabled: true, months }), PHONE_SERVICE_MONTHLY_USD);
  assert.equal(phoneServiceRate(undefined), PHONE_SERVICE_MONTHLY_USD);
  assert.equal(phoneServiceRate({ enabled: true, months, rate: 85 }), 85);
  assert.equal(phoneServiceRate({ enabled: true, months, rate: 42.555 }), 42.56);
  // An explicit zero is a real choice, not a missing value.
  assert.equal(phoneServiceRate({ enabled: true, months, rate: 0 }), 0);
  // Junk out of a synced payload falls back rather than poisoning the total.
  for (const rate of [NaN, Infinity, -10, "70" as unknown as number]) {
    assert.equal(
      phoneServiceRate({ enabled: true, months, rate }),
      PHONE_SERVICE_MONTHLY_USD,
      String(rate),
    );
  }
});

test("the amount follows the batch's own rate", () => {
  const months = ["2026-01", "2026-02", "2026-03"];
  assert.equal(phoneServiceAmount({ enabled: true, months, rate: 80 }), 240);
  assert.equal(phoneServiceAmount({ enabled: true, months, rate: 0 }), 0);
  // No rate stored → still the default, so existing reports don't move.
  assert.equal(
    phoneServiceAmount({ enabled: true, months }),
    3 * PHONE_SERVICE_MONTHLY_USD,
  );
});

test("the report label quotes the rate actually used", () => {
  assert.equal(
    phoneServiceLabel({ enabled: true, months: ["2026-01", "2026-02"], rate: 79.5 }),
    "2 months × $79.50/month (Jan–Feb 2026)",
  );
});
