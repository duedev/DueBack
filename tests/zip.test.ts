import { test } from "node:test";
import assert from "node:assert/strict";
import { buildZip, crc32 } from "../src/export/zip.ts";

test("crc32 matches the reference value", () => {
  // CRC-32 of "123456789" is the classic check value 0xCBF43926.
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("buildZip produces a well-formed archive", async () => {
  const entries = [
    { name: "a.txt", data: new TextEncoder().encode("hello hello hello hello") },
    { name: "dir/b.bin", data: new Uint8Array([1, 2, 3, 4, 5]) },
  ];
  const blob = await buildZip(entries);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Local header magic at the start, EOCD magic near the end.
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const eocd = bytes.slice(bytes.length - 22);
  assert.deepEqual([...eocd.slice(0, 4)], [0x50, 0x4b, 0x05, 0x06]);
  const view = new DataView(eocd.buffer, eocd.byteOffset);
  assert.equal(view.getUint16(8, true), 2, "entry count in EOCD");
});

test("buildZip fails loudly past the 65,535-entry ZIP limit", async () => {
  const entries = Array.from({ length: 0x10000 }, (_, i) => ({
    name: `f${i}`,
    data: new Uint8Array(0),
  }));
  await assert.rejects(() => buildZip(entries), /Too many files/);
});

test("compress: false stores the entry verbatim (method 0)", async () => {
  const data = new Uint8Array(4000).fill(0x41); // deflates to almost nothing
  const stored = await buildZip([{ name: "a.jpg", data, compress: false }]);
  const deflated = await buildZip([{ name: "a.jpg", data }]);
  assert.ok(stored.size > deflated.size, "the stored form is the full payload");
  const bytes = new Uint8Array(await stored.arrayBuffer());
  // Local header: signature, version, flags, then the compression method.
  assert.equal(bytes[8]! | (bytes[9]! << 8), 0, "method 0 = stored");
  assert.ok(stored.size >= data.length, "payload present in full");
});
