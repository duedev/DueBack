import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// tesseract.js's browser recognize() awaits a FileReader for a Blob BEFORE it
// posts the job, through an async send() nobody awaits. A pause that
// terminated the worker inside that window turned into an unhandled
// `null.postMessage` rejection — a flaky page error in e2e 7c. The engine
// therefore reads the bytes itself and hands tesseract a Uint8Array, whose
// hop to postMessage is microtasks only. That ordering lives inside the
// browser worker, so it is pinned on the source.

test("the Tesseract engine reads the image bytes before handing them to the worker", () => {
  const src = readFileSync(new URL("../src/pipeline/ocr.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("class TesseractEngine"), src.indexOf("function clamp01"));
  const read = body.indexOf("image.arrayBuffer()");
  const worker = body.indexOf("this.getWorker()", body.indexOf("async recognize("));
  assert.ok(read > 0, "recognize reads the Blob's bytes itself");
  assert.ok(read < worker, "…before it gets (or starts) the worker");
  assert.match(body, /worker\.recognize\(\s*bytes\b/, "the worker receives the bytes, never the Blob");
  assert.doesNotMatch(body, /worker\.recognize\(\s*image\b/);
});
