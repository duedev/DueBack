import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { sha256Hex, sha256HexPure } from "../src/pipeline/hash.ts";

// The pure SHA-256 is the fallback for non-secure origins (plain-http LAN
// testing on a phone has no crypto.subtle). It must match SubtleCrypto
// byte for byte or cache/dedup/sync keys would diverge between origins.

const ref = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

test("sha256HexPure matches node:crypto across the padding boundaries", () => {
  const cases = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000];
  for (const n of cases) {
    const b = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
    assert.equal(sha256HexPure(b), ref(b), `length ${n}`);
  }
  assert.equal(
    sha256HexPure(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("a ~1 MB buffer hashes identically", () => {
  const big = new Uint8Array(randomBytes(1_048_576 + 13));
  assert.equal(sha256HexPure(big), ref(big));
});

test("sha256Hex (SubtleCrypto here) and the pure path agree", async () => {
  const b = new Uint8Array(randomBytes(777));
  const viaSubtle = await sha256Hex(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  assert.equal(viaSubtle, sha256HexPure(b));
  assert.equal(viaSubtle, ref(b));
});
