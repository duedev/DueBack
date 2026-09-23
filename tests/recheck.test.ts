import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planBatchRecheck,
  planBoxFix,
  recheckPatch,
  recheckSummary,
  runBatchRecheck,
  type RecheckIO,
  type RecheckPlan,
} from "../src/pipeline/recheck.ts";
import { duplicatePairs } from "../src/pipeline/dedup.ts";
import { HIGHLIGHT_COLORS } from "../src/pipeline/annotate.ts";
import type { BBox, OcrLine, Receipt } from "../src/types.ts";
import {
  appFeb11,
  appMar02,
  printInvoice,
  printSlip,
  scanFeb11,
  scanMar02,
  scanMar02Other,
  siteApr09,
  siteAug07,
  type OwnerReceipt,
} from "./fixtures/ownerDuplicates.ts";
import { chevronScanMar02, mobilJan29Approved, pipSlip, type LegacyAiRow } from "./fixtures/ownerLegacyAi.ts";

// "Re-check this batch" heals receipts stored before two read-time fixes,
// from stored data only: legacy AI reads get the outlines a fresh read's
// anchoring would give them (values untouched), and pairs the old dedup
// missed get their duplicate flag. The owner's batch is the fixture: its
// missed pairs are the $83.44 Chevron fill-up (app e-receipt + paper scan)
// and the $28.50 PIP PRINTING slip + PrintMyStuff invoice.

const BATCH = "batch_owner";

function stored(p: Partial<Receipt> & Pick<Receipt, "id" | "createdAt">): Receipt {
  return {
    batchId: BATCH,
    fileKey: `orig_${p.id}`,
    cleanedKey: `clean_${p.id}`,
    fileName: `${p.id}.jpg`,
    mimeType: "image/jpeg",
    status: "done",
    imageHash: `hash_${p.id}`,
    vendor: { value: "", confidence: 0 },
    date: { value: "", confidence: 0 },
    amount: { value: 0, confidence: 0 },
    tax: { value: 0, confidence: 0 },
    currency: "USD",
    category: { value: "Other", confidence: 0.5 },
    confidence: 0.9,
    flags: [],
    methodUsed: "rules",
    cost: 0,
    approved: false,
    reviewRequired: false,
    updatedAt: 10_000 + p.createdAt,
    ...p,
  };
}

/** A text-only owner row (ownerDuplicates) as a stored rules read. Its line
 *  boxes are synthetic bands — dedup reads only the text. (The scan copies
 *  among these were AI reads too; here they stand in as rules rows, and the
 *  legacy AI rows below carry their real geometry.) */
function rulesRow(o: OwnerReceipt, createdAt: number, extra: Partial<Receipt> = {}): Receipt {
  const n = o.ocrLines.length;
  return stored({
    id: o.id,
    createdAt,
    fileName: o.fileName,
    originalFileName: o.originalFileName,
    vendor: { value: o.vendor.value, confidence: 0.9, bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.02 } },
    date: { value: o.date.value, confidence: 0.8, bbox: { x: 0.1, y: 0.2, w: 0.4, h: 0.02 } },
    amount: { value: o.amount.value, confidence: 0.8, bbox: { x: 0.1, y: 0.6, w: 0.6, h: 0.02 } },
    annotatedKey: `annotated_${o.id}`,
    flags: o.flags.map((f) => ({ ...f })),
    ocrLines: o.ocrLines.map((l, i) => ({
      text: l.text,
      confidence: 90,
      bbox: { x: 0, y: i / n, w: 1, h: 1 / n },
      words: [],
    })),
    ocrText: o.ocrLines.map((l) => l.text).join("\n"),
    ...extra,
  });
}

/** A legacy AI read with its real stored geometry (ownerLegacyAi). */
function legacyRow(o: LegacyAiRow, extra: Partial<Receipt> = {}): Receipt {
  return stored({
    ...structuredClone(o),
    methodUsed: "paid",
    ...extra,
  });
}

/** The approved MOBIL MART: its review save baked the annotated copy that
 *  shows its boxes (the bundle's extraction.json doesn't carry blob keys). */
const mobil = (extra: Partial<Receipt> = {}): Receipt =>
  legacyRow(mobilJan29Approved, { annotatedKey: `annotated_${mobilJan29Approved.id}`, ...extra });

/** The owner-like batch, in upload order (createdAt = position in the upload). */
function ownerBatch(): Receipt[] {
  return [
    rulesRow(siteAug07, 8),
    rulesRow(appFeb11, 26),
    rulesRow(appMar02, 28),
    rulesRow(siteApr09, 32),
    // The invoice was an AI read whose values the OCR can't place (see the
    // owner-data run); it stands in as a rules row.
    rulesRow(printInvoice, 42),
    legacyRow(pipSlip),
    legacyRow(chevronScanMar02),
    mobil(),
    rulesRow(scanFeb11, 57),
    rulesRow(scanMar02Other, 59),
  ];
}

/** The OCR line a box sits on (vertical centre inside, some overlap). */
function lineAt(lines: OcrLine[], box: BBox | undefined): string | undefined {
  if (!box) return undefined;
  const cy = box.y + box.h / 2;
  return lines.find(
    (l) =>
      cy >= l.bbox.y &&
      cy <= l.bbox.y + l.bbox.h &&
      Math.min(l.bbox.x + l.bbox.w, box.x + box.w) > Math.max(l.bbox.x, box.x),
  )?.text;
}

/** Apply a plan the way the executor does, with a successful bake. */
function applied(rows: Receipt[], plan: RecheckPlan): Receipt[] {
  return rows.map((r) => {
    const box = plan.boxes.find((f) => f.id === r.id);
    const duplicate = plan.duplicates.find((f) => f.id === r.id);
    if (!box && !duplicate) return r;
    const patch = recheckPatch(r, { box, duplicate }, box ? `annotated_new_${r.id}` : undefined);
    return { ...r, ...patch, updatedAt: r.updatedAt + 1 };
  });
}

test("fixture sanity: the legacy rows' real lines are the ownerDuplicates rows' text", () => {
  assert.deepEqual(pipSlip.ocrLines.map((l) => l.text), printSlip.ocrLines.map((l) => l.text));
  assert.deepEqual(chevronScanMar02.ocrLines.map((l) => l.text), scanMar02.ocrLines.map((l) => l.text));
  assert.equal(pipSlip.id, printSlip.id);
  assert.equal(chevronScanMar02.id, scanMar02.id);
  // Legacy: the model's answer sits where the OCR read should be.
  assert.match(chevronScanMar02.ocrText, /^\{"vendor": "Chevron Station Inc\."/);
});

// ── Duplicates ───────────────────────────────────────────────────────────────

test("the owner's two missed pairs each get ONE flag, on the copy read second, naming the first", () => {
  const plan = planBatchRecheck(ownerBatch());
  assert.equal(plan.duplicates.length, 2, plan.duplicates.map((d) => d.flag.message).join("\n"));
  const byId = new Map(plan.duplicates.map((d) => [d.id, d]));

  // $83.44 Chevron: "Chevron" (app e-receipt) vs "Chevron Station Inc." (scan).
  const chevron = byId.get(scanMar02.id);
  assert.ok(chevron, "the paper scan is flagged");
  assert.equal(chevron.flag.code, "duplicate");
  assert.equal(chevron.flag.severity, "warn");
  assert.equal(chevron.flag.ref, appMar02.id);
  assert.match(chevron.flag.message, /Same vendor, date and amount as "chevron-receipts.*page 29 of 37\)"/);
  assert.equal(chevron.toReview, true, "a flagged 'done' receipt goes to review, as a fresh read's would");

  // $28.50 PIP PRINTING slip + PrintMyStuff invoice: one approval code.
  const pip = byId.get(printSlip.id);
  assert.ok(pip, "the slip (page 7) is flagged");
  assert.equal(pip.flag.ref, printInvoice.id);
  assert.match(pip.flag.message, /card approval code \(05439D\)/);

  for (const id of [appFeb11.id, scanFeb11.id, appMar02.id, printInvoice.id, scanMar02Other.id, siteAug07.id, siteApr09.id]) {
    assert.ok(!byId.has(id), `${id} is not flagged`);
  }
  // Each fix is a compare-and-swap on the row as planned.
  const rows = ownerBatch();
  assert.equal(chevron.expectUpdatedAt, rows.find((r) => r.id === scanMar02.id)!.updatedAt);
});

test("a couple the human kept apart (Keep both) is never re-flagged — from either side", () => {
  // Review's Keep both clears the warnings and records the verdict on BOTH
  // rows (Receipt.notDuplicateOf); either record alone is enough.
  for (const keptOn of ["scan", "app", "both"] as const) {
    const rows = ownerBatch().map((r) =>
      (r.id === scanMar02.id && keptOn !== "app") ? { ...r, notDuplicateOf: [appMar02.id] }
      : (r.id === appMar02.id && keptOn !== "scan") ? { ...r, notDuplicateOf: [scanMar02.id] }
      : r,
    );
    const plan = planBatchRecheck(rows);
    assert.ok(!plan.duplicates.some((d) => d.id === scanMar02.id), `kept apart on ${keptOn}: the $83.44 pair stays cleared`);
    // The other missed pair is unaffected by that verdict.
    assert.ok(plan.duplicates.some((d) => d.id === pipSlip.id), "the PIP pair is still flagged");
  }
});

test("the already-flagged 02-11 pair is left alone (its flag predates ref and resolves by message)", () => {
  const rows = ownerBatch();
  const app = rows.find((r) => r.id === appFeb11.id)!;
  assert.equal(duplicatePairs(app, rows)[0]?.peer.id, scanFeb11.id, "the pair is known from the app side");
  const plan = planBatchRecheck(rows);
  assert.ok(!plan.duplicates.some((d) => d.id === appFeb11.id || d.id === scanFeb11.id));
});

test("the 03-02 $94.14 fill-up is not the $83.44 one: same station, same day, different purchase", () => {
  const plan = planBatchRecheck(ownerBatch());
  assert.ok(!plan.duplicates.some((d) => d.id === scanMar02Other.id || d.flag.ref === scanMar02Other.id));
});

test("an approved receipt is never flagged — nor is its twin, when the approved copy is the later one", () => {
  const rows = ownerBatch().map((r) => (r.id === scanMar02.id ? { ...r, approved: true } : r));
  const plan = planBatchRecheck(rows);
  assert.ok(!plan.duplicates.some((d) => d.id === scanMar02.id), "the approved scan holds no new flag");
  // Keep both → Approve leaves no trace but the approval, so the earlier copy
  // is not flagged in its place.
  assert.ok(!plan.duplicates.some((d) => d.id === appMar02.id));
  // An approved EARLIER copy doesn't shield the later one.
  const earlierApproved = ownerBatch().map((r) => (r.id === appMar02.id ? { ...r, approved: true } : r));
  const d = planBatchRecheck(earlierApproved).duplicates.find((x) => x.id === scanMar02.id);
  assert.equal(d?.flag.ref, appMar02.id);
});

test("a pair already known from either side is never flagged twice; a triple links its third copy", () => {
  const t = (id: string, createdAt: number, extra: Partial<Receipt> = {}): Receipt =>
    stored({
      id,
      createdAt,
      vendor: { value: "Shell", confidence: 0.9 },
      date: { value: "2026-06-12", confidence: 0.9 },
      amount: { value: 39.2, confidence: 0.9 },
      ...extra,
    });
  const refTo = (ref: string) => [{ code: "duplicate" as const, severity: "warn" as const, message: "Same…", ref }];

  // A < B < C, C already flagged → B: B was never linked to A.
  const triple = [t("A", 1), t("B", 2), t("C", 3, { flags: refTo("B"), status: "needs_review" })];
  const plan = planBatchRecheck(triple);
  assert.deepEqual(
    plan.duplicates.map((d) => [d.id, d.flag.ref]),
    [["B", "A"]],
  );

  // The EARLIER copy holds the flag (it was read later): the later one is
  // already paired and gets no mirror-image flag.
  const mirrored = [t("E", 1, { flags: refTo("X"), status: "needs_review" }), t("X", 2)];
  assert.deepEqual(planBatchRecheck(mirrored).duplicates, []);

  // A byte-identical re-upload is a hash twin.
  const hashed = [t("H1", 1, { imageHash: "same" }), t("H2", 2, { imageHash: "same", vendor: { value: "", confidence: 0 } })];
  const h = planBatchRecheck(hashed).duplicates;
  assert.equal(h.length, 1);
  assert.equal(h[0]!.flag.ref, "H1");
  assert.match(h[0]!.flag.message, /Looks identical/);
});

test("unread and failed rows are never flagged, nor paired against", () => {
  const row = (id: string, createdAt: number, status: Receipt["status"]): Receipt =>
    stored({
      id,
      createdAt,
      status,
      vendor: { value: "Shell", confidence: 0.9 },
      date: { value: "2026-06-12", confidence: 0.9 },
      amount: { value: 39.2, confidence: 0.9 },
    });
  for (const s of ["queued", "processing", "failed"] as const) {
    assert.deepEqual(planBatchRecheck([row("a", 1, "done"), row("b", 2, s)]).duplicates, [], `${s} holder`);
    assert.deepEqual(planBatchRecheck([row("a", 1, s), row("b", 2, "done")]).duplicates, [], `${s} twin`);
  }
  // A needs_review copy is flagged but stays where it is.
  const d = planBatchRecheck([row("a", 1, "done"), row("b", 2, "needs_review")]).duplicates;
  assert.equal(d[0]?.toReview, false);
});

// ── Outlines ─────────────────────────────────────────────────────────────────

test("a legacy AI read gains boxes on the lines that print its values", () => {
  const r = legacyRow(chevronScanMar02);
  const fix = planBoxFix(r);
  assert.ok(fix);
  assert.equal(lineAt(r.ocrLines!, fix.add.vendor), "chevron Station Inc.");
  assert.ok(Math.abs(fix.add.vendor!.w - 0.6701) < 1e-9, "the whole name is boxed, not the 'chevron' slice");
  assert.equal(lineAt(r.ocrLines!, fix.add.date), "03/02/2026 694565975");
  assert.match(lineAt(r.ocrLines!, fix.add.amount) ?? "", /83\.44/);
  // The re-bake shows every outline, in the pipeline's colours.
  assert.deepEqual(
    fix.marks.map((m) => m.color),
    [HIGHLIGHT_COLORS.vendor, HIGHLIGHT_COLORS.date, HIGHLIGHT_COLORS.amount],
  );
  assert.equal(fix.cleanedKey, r.cleanedKey);
  assert.equal(fix.oldAnnotatedKey, undefined, "a legacy read has no annotated copy to replace");
  assert.equal(fix.expectUpdatedAt, r.updatedAt);
});

test("a value the OCR can't place gets no box — never a guess", () => {
  // The slip prints its vendor; its date ("12/1225") and amount (a blank
  // AMOUNT line) are not printed as the model read them.
  const fix = planBoxFix(legacyRow(pipSlip));
  assert.ok(fix);
  assert.deepEqual(Object.keys(fix.add), ["vendor"]);
  assert.equal(lineAt(pipSlip.ocrLines, fix.add.vendor), "PIP PRINTING RIVERSIDE");
  assert.equal(fix.marks.length, 1);
});

test("a human-owned field is never touched — edited values and hand-drawn boxes win", () => {
  // Approved MOBIL MART: vendor already boxed, the date typed AND drawn by
  // hand, the model's $85.25 printed nowhere → nothing to add.
  assert.equal(planBoxFix(mobil()), null);

  // An edited vendor with no box stays box-less; the other two are healed.
  const edited = legacyRow(chevronScanMar02, {
    vendor: { value: "Chevron Station Inc.", confidence: 1, edited: true },
  });
  const e = planBoxFix(edited);
  assert.ok(e);
  assert.deepEqual(Object.keys(e.add).sort(), ["amount", "date"]);

  // A hand-drawn amount box is never moved, and it is re-baked as drawn.
  const drawn: BBox = { x: 0.5, y: 0.9, w: 0.2, h: 0.03 };
  const manual = legacyRow(chevronScanMar02, {
    amount: { value: 83.44, confidence: 1, bbox: drawn, manualBox: true },
  });
  const m = planBoxFix(manual);
  assert.ok(m);
  assert.equal(m.add.amount, undefined);
  assert.deepEqual(m.marks.find((k) => k.color === HIGHLIGHT_COLORS.amount)?.bbox, drawn);

  // The patch re-checks the guard itself: a fix planned before a human edit
  // never lands on the edited field.
  const plain = legacyRow(chevronScanMar02);
  const fix = planBoxFix(plain)!;
  const patch = recheckPatch({ ...plain, vendor: { ...plain.vendor, edited: true } }, { box: fix }, "k");
  assert.equal(patch.vendor, undefined);
  assert.ok(patch.date?.bbox && patch.amount?.bbox);
});

test("an approved legacy read is left alone — the human signed it off as it stands", () => {
  assert.equal(planBoxFix(legacyRow(chevronScanMar02, { approved: true })), null);
  // The same row unapproved gains its outlines, values untouched.
  const r = legacyRow(chevronScanMar02);
  const fix = planBoxFix(r);
  assert.ok(fix, "outlines for the unapproved row");
  const patch = recheckPatch(r, { box: fix }, "annotated_new");
  assert.equal(patch.approved, undefined);
  assert.equal(patch.status, undefined);
  assert.equal(patch.vendor?.value, "Chevron Station Inc.");
});

test("only legacy AI reads with stored lines and a cleaned frame are box-fixed", () => {
  // A rules read is never touched, boxes or not.
  const rules = rulesRow(appMar02, 28, {
    vendor: { value: "Chevron", confidence: 0.9 },
    date: { value: "2026-03-02", confidence: 0.9 },
    amount: { value: 83.44, confidence: 0.9 },
  });
  assert.equal(planBoxFix(rules), null);
  // A read made WITH provenance was anchored at read time.
  const assisted = legacyRow(chevronScanMar02, {
    assist: {
      backend: "selfhosted",
      provider: "Self-hosted",
      model: "m",
      host: "private-network",
      keySource: "none",
      requestedStrategy: "oneshot",
      strategy: "oneshot",
      viaProxy: false,
      calls: 1,
      rawAnswer: "{}",
      rules: { vendor: "", date: "", amount: 0, tax: 0, category: "Fuel", confidence: 0 },
    },
  });
  assert.equal(planBoxFix(assisted), null);
  // No lines: nothing to anchor on. No cleaned frame: nothing to bake onto
  // (the boxes are normalized to it). Unsettled: the pipeline owns it.
  assert.equal(planBoxFix(legacyRow(chevronScanMar02, { ocrLines: [] })), null);
  assert.equal(planBoxFix(legacyRow(chevronScanMar02, { cleanedKey: undefined })), null);
  for (const status of ["queued", "processing", "failed"] as const) {
    assert.equal(planBoxFix(legacyRow(chevronScanMar02, { status })), null, status);
  }
  const plan = planBatchRecheck(ownerBatch());
  assert.deepEqual(plan.boxes.map((b) => b.id).sort(), [pipSlip.id, chevronScanMar02.id].sort());
});

test("boxes already there but no annotated copy: the fix is the bake alone", () => {
  const r = legacyRow(chevronScanMar02);
  const healed = { ...r, ...recheckPatch(r, { box: planBoxFix(r)! }, "k") };
  const { annotatedKey: _gone, ...unbaked } = healed;
  const fix = planBoxFix(unbaked as Receipt);
  assert.ok(fix);
  assert.deepEqual(fix.add, {});
  assert.equal(fix.marks.length, 3);
  assert.deepEqual(recheckPatch(unbaked as Receipt, { box: fix }, "k2"), { annotatedKey: "k2" });
});

// ── The patch and idempotency ────────────────────────────────────────────────

test("the patch only adds: a box per field, the flag in front, done → needs_review", () => {
  const rows = ownerBatch();
  const plan = planBatchRecheck(rows);
  const row = rows.find((r) => r.id === scanMar02.id)!;
  const patch = recheckPatch(
    row,
    { box: plan.boxes.find((f) => f.id === row.id), duplicate: plan.duplicates.find((f) => f.id === row.id) },
    "annotated_new",
  );
  assert.deepEqual(
    Object.keys(patch).sort(),
    ["amount", "annotatedKey", "date", "flags", "reviewRequired", "status", "vendor"],
  );
  for (const k of ["vendor", "date", "amount"] as const) {
    const { bbox, ...rest } = patch[k]!;
    assert.deepEqual(rest, row[k], `${k}: value and confidence as stored`);
    assert.ok(bbox);
  }
  assert.equal(patch.flags![0]!.code, "duplicate");
  assert.deepEqual(patch.flags!.slice(1), row.flags, "no flag removed");
  assert.equal(patch.status, "needs_review");
  assert.equal(patch.reviewRequired, true);
  // No box without its baked copy.
  const noBake = recheckPatch(row, { box: plan.boxes.find((f) => f.id === row.id) });
  assert.deepEqual(noBake, {});
});

test("re-planning after applying the plan is empty (idempotent), and nothing else moved", () => {
  const rows = ownerBatch();
  const before = structuredClone(rows);
  const plan = planBatchRecheck(rows);
  assert.deepEqual(rows, before, "planning never mutates the stored rows");
  const next = applied(rows, plan);
  assert.deepEqual(planBatchRecheck(next), { boxes: [], duplicates: [] });
  for (const before of rows) {
    const after = next.find((r) => r.id === before.id)!;
    assert.equal(after.ocrText, before.ocrText, "an AI read never overwrites ocrText — nor does a re-check");
    assert.equal(after.methodUsed, before.methodUsed);
    assert.equal(after.approved, before.approved);
    for (const k of ["vendor", "date", "amount", "tax", "category"] as const) {
      assert.equal(after[k].value, before[k].value);
    }
  }
});

// ── Applying a plan ──────────────────────────────────────────────────────────

/** In-memory storage with repo.updateReceipt's compare-and-swap. */
function fakeIO(rows: Receipt[], opts: { bake?: RecheckIO["bake"]; beforeWrite?: (id: string) => void } = {}) {
  let clock = 50_000;
  let n = 0;
  const receipts = new Map(rows.map((r) => [r.id, structuredClone(r)]));
  const blobs = new Map<string, Blob>();
  for (const r of rows) {
    if (r.cleanedKey) blobs.set(r.cleanedKey, new Blob([`clean ${r.id}`]));
    if (r.annotatedKey) blobs.set(r.annotatedKey, new Blob([`annotated ${r.id}`]));
  }
  const writes: { id: string; patch: Partial<Receipt> }[] = [];
  const io: RecheckIO = {
    listReceipts: async (batchId) => [...receipts.values()].filter((r) => r.batchId === batchId).map((r) => structuredClone(r)),
    getBlob: async (key) => blobs.get(key),
    putBlob: async (blob) => {
      const key = `blob_${++n}`;
      blobs.set(key, blob);
      return key;
    },
    deleteBlob: async (key) => void blobs.delete(key),
    updateReceipt: async (id, patch, expect) => {
      opts.beforeWrite?.(id);
      const cur = receipts.get(id);
      if (!cur) return undefined;
      if (cur.updatedAt !== expect.updatedAt) return null;
      const next = { ...cur, ...structuredClone(patch), updatedAt: ++clock };
      receipts.set(id, next);
      writes.push({ id, patch });
      return next;
    },
    bake: opts.bake ?? (async (_blob, marks) => new Blob([`baked ${marks.length}`])),
  };
  return { io, receipts, blobs, writes };
}

test("runBatchRecheck: one CAS write per receipt; the replaced annotated copy is deleted", async () => {
  // Give the Chevron scan a stale annotated copy to replace.
  const rows = ownerBatch().map((r) => (r.id === scanMar02.id ? { ...r, annotatedKey: "stale_annotated" } : r));
  const { io, receipts, blobs, writes } = fakeIO(rows);
  assert.ok(blobs.has("stale_annotated"));

  const result = await runBatchRecheck(BATCH, io);
  assert.deepEqual(result, { boxes: 2, duplicates: 2, skipped: 0, unfixable: 0 });
  assert.equal(writes.filter((w) => w.id === scanMar02.id).length, 1, "boxes + flag in ONE write");

  const chevron = receipts.get(scanMar02.id)!;
  assert.ok(chevron.vendor.bbox && chevron.date.bbox && chevron.amount.bbox);
  assert.ok(chevron.annotatedKey && chevron.annotatedKey !== "stale_annotated");
  assert.ok(blobs.has(chevron.annotatedKey), "the new copy is stored");
  assert.ok(!blobs.has("stale_annotated"), "the replaced copy is deleted (no blob GC)");
  assert.equal(chevron.flags[0]!.ref, appMar02.id);
  assert.equal(chevron.status, "needs_review");
  assert.equal(chevron.ocrText, chevronScanMar02.ocrText);

  // Run it again: nothing left to do.
  assert.deepEqual(await runBatchRecheck(BATCH, io), { boxes: 0, duplicates: 0, skipped: 0, unfixable: 0 });
});

test("runBatchRecheck: a write that lost the race lands nothing and leaves no orphan blob", async () => {
  // A review save lands between the plan and the write.
  const { io, receipts, blobs, writes } = fakeIO(ownerBatch(), {
    beforeWrite: (id) => {
      if (id !== scanMar02.id) return;
      const cur = receipts.get(id)!;
      receipts.set(id, { ...cur, vendor: { ...cur.vendor, value: "Chevron", edited: true }, updatedAt: cur.updatedAt + 7 });
    },
  });
  const blobsBefore = new Set(blobs.keys());
  const result = await runBatchRecheck(BATCH, io);
  assert.deepEqual(result, { boxes: 1, duplicates: 1, skipped: 2, unfixable: 0 });
  const chevron = receipts.get(scanMar02.id)!;
  assert.equal(chevron.vendor.value, "Chevron", "the human's save stands");
  assert.equal(chevron.flags.some((f) => f.code === "duplicate"), false);
  assert.equal(chevron.annotatedKey, undefined);
  assert.ok(!writes.some((w) => w.id === scanMar02.id));
  // Only the PIP slip's new copy was added; the lost bake was deleted.
  const added = [...blobs.keys()].filter((k) => !blobsBefore.has(k));
  assert.deepEqual(added, [receipts.get(pipSlip.id)!.annotatedKey]);
});

test("runBatchRecheck: a bake that fails drops the outlines, never the duplicate flag", async () => {
  const { io, receipts, blobs } = fakeIO(ownerBatch(), { bake: async () => null });
  const blobsBefore = blobs.size;
  const result = await runBatchRecheck(BATCH, io);
  assert.deepEqual(result, { boxes: 0, duplicates: 2, skipped: 0, unfixable: 2 });
  const chevron = receipts.get(scanMar02.id)!;
  assert.equal(chevron.vendor.bbox, undefined, "no boxes without their baked copy");
  assert.equal(chevron.flags[0]!.ref, appMar02.id);
  assert.equal(blobs.size, blobsBefore);

  // A missing cleaned image is the same: nothing to bake onto.
  const missing = fakeIO(ownerBatch());
  missing.blobs.delete(`clean_${scanMar02.id}`);
  const r2 = await runBatchRecheck(BATCH, missing.io);
  assert.deepEqual(r2, { boxes: 1, duplicates: 2, skipped: 0, unfixable: 1 });
});

test("runBatchRecheck touches only the batch it was given", async () => {
  const rows = ownerBatch().map((r) => ({ ...r, batchId: "other" }));
  const { io, writes } = fakeIO(rows);
  assert.deepEqual(await runBatchRecheck(BATCH, io), { boxes: 0, duplicates: 0, skipped: 0, unfixable: 0 });
  assert.equal(writes.length, 0);
});

test("the summary says what changed, in plain words", () => {
  const R = (boxes: number, duplicates: number, skipped = 0, unfixable = 0) => ({ boxes, duplicates, skipped, unfixable });
  assert.equal(recheckSummary(R(0, 0)), "Nothing to fix — this batch is up to date.");
  assert.equal(recheckSummary(R(2, 1)), "Added outlines to 2 older AI reads and flagged 1 possible duplicate.");
  assert.equal(recheckSummary(R(1, 0)), "Added outlines to 1 older AI read.");
  assert.equal(recheckSummary(R(0, 3)), "Flagged 3 possible duplicates.");
  // A lost race can land next time; a missing image can't — only the first says so.
  assert.equal(recheckSummary(R(0, 1, 2)), "Flagged 1 possible duplicate. 2 receipts changed meanwhile — re-check again to include them.");
  assert.equal(recheckSummary(R(0, 0, 1)), "Nothing changed. 1 receipt changed meanwhile — re-check again to include it.");
  assert.equal(recheckSummary(R(0, 0, 0, 1)), "Nothing changed. 1 older AI read has no stored image to outline.");
  assert.equal(
    recheckSummary(R(3, 0, 0, 2)),
    "Added outlines to 3 older AI reads. 2 older AI reads have no stored image to outline.",
  );
  assert.doesNotMatch(recheckSummary(R(0, 0, 0, 4)), /again/i);
});
