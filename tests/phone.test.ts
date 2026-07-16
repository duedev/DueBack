import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatMonthList,
  monthLabel,
  normalizeMonths,
  phoneServiceAmount,
  phoneServiceLabel,
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

test("phoneServiceAmount is the fixed rate × selected months", () => {
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
