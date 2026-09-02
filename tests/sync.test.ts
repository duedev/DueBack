import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendPendingDelete,
  chooseAdoptionBatch,
  pendingDeleteKey,
  pruneConsumed,
  remoteAction,
  uploadedBlobsKey,
  PENDING_DELETES_CAP,
  type PendingDelete,
} from "../src/store/syncMerge.ts";

// The pure half of the sync engine: LWW merge decisions, the pending-delete
// log (tombstone queue), per-account blob-key scoping, and second-device
// batch adoption. The Supabase/IndexedDB glue in sync.ts is browser-only and
// validated by typecheck + the traces documented in the audit-fix report.

const del = (over: Partial<PendingDelete> = {}): PendingDelete => ({
  table: "receipts",
  id: "rcpt_1",
  blobKeys: ["blob_a"],
  at: 1000,
  ...over,
});

// ---- remoteAction (pull + realtime LWW) ------------------------------------

test("live remote rows apply only when strictly newer (or missing locally)", () => {
  assert.equal(remoteAction(undefined, 100, null), "apply", "missing locally");
  assert.equal(remoteAction(50, 100, null), "apply", "remote newer");
  assert.equal(remoteAction(100, 100, null), "ignore", "tie: our own echo");
  assert.equal(remoteAction(150, 100, null), "ignore", "local newer");
});

test("tombstones delete a strictly older local row and are never inserted", () => {
  const iso = "2026-08-26T00:00:00Z";
  assert.equal(remoteAction(50, 100, iso), "deleteLocal", "tombstone newer");
  assert.equal(remoteAction(100, 100, iso), "ignore", "tie keeps local");
  assert.equal(remoteAction(150, 100, iso), "ignore", "newer local edit survives");
  assert.equal(remoteAction(undefined, 100, iso), "ignore", "no local: no insert");
});

// ---- pending-delete log ----------------------------------------------------

test("appendPendingDelete appends and dedupes (table, id) keeping the newest", () => {
  const one = appendPendingDelete([], del());
  assert.equal(one.length, 1);
  const two = appendPendingDelete(one, del({ id: "rcpt_2", at: 2000 }));
  assert.equal(two.length, 2);
  const rekeyed = appendPendingDelete(two, del({ at: 3000, blobKeys: [] }));
  assert.equal(rekeyed.length, 2, "same (table,id) replaces");
  assert.deepEqual(
    rekeyed.find((e) => e.id === "rcpt_1"),
    del({ at: 3000, blobKeys: [] }),
  );
  const cross = appendPendingDelete(two, del({ table: "brand_logos" }));
  assert.equal(cross.length, 3, "same id in another table is a new entry");
});

test("appendPendingDelete caps the log, dropping the oldest entries", () => {
  let list: PendingDelete[] = [];
  for (let i = 0; i < PENDING_DELETES_CAP + 10; i++) {
    list = appendPendingDelete(list, del({ id: `rcpt_${i}`, at: i }));
  }
  assert.equal(list.length, PENDING_DELETES_CAP);
  assert.equal(list[0]!.id, "rcpt_10", "oldest 10 dropped");
  assert.equal(list.at(-1)!.id, `rcpt_${PENDING_DELETES_CAP + 9}`);
});

test("pruneConsumed removes exactly what was consumed; failures and new entries stay", () => {
  const a = del({ id: "a" });
  const b = del({ id: "b" }); // will "fail" — not consumed
  const stored = [a, b];
  // A delete recorded while the push ran:
  const c = del({ id: "c", at: 9000 });
  const current = [...stored, c];
  const next = pruneConsumed(current, [a]);
  assert.deepEqual(next, [b, c]);
  // Same id re-recorded with a newer `at` is a different key — survives a
  // prune of the older consumed entry.
  const re = del({ at: 5000 });
  assert.notEqual(pendingDeleteKey(re), pendingDeleteKey(del()));
  assert.deepEqual(pruneConsumed([re], [del()]), [re]);
});

// ---- per-account blob scoping ----------------------------------------------

test("uploadedBlobsKey is scoped per user (never the old shared key)", () => {
  assert.equal(uploadedBlobsKey("user-a"), "sync.uploadedBlobs.user-a");
  assert.notEqual(uploadedBlobsKey("user-a"), uploadedBlobsKey("user-b"));
  assert.notEqual(uploadedBlobsKey(""), "sync.uploadedBlobs");
});

// ---- second-device batch adoption ------------------------------------------

test("adopts the most recently updated non-empty batch on an empty active", () => {
  const picked = chooseAdoptionBatch("fresh", [
    { id: "fresh", updatedAt: 900, receiptCount: 0 },
    { id: "older", updatedAt: 100, receiptCount: 4 },
    { id: "newer", updatedAt: 200, receiptCount: 2 },
    { id: "empty", updatedAt: 999, receiptCount: 0 },
  ]);
  assert.equal(picked, "newer");
});

test("never steals an active batch that already has receipts", () => {
  const picked = chooseAdoptionBatch("mine", [
    { id: "mine", updatedAt: 100, receiptCount: 1 },
    { id: "cloud", updatedAt: 999, receiptCount: 50 },
  ]);
  assert.equal(picked, null);
});

test("returns null when nothing worth adopting exists", () => {
  assert.equal(chooseAdoptionBatch("fresh", []), null);
  assert.equal(
    chooseAdoptionBatch("fresh", [{ id: "fresh", updatedAt: 1, receiptCount: 0 }]),
    null,
  );
  assert.equal(
    chooseAdoptionBatch("fresh", [
      { id: "fresh", updatedAt: 1, receiptCount: 0 },
      { id: "other", updatedAt: 2, receiptCount: 0 },
    ]),
    null,
    "all empty",
  );
});

test("an active batch missing from the candidates counts as empty", () => {
  const picked = chooseAdoptionBatch("unknown", [
    { id: "cloud", updatedAt: 10, receiptCount: 3 },
  ]);
  assert.equal(picked, "cloud");
});

// ── Audit round (2026-09) ─────────────────────────────────────────────────────
import { fetchAll, tombstoneLanded, PULL_PAGE } from "../src/store/syncMerge.ts";

test("fetchAll pages until a short page and concatenates in order", async () => {
  const calls: [number, number][] = [];
  const rows = Array.from({ length: 2350 }, (_, i) => ({ id: i }));
  const out = await fetchAll(
    async (from, to) => {
      calls.push([from, to]);
      return { data: rows.slice(from, to + 1), error: null };
    },
    "receipts",
  );
  assert.equal(out.length, 2350);
  assert.equal(out[2349]!.id, 2349);
  assert.deepEqual(calls, [
    [0, PULL_PAGE - 1],
    [PULL_PAGE, 2 * PULL_PAGE - 1],
    [2 * PULL_PAGE, 3 * PULL_PAGE - 1],
  ]);
  // An exact multiple still needs one more (empty) page to know it is done.
  const exact = await fetchAll(async (from, to) => ({ data: rows.slice(from, Math.min(to + 1, 2000)), error: null }), "x");
  assert.equal(exact.length, 2000);
  await assert.rejects(
    fetchAll(async () => ({ data: null, error: { message: "boom" } }), "batches"),
    /batches pull: boom/,
  );
});

test("tombstoneLanded: only a row returned with deleted_at set takes its blobs", () => {
  assert.equal(tombstoneLanded([{ deleted_at: "2026-09-02T00:00:00Z" }]), true);
  assert.equal(tombstoneLanded([{ deleted_at: null }]), false); // lww_guard kept it
  assert.equal(tombstoneLanded([]), false); // never pushed
  assert.equal(tombstoneLanded(null), false);
});
