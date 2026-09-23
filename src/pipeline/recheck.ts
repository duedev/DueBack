import type { BBox, Field, Flag, Receipt } from "../types.ts";
import { parseReceipt, type Extraction } from "./extract.ts";
import { duplicateFlag, keptApart, resolveDuplicateFlag } from "./dedup.ts";
import { anchorAssistBoxes, isLegacyAiRead, reusableOcr } from "./vision/provenance.ts";
import { HIGHLIGHT_COLORS, type HighlightMark } from "./annotate.ts";

// "Re-check this batch": two read-time fixes, applied to receipts stored
// before them — from STORED data only (no OCR call, no AI call).
//  1. Outlines for legacy AI reads (`isLegacyAiRead`): an AI read stored
//     before vision/provenance.ts anchored answers on the OCR lines has no
//     boxes and no annotated copy. The rules draft is rebuilt from the stored
//     `ocrLines` and the stored values are anchored with the same
//     `anchorAssistBoxes` a fresh read uses — values never change, only
//     boxes are added.
//  2. Duplicate pairs the old dedup missed (brand-equivalent vendors, a
//     shared approval/invoice code): `dedup.duplicateFlag` runs against the
//     batch as the pipeline would have, and a missing `duplicate` flag (with
//     `ref`) is added.
// Human edits win: an `edited` or hand-drawn (`manualBox`) field is never
// touched, an approved receipt never gains a flag, and nothing is ever
// removed. Planning is pure (Node-tested); `runBatchRecheck` applies a plan
// through injected storage, one compare-and-swap write per receipt.

export type BoxedField = "vendor" | "date" | "amount";
const BOXED: readonly BoxedField[] = ["vendor", "date", "amount"];

/** Outlines for one legacy AI read. */
export interface BoxFix {
  id: string;
  /** The row's `updatedAt` when planned — the write is a compare-and-swap. */
  expectUpdatedAt: number;
  /** The boxes this fix adds (fields that had none; never an edited or
   *  hand-drawn one). Empty when the row already has its boxes but no
   *  annotated copy — the fix is then the bake alone. */
  add: Partial<Record<BoxedField, BBox>>;
  /** Every highlight after the fix, pre-existing boxes included, so the
   *  re-baked copy shows all of them (ReviewModal's bake does the same). */
  marks: HighlightMark[];
  /** The frame the boxes (and the stored OCR lines) are normalized to. */
  cleanedKey: string;
  /** The annotated copy the bake replaces — deleted once the write lands
   *  (there is no blob GC). */
  oldAnnotatedKey?: string;
}

/** A duplicate flag the read-time dedup would add today. */
export interface DupFix {
  id: string;
  expectUpdatedAt: number;
  /** `duplicate`, naming its twin by id (`ref`). */
  flag: Flag;
  /** A "done" receipt moves to needs_review, as a fresh read's duplicate
   *  does — a flagged "done" card shows no warning banner. */
  toReview: boolean;
}

export interface RecheckPlan {
  boxes: BoxFix[];
  duplicates: DupFix[];
}

/** Same rule as provenance.ts `usableBox` (not exported there): finite,
 *  positive width and height. */
function usableBox(b: BBox | undefined): b is BBox {
  return (
    !!b &&
    [b.x, b.y, b.w, b.h].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    b.w > 0 &&
    b.h > 0
  );
}

/** A field a human owns: its value was edited or its box was drawn. */
const humanOwned = (f: Field<unknown> | undefined): boolean => f?.edited === true || f?.manualBox === true;

/** A finished read — the only rows a re-check writes to or pairs against.
 *  Queued/processing rows are (being) read and the pipeline will write them;
 *  a failed row has no read to pair on. */
const settled = (r: Pick<Receipt, "status">): boolean => r.status === "done" || r.status === "needs_review";

function stored(r: Receipt): Extraction {
  return {
    vendor: r.vendor,
    date: r.date,
    amount: r.amount,
    tax: r.tax,
    currency: r.currency,
    category: r.category,
    confidence: r.confidence,
    flags: r.flags,
  };
}

/** The outlines a legacy AI read would have been given at read time, or
 *  null when there is nothing to do. An APPROVED receipt is left alone like
 *  everywhere else in the re-check: the human signed it off as it stands,
 *  and a new annotated copy would still change what that receipt exports
 *  (and bump its updatedAt into a sync push). */
export function planBoxFix(r: Receipt): BoxFix | null {
  if (r.approved || !isLegacyAiRead(r) || !settled(r) || !r.cleanedKey) return null;
  // The same OCR input the image-hash cache lends an AI row: text rebuilt
  // from the lines (ocrText is the MODEL's answer on a legacy row), at the
  // lines' mean confidence.
  const ocr = reusableOcr(r);
  if (!ocr || ocr.lines.length === 0) return null;
  const draft = parseReceipt({ ...ocr, words: [] });
  const anchored = anchorAssistBoxes(stored(r), draft, ocr.lines);

  const add: Partial<Record<BoxedField, BBox>> = {};
  for (const k of BOXED) {
    const f = r[k] as Field<unknown>;
    if (humanOwned(f) || usableBox(f.bbox)) continue;
    const box = anchored[k].bbox;
    if (usableBox(box)) add[k] = { x: box.x, y: box.y, w: box.w, h: box.h };
  }
  const after = (k: BoxedField): BBox | undefined => add[k] ?? (usableBox(r[k].bbox) ? r[k].bbox : undefined);
  const marks: HighlightMark[] = BOXED.flatMap((k) => {
    const b = after(k);
    return b ? [{ bbox: { x: b.x, y: b.y, w: b.w, h: b.h }, color: HIGHLIGHT_COLORS[k] }] : [];
  });
  const gains = Object.keys(add).length > 0;
  // Boxes with no annotated copy (a bake that failed): bake alone.
  const bakeOnly = !gains && marks.length > 0 && !r.annotatedKey;
  if (!gains && !bakeOnly) return null;
  return {
    id: r.id,
    expectUpdatedAt: r.updatedAt,
    add,
    marks,
    cleanedKey: r.cleanedKey,
    ...(r.annotatedKey ? { oldAnnotatedKey: r.annotatedKey } : {}),
  };
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Plan the re-check of one batch's STORED rows. Pure.
 *
 * Duplicates mirror the pipeline, where the copy read SECOND holds the flag:
 * rows are walked in `createdAt` order (upload order; id breaks ties) and
 * each is checked against the settled rows created before it — the ones
 * that were there when it was read. A row is never given a flag when it is
 * approved (the human decided: that includes Keep both → Approve, which
 * leaves no other trace), unsettled, or already holds a `duplicate` flag
 * (one warning per receipt, as a read gives). A pair already known from
 * EITHER side (`resolveDuplicateFlag`, flags stored before `ref` included)
 * is never flagged again: the known twin is left out of the candidates, so
 * a triple still links its third copy.
 */
export function planBatchRecheck(receipts: readonly Receipt[]): RecheckPlan {
  const rows = [...receipts].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const boxes: BoxFix[] = [];
  for (const r of rows) {
    try {
      const fix = planBoxFix(r);
      if (fix) boxes.push(fix);
    } catch (err) {
      // One unreadable row must not sink the whole re-check.
      console.warn("[recheck] couldn't plan outlines for", r.id, err);
    }
  }

  const known = new Set<string>();
  for (const r of rows) {
    for (const f of r.flags) {
      if (f.code !== "duplicate") continue;
      const peer = resolveDuplicateFlag(r, f, rows);
      if (peer) known.add(pairKey(r.id, peer.id));
    }
  }

  const duplicates: DupFix[] = [];
  const earlier: Receipt[] = [];
  for (const x of rows) {
    const holds = x.flags.some((f) => f.code === "duplicate");
    if (settled(x) && !x.approved && !holds) {
      // Kept-apart couples ("Keep both") are out too: clearing a warning
      // must not be undone by the next re-check.
      const candidates = earlier.filter((s) => !known.has(pairKey(x.id, s.id)) && !keptApart(x, s));
      const hashTwin = x.imageHash ? candidates.find((s) => s.imageHash === x.imageHash) : undefined;
      const flag = duplicateFlag(
        {
          id: x.id,
          vendor: x.vendor.value,
          date: x.date.value,
          amount: x.amount.value,
          lines: x.ocrLines,
          notDuplicateOf: x.notDuplicateOf,
        },
        hashTwin,
        candidates,
      );
      if (flag?.ref) {
        known.add(pairKey(x.id, flag.ref));
        duplicates.push({ id: x.id, expectUpdatedAt: x.updatedAt, flag, toReview: x.status === "done" });
      }
    }
    if (settled(x)) earlier.push(x);
  }

  return { boxes, duplicates };
}

/**
 * The patch one receipt's fixes write, from the row as STORED at plan time
 * (the write's compare-and-swap guarantees it is unchanged). Boxes land only
 * together with their baked copy (`annotatedKey`); each is added to the
 * stored field with its value, confidence and flags untouched. A duplicate
 * flag is prepended (the card's banner shows the first flag) — no flag is
 * ever removed. ocrText, values, methodUsed and approval are never in the
 * patch. Re-checks the human-owned guards itself. Pure.
 */
export function recheckPatch(
  row: Receipt,
  fix: { box?: BoxFix; duplicate?: DupFix },
  annotatedKey?: string,
): Partial<Receipt> {
  const patch: Partial<Receipt> = {};
  if (fix.box && annotatedKey) {
    for (const k of BOXED) {
      const box = fix.box.add[k];
      const f = row[k] as Field<unknown>;
      if (!box || humanOwned(f) || usableBox(f.bbox)) continue;
      (patch as Record<BoxedField, Field<unknown>>)[k] = { ...f, bbox: { ...box } };
    }
    patch.annotatedKey = annotatedKey;
  }
  const dup = fix.duplicate;
  if (dup && !row.approved && !row.flags.some((f) => f.code === "duplicate")) {
    patch.flags = [dup.flag, ...row.flags];
    if (dup.toReview && row.status === "done") {
      patch.status = "needs_review";
      patch.reviewRequired = true;
    }
  }
  return patch;
}

// ── Applying a plan ──────────────────────────────────────────────────────────

/** The storage a re-check needs — `repo` in the app, a fake in tests. */
export interface RecheckIO {
  listReceipts(batchId: string): Promise<Receipt[]>;
  getBlob(key: string): Promise<Blob | undefined>;
  putBlob(blob: Blob, kind: "annotated"): Promise<string>;
  deleteBlob(key: string): Promise<void>;
  /** Compare-and-swap: null when the row's updatedAt moved, undefined when
   *  it is gone (repo.updateReceipt). */
  updateReceipt(id: string, patch: Partial<Receipt>, expect: { updatedAt: number }): Promise<Receipt | null | undefined>;
  /** Bake highlight marks onto the cleaned image (annotate.annotateReceipt). */
  bake(cleaned: Blob, marks: HighlightMark[]): Promise<Blob | null>;
}

export interface RecheckResult {
  /** Legacy AI reads that gained outlines (boxes + annotated copy). */
  boxes: number;
  /** Duplicate flags added. */
  duplicates: number;
  /** Receipts whose fixes lost the race: the row changed after planning (a
   *  save, a read, a sync). Another re-check can land them. */
  skipped: number;
  /** Outlines this device can't draw: no cleaned image here (a synced row
   *  whose image hasn't downloaded — the next pull back-fills it) or one
   *  that won't decode/bake. Re-running now won't help, so the toast never
   *  says "try again" about these. */
  unfixable: number;
  /** Receipts whose fixes couldn't be saved: storage threw reading or
   *  writing a blob, or on the row write (quota, a closing database).
   *  Retryable — the one case the toast says "try again". */
  failed: number;
}

/**
 * Plan and apply a re-check of `batchId`, one receipt at a time. Each
 * receipt's fixes are ONE write, a compare-and-swap on the `updatedAt` it
 * was planned from: a human (or the pipeline, or sync) who wrote in between
 * wins, and that fix is skipped — never retried blindly. A new annotated
 * blob whose write didn't land is deleted; a replaced one is deleted once
 * its successor is referenced. A bake that fails drops only the outlines —
 * the duplicate flag still lands.
 */
export async function runBatchRecheck(batchId: string, io: RecheckIO): Promise<RecheckResult> {
  const rows = await io.listReceipts(batchId);
  const plan = planBatchRecheck(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const boxFor = new Map(plan.boxes.map((f) => [f.id, f]));
  const dupFor = new Map(plan.duplicates.map((f) => [f.id, f]));
  const ids = [...new Set([...plan.boxes.map((f) => f.id), ...plan.duplicates.map((f) => f.id)])];

  const result: RecheckResult = { boxes: 0, duplicates: 0, skipped: 0, unfixable: 0, failed: 0 };
  for (const id of ids) {
    const row = byId.get(id)!;
    let box = boxFor.get(id);
    const duplicate = dupFor.get(id);

    let newKey: string | undefined;
    if (box) {
      // Sorted by cause: storage throwing is retryable ("failed"); no image
      // here, or one that won't bake, is not ("unfixable").
      let storageError = false;
      let cleaned: Blob | undefined;
      try {
        cleaned = await io.getBlob(box.cleanedKey);
      } catch (err) {
        storageError = true;
        console.warn("[recheck] couldn't read the cleaned image for", id, err);
      }
      let baked: Blob | null = null;
      if (cleaned) {
        try {
          baked = await io.bake(cleaned, box.marks);
        } catch (err) {
          console.warn("[recheck] couldn't bake the highlighted copy for", id, err);
        }
      }
      if (baked) {
        try {
          newKey = await io.putBlob(baked, "annotated");
        } catch (err) {
          storageError = true;
          console.warn("[recheck] couldn't store the highlighted copy for", id, err);
        }
      }
      if (!newKey) {
        if (storageError) result.failed++;
        else result.unfixable++;
        box = undefined;
      }
    }
    if (!box && !duplicate) continue;

    const patch = recheckPatch(row, { box, duplicate }, newKey);
    if (Object.keys(patch).length === 0) {
      if (newKey) await io.deleteBlob(newKey).catch(() => {});
      continue;
    }
    let written: Receipt | null | undefined = null;
    let threw = false;
    try {
      // `row` is the snapshot the plan was made from: its updatedAt is every
      // fix's `expectUpdatedAt`.
      written = await io.updateReceipt(id, patch, { updatedAt: row.updatedAt });
    } catch (err) {
      threw = true;
      console.warn("[recheck] couldn't write", id, err);
    }
    if (!written) {
      // Changed (or gone) since planning — or storage threw: nothing of ours
      // references the bake. Counted per RECEIPT, as the toast says.
      if (newKey) await io.deleteBlob(newKey).catch(() => {});
      if (threw) result.failed++;
      else result.skipped++;
      continue;
    }
    if (box) {
      result.boxes++;
      if (box.oldAnnotatedKey && box.oldAnnotatedKey !== newKey) {
        await io.deleteBlob(box.oldAnnotatedKey).catch(() => {});
      }
    }
    if (duplicate && patch.flags) result.duplicates++;
  }
  return result;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The toast after a re-check. Pure. */
export function recheckSummary(r: RecheckResult): string {
  const raced = r.skipped > 0
    ? `${plural(r.skipped, "receipt", "receipts")} changed meanwhile — re-check again to include ${r.skipped === 1 ? "it" : "them"}.`
    : "";
  const failed = r.failed > 0 ? `${plural(r.failed, "receipt", "receipts")} couldn't be saved — try again.` : "";
  const noImage = r.unfixable > 0
    ? `${plural(r.unfixable, "older AI read has", "older AI reads have")} no usable image on this device to outline.`
    : "";
  const tail = [raced, failed, noImage].filter(Boolean).join(" ");
  if (r.boxes === 0 && r.duplicates === 0) {
    return tail ? `Nothing changed. ${tail}` : "Nothing to fix — this batch is up to date.";
  }
  const parts: string[] = [];
  if (r.boxes > 0) parts.push(`added outlines to ${plural(r.boxes, "older AI read", "older AI reads")}`);
  if (r.duplicates > 0) parts.push(`flagged ${plural(r.duplicates, "possible duplicate", "possible duplicates")}`);
  const head = parts.join(" and ");
  return `${head[0]!.toUpperCase()}${head.slice(1)}.${tail ? ` ${tail}` : ""}`;
}
