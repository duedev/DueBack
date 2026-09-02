// Pure decision logic for the sync engine — no Supabase, no IndexedDB, no DOM,
// so it is Node-testable (the store/jobs.ts pattern) and `repo` can record
// pending deletes through it without growing a sync dependency.

export type SyncTable = "batches" | "receipts" | "brand_logos";

/** A deletion recorded at delete time (it cannot be reconstructed later).
 *  The sync engine consumes each entry as a remote tombstone UPDATE plus a
 *  storage removal of the row's blobs. Lives in the local kv store, so
 *  signed-out deletes queue harmlessly until (unless) the user signs in. */
export interface PendingDelete {
  table: SyncTable;
  id: string;
  /** Storage blob keys the row referenced, captured before removal. */
  blobKeys: string[];
  /** Epoch ms of the local delete — becomes the tombstone's updated_at. */
  at: number;
}

export const PENDING_DELETES_KEY = "sync.pendingDeletes";
/** Bounded so kv can't grow forever; a full clearAll is maxReceiptsPerBatch
 *  (200) entries, so the cap only bites after several never-synced sweeps. */
export const PENDING_DELETES_CAP = 500;

export function pendingDeleteKey(e: PendingDelete): string {
  return `${e.table}:${e.id}:${e.at}`;
}

/** Append a deletion: dedupes (table, id) keeping the newest — re-deleting a
 *  re-synced copy of the same row — and drops the oldest past the cap. */
export function appendPendingDelete(
  list: readonly PendingDelete[],
  entry: PendingDelete,
): PendingDelete[] {
  const rest = list.filter((e) => e.table !== entry.table || e.id !== entry.id);
  const next = [...rest, entry];
  return next.slice(Math.max(0, next.length - PENDING_DELETES_CAP));
}

/** Drop consumed entries from the *currently stored* list (which may have
 *  grown while the push ran — those must survive). Entries whose remote call
 *  failed are simply not in `consumed`, so they stay queued and retry. */
export function pruneConsumed(
  current: readonly PendingDelete[],
  consumed: readonly PendingDelete[],
): PendingDelete[] {
  const done = new Set(consumed.map(pendingDeleteKey));
  return current.filter((e) => !done.has(pendingDeleteKey(e)));
}

export type RemoteAction = "apply" | "deleteLocal" | "ignore";

/** LWW decision for one pulled/realtime row. `remoteUpdatedAt` is the row's
 *  updated_at COLUMN (a tombstone UPDATE bumps it past the stale payload);
 *  `remoteDeletedAt` is the deleted_at column (ISO string or null). A
 *  tombstone is never inserted — it only removes a strictly older local row,
 *  so a genuinely newer local edit revives the record per LWW on the next
 *  push (the upserts set deleted_at back to null). */
export function remoteAction(
  localUpdatedAt: number | undefined,
  remoteUpdatedAt: number,
  remoteDeletedAt: string | null | undefined,
): RemoteAction {
  if (remoteDeletedAt != null) {
    if (localUpdatedAt === undefined) return "ignore";
    return remoteUpdatedAt > localUpdatedAt ? "deleteLocal" : "ignore";
  }
  if (localUpdatedAt === undefined || remoteUpdatedAt > localUpdatedAt) {
    return "apply";
  }
  return "ignore";
}

/** Per-account memory of which blobs are already in storage. The old
 *  unscoped "sync.uploadedBlobs" let account B inherit account A's list on a
 *  shared device, so B's blobs were never uploaded under B/<key>. The old key
 *  is deliberately ignored (not migrated): worst case is a one-time
 *  re-upload, and storage uploads use upsert so that is idempotent. */
export function uploadedBlobsKey(userId: string): string {
  return `sync.uploadedBlobs.${userId}`;
}

export interface AdoptionCandidate {
  id: string;
  updatedAt: number;
  receiptCount: number;
}

/** Pick the batch a fresh device should adopt after the first pull: the most
 *  recently updated batch that actually has receipts. Never steals an active
 *  batch that already has receipts (an active batch absent from `candidates`
 *  counts as empty), and returns null when there is nothing better. */
export function chooseAdoptionBatch(
  activeBatchId: string | null,
  candidates: readonly AdoptionCandidate[],
): string | null {
  const active = candidates.find((b) => b.id === activeBatchId);
  if (active && active.receiptCount > 0) return null;
  let best: AdoptionCandidate | null = null;
  for (const b of candidates) {
    if (b.id === activeBatchId || b.receiptCount === 0) continue;
    if (!best || b.updatedAt > best.updatedAt) best = b;
  }
  return best?.id ?? null;
}

/** PostgREST caps a select at 1000 rows by default; an unpaginated pull
 *  silently dropped everything past that once receipts — tombstones
 *  included — accumulated, so a fresh device missed live rows. */
export const PULL_PAGE = 1000;

/** Page through a query until an EMPTY page arrives. `page(from, to)` runs
 *  one `.range(from, to)` select over a STABLE ordering. The walk advances
 *  by the rows actually returned and stops only on an empty page: a server
 *  whose row cap is lower than `pageSize` (PostgREST `max-rows` is a
 *  deployment setting) returns "short" pages that are not the end, and
 *  stopping on the first of them silently dropped the rest. One extra,
 *  empty request per table is the price. */
export async function fetchAll<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
  pageSize = PULL_PAGE,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) throw new Error(`${label} pull: ${error.message}`);
    const rows = data ?? [];
    if (rows.length === 0) return out;
    out.push(...rows);
    from += rows.length;
  }
}

/** kv key (per account): the newest `updatedAt` this device has pushed. A
 *  push used to upsert EVERY batch/receipt/brand row with its full payload
 *  on every 1.5 s debounce tick while a batch processed — tens of MB of
 *  uploads for a 200-receipt run. */
export function lastPushKey(userId: string): string {
  return `sync.lastPushAt.${userId}`;
}

/** The rows a push must carry: everything stamped at or after `since`
 *  (`>=`, not `>`: a row edited in the same millisecond as the previous
 *  push's newest row would otherwise be skipped; re-upserting is
 *  idempotent under the LWW guard). `since` 0 = push everything (a fresh
 *  sign-in). */
export function changedSince<T extends { updatedAt: number }>(rows: readonly T[], since: number): T[] {
  return rows.filter((r) => r.updatedAt >= since);
}

/** kv key: the account whose data this device's local store holds. Written
 *  after the first successful push of a sign-in; cleared by a local wipe. */
export const OWNER_KEY = "sync.ownerUserId";

export type OwnerDecision = "adopt" | "continue" | "foreign";

/** May `userId` sync this device's local store? "adopt": no owner recorded
 *  (anonymous local data, a pre-owner install) or nothing local at all —
 *  the sign-in claims it, which is the legitimate anonymous→account path.
 *  "continue": same owner. "foreign": another account's data is still on
 *  this device (a shared laptop where A signed out and B signed in) — the
 *  engine fails closed rather than push A's receipts into B's workspace and
 *  pull B's onto the board A left behind. */
export function ownerDecision(
  storedOwner: string | undefined,
  userId: string,
  hasLocalData: boolean,
): OwnerDecision {
  if (!storedOwner || !hasLocalData) return "adopt";
  return storedOwner === userId ? "continue" : "foreign";
}

/** Whether a tombstone UPDATE actually landed. The lww_guard trigger keeps a
 *  row a NEWER remote edit revived and returns it with deleted_at still null;
 *  a never-pushed row returns nothing. Only a landed tombstone may take the
 *  row's storage objects with it — removing them otherwise left a live,
 *  revived receipt without its images on every device. */
export function tombstoneLanded(
  rows: readonly { deleted_at: string | null }[] | null | undefined,
): boolean {
  return (rows ?? []).some((r) => r.deleted_at != null);
}
