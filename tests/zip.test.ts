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
