import { test } from "node:test";
import assert from "node:assert/strict";
import { semanticKey, findSemanticDuplicate, type DupRecord } from "../src/pipeline/dedup.ts";

function rec(p: Partial<DupRecord>): DupRecord {
  return { id: "x", label: "r.jpg", vendor: "Shell", date: "2026-05-01", amount: 45.2, ...p };
}

test("semanticKey normalizes vendor/date/amount and ignores zero amounts", () => {
  assert.equal(
    semanticKey({ vendor: " Shell ", date: "2026-05-01", amount: 45.2 }),
    "shell|2026-05-01|45.20",
  );
  // No usable amount → no key (can't dedup on it).
  assert.equal(semanticKey({ vendor: "Shell", date: "2026-05-01", amount: 0 }), null);
});

test("finds a same vendor+date+amount duplicate even with a different photo", () => {
  const current = rec({ id: "b", label: "back.jpg" });
  const others = [
    rec({ id: "a", label: "front.jpg" }), // same vendor/date/amount
    rec({ id: "c", label: "other.jpg", vendor: "Chevron", amount: 30 }),
  ];
  const dup = findSemanticDuplicate(current, others);
  assert.equal(dup?.label, "front.jpg");
});

test("does not match itself or genuinely different receipts", () => {
  const current = rec({ id: "a", label: "self.jpg" });
  assert.equal(findSemanticDuplicate(current, [current]), null);
  assert.equal(
    findSemanticDuplicate(current, [rec({ id: "z", amount: 99.99 })]),
    null,
  );
});

// ── Audit round (2026-09) ─────────────────────────────────────────────────────
import { semanticKey as semKey } from "../src/pipeline/dedup.ts";

test("two unreadable receipts sharing only an amount are not duplicates", () => {
  assert.equal(semKey({ vendor: "", date: "", amount: 12 }), null);
  assert.equal(semKey({ vendor: "Shop", date: "", amount: 12 }), "shop||12.00");
  assert.equal(semKey({ vendor: "", date: "2026-03-14", amount: 12 }), "|2026-03-14|12.00");
});
