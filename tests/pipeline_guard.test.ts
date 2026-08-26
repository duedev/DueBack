import { test } from "node:test";
import assert from "node:assert/strict";
import { completionWriteMode } from "../src/pipeline/pipeline.ts";
import type { Receipt } from "../src/types.ts";

// The pipeline's completion write vs a human working the review modal on the
// same receipt: the machine must never overwrite an edit, an approval, or a
// deletion that happened while OCR ran (pipeline.ts, completionWriteMode).

type Latest = Pick<Receipt, "approved" | "status" | "updatedAt">;
const CLAIMED_AT = 1_000;
const claimed = (over: Partial<Latest> = {}): Latest => ({
  approved: false,
  status: "processing",
  updatedAt: CLAIMED_AT,
  ...over,
});

test("untouched receipt gets the full extraction write", () => {
  assert.equal(completionWriteMode(claimed(), CLAIMED_AT), "full");
});

test("deleted mid-flight → skip (no write, blobs cleaned up)", () => {
  assert.equal(completionWriteMode(undefined, CLAIMED_AT), "skip");
});

test("approved mid-flight → technical fields only", () => {
  assert.equal(
    completionWriteMode(claimed({ approved: true, status: "done", updatedAt: 2_000 }), CLAIMED_AT),
    "technical",
  );
});

test("status done (even unapproved) → technical fields only", () => {
  assert.equal(completionWriteMode(claimed({ status: "done" }), CLAIMED_AT), "technical");
});

test("any write after the claim (edit saved, sync mirror) → technical only", () => {
  assert.equal(
    completionWriteMode(claimed({ updatedAt: CLAIMED_AT + 1 }), CLAIMED_AT),
    "technical",
  );
});

test("an older stamp than the claim is not a human touch", () => {
  // Clock skew safety: only strictly-newer writes count.
  assert.equal(
    completionWriteMode(claimed({ updatedAt: CLAIMED_AT - 1 }), CLAIMED_AT),
    "full",
  );
});
