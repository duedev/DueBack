import { test } from "node:test";
import assert from "node:assert/strict";
import { buildZip } from "../src/export/zip.ts";
import {
  readZip,
  isArchiveJunk,
  mimeForPath,
  archiveEntryName,
} from "../src/pipeline/unzip.ts";
import { looksLikeZip } from "../src/util/files.ts";

const enc = new TextEncoder();
const bytes = (s: string): Uint8Array => enc.encode(s);
const text = (u: Uint8Array): string => new TextDecoder().decode(u);

/** A JPEG big enough that DEFLATE actually shrinks it (so the round-trip
 *  exercises the compressed path, not just the stored one). */
const jpegish = (marker: string): Uint8Array =>
  bytes(`\xff\xd8\xff${marker}`.padEnd(400, " "));

// ── round-trip through the writer ────────────────────────────────────────────

test("reads entries back out of an archive, nested folders and all", async () => {
  const blob = await buildZip([
    { name: "Tesla/2026/03/session_01.jpg", data: jpegish("one") },
    { name: "Tesla/2026/04/session_02.jpg", data: jpegish("two") },
    { name: "Tesla/notes.pdf", data: bytes("%PDF-1.4 fake") },
  ]);
  const { entries, skipped, truncated } = await readZip(await blob.arrayBuffer());
  assert.equal(entries.length, 3);
  assert.equal(skipped.length, 0);
  assert.equal(truncated, false);
  const byPath = new Map(entries.map((e) => [e.path, e.data]));
  assert.equal(text(byPath.get("Tesla/2026/03/session_01.jpg")!), text(jpegish("one")));
  assert.equal(text(byPath.get("Tesla/notes.pdf")!), "%PDF-1.4 fake");
});

test("stored (uncompressed) entries survive the round-trip", async () => {
  // Random-ish bytes don't deflate smaller, so the writer stores them raw.
  const raw = new Uint8Array(256).map((_, i) => (i * 97) % 251);
  const blob = await buildZip([{ name: "a.png", data: raw }]);
  const { entries } = await readZip(await blob.arrayBuffer());
  assert.deepEqual([...entries[0]!.data], [...raw]);
});

// ── filtering ────────────────────────────────────────────────────────────────

test("keeps only the requested extensions", async () => {
  const blob = await buildZip([
    { name: "receipts/a.jpg", data: jpegish("a") },
    { name: "receipts/readme.txt", data: bytes("hello") },
    { name: "receipts/b.PDF", data: bytes("%PDF") },
  ]);
  const { entries, skipped } = await readZip(await blob.arrayBuffer(), {
    extensions: [".jpg", ".pdf"],
  });
  assert.deepEqual(
    entries.map((e) => e.path),
    ["receipts/a.jpg", "receipts/b.PDF"],
    "extension match is case-insensitive",
  );
  assert.deepEqual(skipped, [{ path: "receipts/readme.txt", reason: "unsupported type" }]);
});

test("drops macOS and directory junk without reporting it as skipped", async () => {
  const blob = await buildZip([
    { name: "trip/", data: new Uint8Array(0) },
    { name: "__MACOSX/trip/._receipt.jpg", data: bytes("applejunk") },
    { name: "trip/.DS_Store", data: bytes("junk") },
    { name: "trip/._receipt.jpg", data: bytes("applejunk") },
    { name: "trip/receipt.jpg", data: jpegish("real") },
  ]);
  const { entries, skipped } = await readZip(await blob.arrayBuffer(), {
    extensions: [".jpg"],
  });
  assert.deepEqual(
    entries.map((e) => e.path),
    ["trip/receipt.jpg"],
    "the AppleDouble stub shares the .jpg extension and must not become a receipt",
  );
  assert.equal(skipped.length, 0);
});

test("isArchiveJunk covers the shapes archivers add", () => {
  assert.equal(isArchiveJunk("folder/"), true);
  assert.equal(isArchiveJunk("__MACOSX/a/._b.jpg"), true);
  assert.equal(isArchiveJunk("a/._b.jpg"), true);
  assert.equal(isArchiveJunk("a/.DS_Store"), true);
  assert.equal(isArchiveJunk("a/Thumbs.db"), true);
  assert.equal(isArchiveJunk("a/b/receipt.jpg"), false);
});

// ── caps ─────────────────────────────────────────────────────────────────────

test("stops at the entry cap and says so", async () => {
  const blob = await buildZip(
    Array.from({ length: 5 }, (_, i) => ({
      name: `r${i}.jpg`,
      data: jpegish(`r${i}`),
    })),
  );
  const { entries, truncated } = await readZip(await blob.arrayBuffer(), {
    maxEntries: 3,
  });
  assert.equal(entries.length, 3);
  assert.equal(truncated, true);
});

test("refuses an oversized entry", async () => {
  const blob = await buildZip([
    { name: "big.jpg", data: jpegish("big") },
    { name: "small.jpg", data: bytes("\xff\xd8\xff-tiny") },
  ]);
  const { entries, skipped } = await readZip(await blob.arrayBuffer(), {
    maxEntryBytes: 100,
  });
  assert.deepEqual(entries.map((e) => e.path), ["small.jpg"]);
  assert.deepEqual(skipped, [{ path: "big.jpg", reason: "too large" }]);
});

test("a lying directory size can't smuggle a zip bomb past the entry cap", async () => {
  // 512 KB of zeros deflates to well under 1 KB; the central directory is
  // then edited to *declare* the entry tiny, the way a crafted bomb would.
  // The streamed inflate must count honestly and abort, not buffer it all.
  const blob = await buildZip([
    { name: "bomb.jpg", data: new Uint8Array(512 * 1024) },
  ]);
  const zip = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(zip.buffer);
  const cen = view.getUint32(zip.length - 22 + 16, true); // EOCD → central dir
  assert.equal(view.getUint32(cen, true), 0x02014b50, "found the central header");
  view.setUint32(cen + 24, 10, true); // declared uncompressed size: 10 bytes
  const { entries, skipped } = await readZip(zip, { maxEntryBytes: 4096 });
  assert.equal(entries.length, 0);
  assert.deepEqual(skipped, [{ path: "bomb.jpg", reason: "too large" }]);
});

test("the aggregate inflated cap stops extraction across entries", async () => {
  const blob = await buildZip(
    Array.from({ length: 4 }, (_, i) => ({
      name: `r${i}.jpg`,
      data: jpegish(`r${i}`),
    })),
  );
  const each = jpegish("r0").length;

  // Room for two entries plus change: the third aborts mid-inflate against
  // the remaining budget, the fourth likewise.
  let result = await readZip(await blob.arrayBuffer(), {
    maxTotalBytes: each * 2 + 100,
  });
  assert.deepEqual(result.entries.map((e) => e.path), ["r0.jpg", "r1.jpg"]);
  assert.deepEqual(result.skipped, [
    { path: "r2.jpg", reason: "archive limit reached" },
    { path: "r3.jpg", reason: "archive limit reached" },
  ]);

  // Budget consumed exactly: later entries are skipped before any inflate.
  result = await readZip(await blob.arrayBuffer(), { maxTotalBytes: each * 2 });
  assert.deepEqual(result.entries.map((e) => e.path), ["r0.jpg", "r1.jpg"]);
  assert.deepEqual(result.skipped.map((s) => s.reason), [
    "archive limit reached",
    "archive limit reached",
  ]);
});

// ── malformed input ──────────────────────────────────────────────────────────

test("throws on something that is not a ZIP", async () => {
  await assert.rejects(
    () => readZip(bytes("this is a plain text file, not an archive")),
    /not a ZIP archive/,
  );
});

test("survives a trailing ZIP comment", async () => {
  const blob = await buildZip([{ name: "a.jpg", data: jpegish("a") }]);
  const base = new Uint8Array(await blob.arrayBuffer());
  // Append a comment: bump the EOCD comment length, then the bytes.
  const comment = bytes("packed by a chatty archiver");
  const withComment = new Uint8Array(base.length + comment.length);
  withComment.set(base);
  withComment.set(comment, base.length);
  new DataView(withComment.buffer).setUint16(
    base.length - 2,
    comment.length,
    true,
  );
  const { entries } = await readZip(withComment);
  assert.deepEqual(entries.map((e) => e.path), ["a.jpg"]);
});

// ── naming ───────────────────────────────────────────────────────────────────

test("looksLikeZip matches by extension or MIME", () => {
  assert.equal(looksLikeZip("Receipts.ZIP"), true);
  assert.equal(looksLikeZip("archive", "application/x-zip-compressed"), true);
  assert.equal(looksLikeZip("photo.jpg", "image/jpeg"), false);
});

test("mimeForPath maps the accepted types", () => {
  assert.equal(mimeForPath("a/b.JPG"), "image/jpeg");
  assert.equal(mimeForPath("a/b.pdf"), "application/pdf");
  assert.equal(mimeForPath("a/b.heic"), "image/heic");
  assert.equal(mimeForPath("a/b.xyz"), "application/octet-stream");
});

test("archive entry names keep the folder path for the card", () => {
  const n = archiveEntryName("trip.zip", "Tesla/2026/03/session_01.pdf");
  assert.equal(n.fileName, "session_01.pdf");
  assert.equal(n.originalFileName, "trip.zip › Tesla/2026/03/session_01.pdf");
  // A file at the archive root needs no path.
  assert.equal(
    archiveEntryName("trip.zip", "session.pdf").originalFileName,
    "trip.zip › session.pdf",
  );
});
