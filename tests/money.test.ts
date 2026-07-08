import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAmount,
  safeAmount,
  detectCurrency,
  excelMoneyFormat,
} from "../src/util/money.ts";

test("parseAmount: US formatting", () => {
  assert.equal(parseAmount("$1,234.56"), 1234.56);
  assert.equal(parseAmount("12.00"), 12);
  assert.equal(parseAmount("USD 7.5"), 7.5);
  assert.equal(parseAmount("$0.99"), 0.99);
  assert.equal(parseAmount("1,000"), 1000);
});

test("parseAmount: European formatting", () => {
  assert.equal(parseAmount("1.234,56"), 1234.56);
  assert.equal(parseAmount("12,00"), 12);
  assert.equal(parseAmount("€ 9,99"), 9.99);
});

test("parseAmount: rejects junk and absurd values", () => {
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount("abc"), null);
  assert.equal(parseAmount("9999999999"), null); // > 1,000,000 guard
});

test("safeAmount clamps non-finite and negative", () => {
  assert.equal(safeAmount(Number.NaN), 0);
  assert.equal(safeAmount(Infinity), 0);
  assert.equal(safeAmount(-5), 0);
  assert.equal(safeAmount(10.005), 10.01);
});

test("detectCurrency from symbol or code", () => {
  assert.equal(detectCurrency("Total £10.00"), "GBP");
  assert.equal(detectCurrency("EUR 5.00"), "EUR");
  assert.equal(detectCurrency("plain 5.00", "CAD"), "CAD");
});

test("excelMoneyFormat picks a symbol", () => {
  assert.equal(excelMoneyFormat("USD"), "$#,##0.00");
  assert.equal(excelMoneyFormat("EUR"), "€#,##0.00");
});

test("parseAmount: 3-decimal unit prices/quantities are decimals, not thousands", () => {
  // Fuel receipts print these on every sale; reading them as grouping turned
  // 11.204 gallons into $11,204.
  assert.equal(parseAmount("3.499"), 3.5);
  assert.equal(parseAmount("11.204"), 11.2);
  assert.equal(parseAmount("0.599"), 0.6);
  // Multiple dots stay EU thousands grouping; mixed separators unchanged.
  assert.equal(parseAmount("1.234.567,89"), null); // > 1,000,000 guard
  assert.equal(parseAmount("1.234,56"), 1234.56);
  assert.equal(parseAmount("1,000"), 1000);
});

test("parseAmount: accepts a plain number (Svelte number-input binding)", () => {
  // <input type="number"> rebinds as a number after a user edit; the review
  // modal's save path passes it straight through.
  assert.equal(parseAmount(123.45), 123.45);
  assert.equal(parseAmount(0), 0);
  assert.equal(parseAmount(45.678), 45.68); // rounded to cents
  assert.equal(parseAmount(Number.NaN), null);
  assert.equal(parseAmount(Number.POSITIVE_INFINITY), null);
  assert.equal(parseAmount(2_000_000), null); // absurd magnitude
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount(undefined), null);
});
