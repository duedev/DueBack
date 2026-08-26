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
