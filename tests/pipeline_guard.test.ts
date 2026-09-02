import { test } from "node:test";
import assert from "node:assert/strict";
import { completionWriteMode, touchedBeforeClaim } from "../src/pipeline/pipeline.ts";
import type { Receipt, Field, Category } from "../src/types.ts";

// The pipeline's completion write vs a human working the review modal on the
// same receipt: the machine must never overwrite an edit, an approval, or a
// deletion that happened while OCR ran (pipeline.ts, completionWriteMode) —
// or BEFORE it ran, while the receipt sat queued (touchedBeforeClaim).

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

// ---- Touches from BEFORE the claim -----------------------------------------
// A human can open a "Queued" card and approve or save it before its job is
// claimed. The claim's updatedAt baseline can't see those writes (they are
// older than it), so the pre-claim read is inspected separately.

type Pre = Parameters<typeof touchedBeforeClaim>[0];
function field<T>(value: T, edited?: boolean): Field<T> {
  return edited === undefined ? { value, confidence: 0.5 } : { value, confidence: 1, edited };
}
const pristine = (over: Partial<Pre> = {}): Pre => ({
  approved: false,
  status: "queued",
  vendor: field("Shop"),
  date: field("2026-03-14"),
  amount: field(12),
  category: field<Category>("Meals"),
  ...over,
});

test("touchedBeforeClaim: pristine queued receipt → false", () => {
  assert.equal(touchedBeforeClaim(pristine()), false);
  // An `edited: false` provenance stamp (the logo fusion writes one) is not a touch.
  assert.equal(touchedBeforeClaim(pristine({ vendor: field("Shop", false) })), false);
});

test("touchedBeforeClaim: approved → true", () => {
  assert.equal(touchedBeforeClaim(pristine({ approved: true })), true);
});

test("touchedBeforeClaim: status done (even unapproved) → true", () => {
  assert.equal(touchedBeforeClaim(pristine({ status: "done" })), true);
});

test("touchedBeforeClaim: any single edited field → true", () => {
  assert.equal(touchedBeforeClaim(pristine({ vendor: field("Shop", true) })), true);
  assert.equal(touchedBeforeClaim(pristine({ date: field("2026-03-14", true) })), true);
  assert.equal(touchedBeforeClaim(pristine({ amount: field(12, true) })), true);
  assert.equal(
    touchedBeforeClaim(pristine({ category: field<Category>("Meals", true) })),
    true,
  );
});

test("approved before the claim → technical (status was never re-stamped, so latest is still done)", () => {
  // The claim leaves a "done" receipt's status alone; completion sees
  // latest.status === "done" AND preTouched — both say technical.
  const latest = claimed({ approved: true, status: "done" });
  const pre = pristine({ approved: true, status: "done" });
  assert.equal(completionWriteMode(latest, CLAIMED_AT, touchedBeforeClaim(pre)), "technical");
});

test("saved-but-still-queued before the claim → technical, not a full overwrite", () => {
  // The human's save stamped `edited: true` on the fields but left the status
  // queued, so the claim re-stamped "processing" and updatedAt === claimedAt:
  // without the pre-claim flag this would be "full" and clobber the edits.
  const pre = pristine({ vendor: field("Corrected Vendor", true) });
  assert.equal(completionWriteMode(claimed(), CLAIMED_AT), "full"); // the old blind spot
  assert.equal(completionWriteMode(claimed(), CLAIMED_AT, touchedBeforeClaim(pre)), "technical");
});

test("untouched before the claim → preTouched=false keeps the full write", () => {
  assert.equal(completionWriteMode(claimed(), CLAIMED_AT, touchedBeforeClaim(pristine())), "full");
  assert.equal(completionWriteMode(claimed(), CLAIMED_AT, false), "full");
});

// ── Audit round (2026-09) ─────────────────────────────────────────────────────
import { friendlyError } from "../src/pipeline/pipeline.ts";

test("friendlyError names HEIC, PDF and decode failures instead of engine internals", () => {
  const decode = new Error("The source image could not be decoded.");
  assert.match(friendlyError(decode, { mimeType: "image/heic", fileName: "IMG_1.heic" }), /HEIC/);
  assert.match(friendlyError(decode, { mimeType: "image/jpeg", fileName: "x.jpg", originalFileName: "IMG_1.HEIC" }), /HEIC/);
  assert.match(friendlyError(new Error("bad xref"), { mimeType: "application/pdf", fileName: "scan.pdf" }), /PDF/);
  assert.match(friendlyError(decode, { mimeType: "image/jpeg", fileName: "x.jpg" }), /couldn't be decoded/);
  // A non-decode failure on a HEIC keeps its own message.
  assert.equal(friendlyError(new Error("OCR worker died"), { mimeType: "image/heic", fileName: "a.heic" }), "OCR worker died");
  assert.equal(friendlyError("boom"), "boom");
});
