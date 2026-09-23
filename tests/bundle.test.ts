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

// ── Compact vs full ──────────────────────────────────────────────────────────
// The bundle's I/O is injected, so these build REAL archives from fakes and
// read them back with the app's own ZIP reader.

import sharp from "sharp";
import { buildTuningBundle, bundleFileName, annotatedEntryName, formatBytes, COMPACT_IMAGE_EDGE, COMPACT_IMAGE_QUALITY, type BundleDeps } from "../src/train/bundle.ts";
import { readZip } from "../src/pipeline/unzip.ts";

function fakeDeps(blobs: Record<string, Blob>, shrink: BundleDeps["shrink"], corrections: unknown[] = []): BundleDeps & { shrunk: string[] } {
  const shrunk: string[] = [];
  return {
    shrunk,
    getBlob: async (key) => blobs[key],
    getCorrections: async () => corrections,
    shrink: async (b) => {
      shrunk.push(await b.text());
      return shrink(b);
    },
  };
}
const bytes = (s: string, type = "image/jpeg") => new Blob([s], { type });
async function names(blob: Blob): Promise<string[]> {
  return (await readZip(new Uint8Array(await blob.arrayBuffer()))).entries.map((e) => e.path);
}
async function entry(blob: Blob, path: string): Promise<Uint8Array> {
  const e = (await readZip(new Uint8Array(await blob.arrayBuffer()))).entries.find((x) => x.path === path);
  assert.ok(e, `missing ${path}`);
  return e.data;
}

test("bundle file names say which mode they are; annotated entries are .jpg stems", () => {
  const now = new Date(2026, 8, 3);
  assert.equal(bundleFileName("full", now), "dueback_tuning_20260903.zip");
  assert.equal(bundleFileName("compact", now), "dueback_tuning_compact_20260903.zip");
  assert.equal(annotatedEntryName({ fileName: "fuel_05-09-25_chevron.jpg" }), "images/annotated/fuel_05-09-25_chevron.jpg");
  assert.equal(annotatedEntryName({ fileName: "IMG_1.HEIC" }), "images/annotated/IMG_1.jpg");
  assert.equal(annotatedEntryName({ fileName: ".jpg" }), "images/annotated/receipt.jpg");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(640 * 1024), "640 KB");
  assert.equal(formatBytes(18.44 * 1024 * 1024), "18.4 MB");
});

const THREE: Receipt[] = [
  row({ id: "a", fileKey: "oa", annotatedKey: "na", cleanedKey: "ca", fileName: "fuel_02-11-26_chevron.jpg", originalFileName: "app.pdf (page 27 of 37)" }),
  // Renamed twins collide — the second gets _2, as in full mode.
  row({ id: "b", fileKey: "ob", cleanedKey: "cb", fileName: "fuel_02-11-26_chevron.jpg", originalFileName: "scan.pdf (page 21 of 27)" }),
  // A failed read: no cleaned/annotated copy, only its original.
  row({ id: "c", fileKey: "oc", fileName: "IMG_9.HEIC", mimeType: "image/heic", status: "failed" }),
];
const STORED = { oa: bytes("ORIG-A"), ob: bytes("ORIG-B"), oc: bytes("ORIG-C", "image/heic"), na: bytes("ANNOTATED-A-1600px"), ca: bytes("CLEAN-A"), cb: bytes("CLEANED-B-1600px") };

test("compact: the three data files + one shrunk highlighted copy per receipt, no originals, every row marked", async () => {
  const deps = fakeDeps(STORED, async () => new TextEncoder().encode("small"), [{ field: "vendor" }]);
  const b = await buildTuningBundle(THREE, { mode: "compact", deps, now: new Date(2026, 8, 3) });
  assert.equal(b.mode, "compact");
  assert.equal(b.fileName, "dueback_tuning_compact_20260903.zip");
  assert.deepEqual(await names(b.blob), [
    "corrections.json",
    "extraction.json",
    "report.csv",
    "images/annotated/fuel_02-11-26_chevron.jpg",
    "images/annotated/fuel_02-11-26_chevron_2.jpg",
  ]);
  // The annotated copy wins over the cleaned one; the failed read has none.
  assert.deepEqual(deps.shrunk, ["ANNOTATED-A-1600px", "CLEANED-B-1600px"]);
  assert.equal(new TextDecoder().decode(await entry(b.blob, "images/annotated/fuel_02-11-26_chevron.jpg")), "small");
  const rows = JSON.parse(new TextDecoder().decode(await entry(b.blob, "extraction.json"))) as { id: string; originalOmitted?: boolean }[];
  assert.deepEqual(rows.map((r) => [r.id, r.originalOmitted]), [["a", true], ["b", true], ["c", true]]);
  assert.equal(b.omittedOriginals, 3);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await entry(b.blob, "corrections.json"))), [{ field: "vendor" }]);
});

test("full: originals verbatim beside the stored highlighted copies, nothing re-encoded", async () => {
  const deps = fakeDeps(STORED, async () => {
    throw new Error("full mode must not shrink");
  });
  const b = await buildTuningBundle(THREE, { mode: "full", deps, now: new Date(2026, 8, 3) });
  assert.equal(b.fileName, "dueback_tuning_20260903.zip");
  assert.deepEqual(await names(b.blob), [
    "corrections.json",
    "extraction.json",
    "report.csv",
    "images/original/app.pdf (page 27 of 37).jpg",
    "images/annotated/fuel_02-11-26_chevron.jpg",
    "images/original/scan.pdf (page 21 of 27).jpg",
    "images/annotated/fuel_02-11-26_chevron_2.jpg",
    "images/original/IMG_9.HEIC",
  ]);
  assert.equal(new TextDecoder().decode(await entry(b.blob, "images/annotated/fuel_02-11-26_chevron_2.jpg")), "CLEANED-B-1600px");
  assert.equal(b.omittedOriginals, 0);
  // The default mode is full (the API keeps its old behaviour).
  assert.equal((await buildTuningBundle(THREE, { deps })).mode, "full");
});

test("compact never ships a copy bigger than the stored one, and a failed shrink keeps the stored bytes", async () => {
  const bigger = await buildTuningBundle([THREE[0]!], {
    mode: "compact",
    deps: fakeDeps(STORED, async () => new TextEncoder().encode("a re-encode that came out LARGER than the stored copy")),
  });
  assert.equal(new TextDecoder().decode(await entry(bigger.blob, "images/annotated/fuel_02-11-26_chevron.jpg")), "ANNOTATED-A-1600px");
  const failed = await buildTuningBundle([THREE[0]!], {
    mode: "compact",
    deps: fakeDeps(STORED, async () => {
      throw new Error("The source image could not be decoded.");
    }),
  });
  assert.equal(new TextDecoder().decode(await entry(failed.blob, "images/annotated/fuel_02-11-26_chevron.jpg")), "ANNOTATED-A-1600px");
});

// A 50-receipt batch with realistic payloads: each original a scanned-page
// render at the pipeline's OCR size (2010×2600 JPEG at IMAGE_PREP.ocrQuality),
// each stored highlighted copy 1237×1600 at the stored quality, and a shrink
// that does what `thumbnail(…, COMPACT_IMAGE_EDGE, COMPACT_IMAGE_QUALITY,
// "edge", false)` does in the browser. Sharp stands in for the canvas encoder.
test("a 50-receipt batch: compact is a small fraction of full and fits an email", async () => {
  const lines = Array.from({ length: 46 }, (_, i) =>
    `<text x="80" y="${150 + i * 50}">${String(i + 1).padStart(2, "0")} ITEM DESCRIPTION ${"#".repeat((i * 7) % 13)} ${(i * 3.17 + 1).toFixed(2)}</text>`,
  ).join("");
  const page = (w: number, h: number) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 2010 2600">` +
        `<rect width="2010" height="2600" fill="#f4f1ea"/><g font-family="monospace" font-size="38" fill="#222">${lines}</g></svg>`,
    );
  // Scanner grain makes real scans heavier than flat synthetic paper.
  const noisy = async (w: number, h: number, quality: number) =>
    sharp(page(w, h))
      .composite([{ input: { create: { width: w, height: h, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 18 } } }, blend: "soft-light" }])
      .jpeg({ quality })
      .toBuffer();
  const original = await noisy(2010, 2600, 95);
  const annotated = await noisy(1237, 1600, 85);
  const blobs: Record<string, Blob> = {};
  const receipts: Receipt[] = [];
  for (let i = 0; i < 50; i++) {
    blobs[`o${i}`] = new Blob([new Uint8Array(original)], { type: "image/jpeg" });
    blobs[`n${i}`] = new Blob([new Uint8Array(annotated)], { type: "image/jpeg" });
    receipts.push(row({ id: `r${i}`, fileKey: `o${i}`, annotatedKey: `n${i}`, fileName: `fuel_${i}.jpg`, originalFileName: `scan.pdf (page ${i + 1} of 50)` }));
  }
  const shrink = async (b: Blob) =>
    new Uint8Array(
      await sharp(Buffer.from(await b.arrayBuffer()))
        .resize({ width: COMPACT_IMAGE_EDGE, height: COMPACT_IMAGE_EDGE, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: Math.round(COMPACT_IMAGE_QUALITY * 100) })
        .toBuffer(),
    );
  const full = await buildTuningBundle(receipts, { mode: "full", deps: fakeDeps(blobs, shrink) });
  const compact = await buildTuningBundle(receipts, { mode: "compact", deps: fakeDeps(blobs, shrink) });
  console.log(`  50 receipts: full ${formatBytes(full.blob.size)}, compact ${formatBytes(compact.blob.size)}`);
  assert.ok(compact.blob.size < full.blob.size / 4, `compact ${compact.blob.size} vs full ${full.blob.size}`);
  assert.ok(compact.blob.size < 25 * 1024 * 1024);
  // Still one highlighted image per receipt, each downscaled to the compact edge.
  const imgs = (await readZip(new Uint8Array(await compact.blob.arrayBuffer()))).entries.filter((e) => e.path.startsWith("images/"));
  assert.equal(imgs.length, 50);
  const meta = await sharp(Buffer.from(imgs[0]!.data)).metadata();
  assert.equal(Math.max(meta.width ?? 0, meta.height ?? 0), COMPACT_IMAGE_EDGE);
});
