import { test } from "node:test";
import assert from "node:assert/strict";
import { extractionEntry, originalEntryName, BUNDLE_ORIGINALS_BUDGET } from "../src/train/bundle.ts";
import { ASSIST_RAW_MAX } from "../src/pipeline/vision/provenance.ts";
import type { AssistProvenance, OcrLine, Receipt } from "../src/types.ts";

// The tuning bundle's original-image entries: the card's display name
// ("trip.zip › 2026/03/scan.pdf (page 2 of 8)") must become one flat,
// honestly-extended archive entry. The budget itself needs IndexedDB and is
// exercised in the browser.

test("archive paths flatten and page names get the JPEG extension they are", () => {
  assert.equal(
    originalEntryName({ fileName: "scan.pdf (page 2 of 8)", originalFileName: "trip.zip › 2026/03/scan.pdf (page 2 of 8)", mimeType: "image/jpeg" }),
    "trip.zip__2026_03_scan.pdf (page 2 of 8).jpg",
  );
  assert.equal(
    originalEntryName({ fileName: "IMG_1.HEIC", originalFileName: "IMG_1.HEIC", mimeType: "image/heic" }),
    "IMG_1.HEIC",
  );
  assert.equal(originalEntryName({ fileName: "photo", mimeType: "image/png" }), "photo.png");
  assert.equal(originalEntryName({ fileName: "photo", mimeType: "" }, "image/webp"), "photo.webp");
  assert.ok(BUNDLE_ORIGINALS_BUDGET >= 100 * 1024 * 1024);
});

// extraction.json rows: an AI read carries its provenance; a row stored
// before provenance existed held the MODEL'S answer in ocrText, which the
// bundle moves to assist.rawAnswer, rebuilding ocrText from the OCR lines.

const LINES: OcrLine[] = [
  { text: "COSTCO", confidence: 80, bbox: { x: 0, y: 0, w: 1, h: 0.1 }, words: [] },
  { text: "TOTAL 9.99", confidence: 60, bbox: { x: 0, y: 0.5, w: 1, h: 0.1 }, words: [] },
];

function row(patch: Partial<Receipt> = {}): Receipt {
  return {
    id: "r1",
    batchId: "b1",
    fileKey: "k",
    fileName: "misc_07-01-25_costco.jpg",
    mimeType: "image/jpeg",
    status: "done",
    vendor: { value: "Costco", confidence: 0.9 },
    date: { value: "2025-07-01", confidence: 0.9 },
    amount: { value: 9.99, confidence: 0.92 },
    tax: { value: 0, confidence: 0.85 },
    currency: "USD",
    category: { value: "Other", confidence: 0.9 },
    confidence: 0.92,
    flags: [],
    ocrText: "COSTCO\n\nTOTAL 9.99",
    ocrLines: LINES,
    methodUsed: "rules",
    cost: 0,
    approved: false,
    reviewRequired: false,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

const PROV: AssistProvenance = {
  backend: "cloud",
  provider: "OpenRouter",
  model: "openrouter/free",
  servedModel: "qwen/x:free",
  host: "internet",
  keySource: "builtin",
  requestedStrategy: "oneshot",
  strategy: "oneshot",
  viaProxy: false,
  calls: 1,
  rawAnswer: '{"vendor":"Costco"}',
  rules: { vendor: "WHOLESALE", date: "2025-01-01", amount: 9.99, tax: 0, category: "Other", confidence: 0.7 },
};

test("an AI row exports its provenance and cost; its ocrText is the OCR read", () => {
  const e = extractionEntry(
    row({ methodUsed: "paid", methodDetail: "OpenRouter · openrouter/free → qwen/x:free · one-shot", assist: PROV, cost: 0.002 }),
  );
  assert.deepEqual(e.assist, PROV);
  assert.equal(e.cost, 0.002);
  assert.equal(e.method, "OpenRouter · openrouter/free → qwen/x:free · one-shot");
  assert.equal(e.ocrText, "COSTCO\n\nTOTAL 9.99");
  assert.equal("originalOmitted" in e, false);
  assert.equal(extractionEntry(row(), true).originalOmitted, true);
});

test("a legacy AI row's answer moves to assist, its old method is parsed, and ocrText is rebuilt", () => {
  const json = '{"vendor":"Costco"}';
  const e = extractionEntry(row({ methodUsed: "paid", methodDetail: "Self-hosted · bonsai-27b", ocrText: json }));
  assert.equal(e.ocrText, "COSTCO\nTOTAL 9.99");
  assert.deepEqual(e.assist, {
    legacy: true,
    provider: "Self-hosted",
    model: "bonsai-27b",
    strategy: "oneshot",
    rawAnswer: json,
  });
  // Tail-capped like a new record's raw answer.
  const long = extractionEntry(
    row({ methodUsed: "paid", methodDetail: "Self-hosted · m", ocrText: "x".repeat(9000) + json }),
  ).assist as { rawAnswer: string };
  assert.equal(long.rawAnswer.length, ASSIST_RAW_MAX + 1);
  assert.ok(long.rawAnswer.endsWith(json));
});

test("a rules row exports no assist key and its own ocrText", () => {
  const e = extractionEntry(row());
  assert.equal("assist" in e, false);
  assert.equal(e.method, "rules");
  assert.equal(e.cost, 0);
  assert.equal(e.ocrText, "COSTCO\n\nTOTAL 9.99");
  assert.deepEqual(e.ocrLines, LINES);
});
