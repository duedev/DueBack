import { db } from "./db.ts";
import type {
  Batch,
  Receipt,
  Job,
  StoredBlob,
  StoredBrand,
  ReceiptStatus,
} from "../types.ts";
import { uid } from "../util/id.ts";
import { normalizeCategory } from "../config/categories.ts";
import {
  appendPendingDelete,
  OWNER_KEY,
  PENDING_DELETES_KEY,
  type PendingDelete,
  type SyncTable,
} from "./syncMerge.ts";

// Categories renamed since older data was stored are normalized on every
// read (config/categories.ts LEGACY_CATEGORIES, Node-tested there).
function normalizeReceipt(r: Receipt): Receipt {
  const mapped = normalizeCategory(r.category?.value as string);
  return mapped !== r.category?.value ? { ...r, category: { ...r.category, value: mapped } } : r;
}

function normalizeBrand(b: StoredBrand): StoredBrand {
  const mapped = normalizeCategory(b.category as string);
  return mapped !== b.category ? { ...b, category: mapped } : b;
}

// Repository over the local stores. This is the one place that reads/writes the
// source of truth, and the one place that announces changes — the UI subscribes
// here instead of holding a connection open (§13: live updates by polling/push,
// scale-to-zero friendly). Everything is awaitable so a remote backend could
// drop in behind the same method shapes.

type Listener = () => void;

/** A lock older than this is a dead run. The queue heartbeats a running
 *  job every 20 s, so a live job never looks more than ~20 s stale; 90 s is
 *  four missed beats. It used to be 5 minutes (chosen before the heartbeat
 *  existed), and after a reload mid-batch the in-flight receipts sat at
 *  "Reading…" for five minutes — with nothing re-waking the pool even then. */
export const STALE_LOCK_MS = 90_000;

/** The jobs table's row rules. Pure, so tests/queue.test.ts drives the SAME
 *  rules through an in-memory work-list (there is no IndexedDB under Node). */
export const jobRows = {
  /** What a claim takes: the oldest job (by `createdAt` — upload order)
   *  whose lock is free or stale. */
  nextClaim(jobs: Job[], now: number, staleLockMs: number): Job | null {
    let oldest: Job | null = null;
    for (const job of jobs) {
      const available = job.lockedAt === null || now - job.lockedAt > staleLockMs;
      if (!available) continue;
      if (!oldest || (job.createdAt ?? 0) < (oldest.createdAt ?? 0)) oldest = job;
    }
    return oldest;
  },
  claimed(job: Job, now: number): Job {
    return { ...job, lockedAt: now, attempts: job.attempts + 1 };
  },
  /** A heartbeat refreshes a lock, never creates one (null: leave the row
   *  alone). A tick that landed just after a pause or a failed attempt gave
   *  the job back used to re-lock it, hiding it from every claim for the
   *  stale window. */
  touched(job: Job, now: number): Job | null {
    return job.lockedAt === null ? null : { ...job, lockedAt: now };
  },
  /** A failed attempt: unlocked, the attempt kept. The STORED row is the
   *  base — the queue's copy carries no `createdAt`, and a retried job used
   *  to lose its claim-order key and jump ahead of everything queued. */
  released(stored: Job, attempts: number): Job {
    return { ...stored, attempts, lockedAt: null };
  },
  /** The pause: the claim given back whole — lock AND attempt (a pause must
   *  never eat a retry) — with `createdAt` kept, so paused receipts resume
   *  in upload order. */
  unclaimed(job: Job): Job {
    return { ...job, lockedAt: null, attempts: Math.max(0, job.attempts - 1) };
  },
  /** A run is over (it landed, or its last attempt failed): the row goes —
   *  UNLESS a "Retry reading" re-armed it meanwhile (`requeued` resets
   *  attempts to 0, and every claim leaves attempts ≥ 1). A Retry landing
   *  between the final attempt's "failed" write and this used to have its
   *  row deleted under it: the receipt sat "queued" with no job, forever.
   *  null = delete. */
  retired(stored: Job): Job | null {
    return stored.attempts === 0 ? { ...stored, lockedAt: null } : null;
  },
  /** "Retry reading": null (a no-op) unless the receipt is still failed and
   *  unapproved — a human's work outranks a retry. Otherwise the receipt
   *  goes back to queued and it ends up with AT MOST one job: a job it
   *  already has only gets its attempts back (`createdAt` kept), and a new
   *  one is inserted only when there is none. A blind insert gave a receipt
   *  that failed while paused a SECOND job beside its released one, and
   *  resume read it twice at once — the older claim's extraction discarded,
   *  its blobs orphaned, the metered assist possibly billed twice. A locked
   *  job keeps its lock: it belongs to a run still unwinding (the queue
   *  releases or completes the row a few writes after "failed" lands —
   *  before the board's coalesced refresh can even show a Retry) or to
   *  another tab, and goes stale on its own if that tab died; unlocking it
   *  would let a second claim start beside the run that holds it. */
  requeued(
    receipt: Pick<Receipt, "id" | "status" | "approved"> | undefined,
    jobs: Job[],
    now: number,
    newJobId: string,
  ): { patch: Partial<Receipt>; jobs: Job[] } | null {
    if (!receipt || receipt.status !== "failed" || receipt.approved) return null;
    return {
      patch: {
        status: "queued",
        error: undefined,
        flags: [],
        reviewRequired: false,
        updatedAt: now,
      },
      jobs:
        jobs.length > 0
          ? jobs.map((j) => ({ ...j, attempts: 0 }))
          : [{ id: newJobId, receiptId: receipt.id, attempts: 0, lockedAt: null, createdAt: now }],
    };
  },
};

class Repo {
  private listeners = new Set<Listener>();

  /** Subscribe to "something changed"; returns an unsubscribe fn. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error("repo listener failed", err);
      }
    }
  }

  /** Let an external bulk writer (the sync engine) announce a change once. */
  externalChange(): void {
    this.notify();
  }

  // ---- Blobs (file store) ----------------------------------------------

  async putBlob(
    blob: Blob,
    kind: StoredBlob["kind"],
    key = uid("blob"),
  ): Promise<string> {
    const record: StoredBlob = { key, blob, kind, createdAt: Date.now() };
    await (await db()).put("blobs", record);
    return key;
  }

  async getBlob(key: string): Promise<Blob | undefined> {
    const rec = await (await db()).get("blobs", key);
    return rec?.blob;
  }

  async deleteBlob(key: string): Promise<void> {
    await (await db()).delete("blobs", key);
  }

  // ---- Batches ----------------------------------------------------------

  async createBatch(
    fields: Pick<Batch, "employee" | "jobName" | "jobNumber">,
  ): Promise<Batch> {
    const now = Date.now();
    const batch: Batch = { id: uid("batch"), createdAt: now, updatedAt: now, ...fields };
    await (await db()).put("batches", batch);
    this.notify();
    return batch;
  }

  async getBatch(id: string): Promise<Batch | undefined> {
    return (await db()).get("batches", id);
  }

  async updateBatch(id: string, patch: Partial<Batch>): Promise<void> {
    const conn = await db();
    const tx = conn.transaction("batches", "readwrite");
    const cur = await tx.store.get(id);
    if (cur) await tx.store.put({ ...cur, ...patch, updatedAt: Date.now() });
    await tx.done;
    if (cur) this.notify();
  }

  async listBatches(): Promise<Batch[]> {
    const all = await (await db()).getAllFromIndex("batches", "byCreated");
    return all.reverse(); // newest first
  }

  // ---- Receipts ---------------------------------------------------------

  async putReceipt(receipt: Receipt): Promise<void> {
    await (await db()).put("receipts", receipt);
    this.notify();
  }

  async getReceipt(id: string): Promise<Receipt | undefined> {
    const r = await (await db()).get("receipts", id);
    return r ? normalizeReceipt(r) : undefined;
  }

  /** Read-modify-write in ONE transaction (no non-IDB await between the get
   *  and the put, or the transaction auto-commits — the rule touchJob
   *  follows). With `expect`, the write lands only while the stored
   *  `updatedAt` still matches and returns null otherwise: the pipeline's
   *  completion write uses it so a review save that slips between its
   *  re-read and its put is never overwritten. */
  async updateReceipt(
    id: string,
    patch: Partial<Receipt>,
    expect?: { updatedAt: number },
  ): Promise<Receipt | undefined | null> {
    const conn = await db();
    const tx = conn.transaction("receipts", "readwrite");
    const cur = await tx.store.get(id);
    if (!cur) {
      await tx.done;
      return undefined;
    }
    if (expect && cur.updatedAt !== expect.updatedAt) {
      await tx.done;
      return null;
    }
    const next: Receipt = { ...normalizeReceipt(cur), ...patch, updatedAt: Date.now() };
    await tx.store.put(next);
    await tx.done;
    this.notify();
    return next;
  }

  async listReceipts(batchId: string): Promise<Receipt[]> {
    const all = await (await db()).getAllFromIndex("receipts", "byBatch", batchId);
    return all.map(normalizeReceipt).sort((a, b) => a.createdAt - b.createdAt);
  }

  async findByHash(hash: string): Promise<Receipt[]> {
    const all = await (await db()).getAllFromIndex("receipts", "byHash", hash);
    return all.map(normalizeReceipt);
  }

  /** Store a new receipt — its original bytes, the row and its job — in ONE
   *  transaction: a quota error mid-way used to leave an orphaned blob or a
   *  "Queued" card with no job behind it, and the card now first renders
   *  with its image already present. */
  async addReceipt(receipt: Receipt, original: Blob): Promise<void> {
    const conn = await db();
    const tx = conn.transaction(["blobs", "receipts", "jobs"], "readwrite");
    const job: Job = {
      id: uid("job"),
      receiptId: receipt.id,
      attempts: 0,
      lockedAt: null,
      createdAt: receipt.createdAt,
    };
    await Promise.all([
      tx.objectStore("blobs").put({
        key: receipt.fileKey,
        blob: original,
        kind: "original",
        createdAt: receipt.createdAt,
      }),
      tx.objectStore("receipts").put(receipt),
      tx.objectStore("jobs").put(job),
    ]);
    await tx.done;
    this.notify();
  }

  /** Row, blobs and any pending job go in ONE transaction; the sync
   *  tombstone (kv) is recorded after the commit, as before. */
  async deleteReceipt(id: string): Promise<void> {
    const conn = await db();
    const tx = conn.transaction(["blobs", "receipts", "jobs"], "readwrite");
    const r = await tx.objectStore("receipts").get(id);
    const blobKeys = r
      ? [r.fileKey, r.cleanedKey, r.annotatedKey].filter((k): k is string => !!k)
      : [];
    const jobKeys = await tx.objectStore("jobs").index("byReceipt").getAllKeys(id);
    await Promise.all([
      ...blobKeys.map((k) => tx.objectStore("blobs").delete(k)),
      tx.objectStore("receipts").delete(id),
      ...jobKeys.map((k) => tx.objectStore("jobs").delete(k)),
    ]);
    await tx.done;
    await this.recordPendingDelete("receipts", id, blobKeys);
    this.notify();
  }

  /** Receipt ids with a job in THIS browser's work-list — the board's way
   *  of telling "reading here" from "another device is reading it". */
  async listJobReceiptIds(): Promise<string[]> {
    return (await (await db()).getAll("jobs")).map((j) => j.receiptId);
  }

  async countByStatus(batchId: string): Promise<Record<ReceiptStatus, number>> {
    const receipts = await this.listReceipts(batchId);
    const counts: Record<ReceiptStatus, number> = {
      queued: 0,
      processing: 0,
      done: 0,
      needs_review: 0,
      failed: 0,
    };
    for (const r of receipts) counts[r.status]++;
    return counts;
  }

  // ---- Jobs (the cheap work-list) --------------------------------------
  // New jobs are born with their receipt (addReceipt) or by a retry
  // (requeueFailed) — there is deliberately no blind "insert a job": one
  // receipt with two jobs is two reads racing each other.

  /** Re-queue a failed receipt for a fresh read: the status re-check, the
   *  receipt write and the job write in ONE transaction over receipts+jobs
   *  (`jobRows.requeued` — at most one job per receipt). Returns whether
   *  it re-queued. */
  async requeueFailed(id: string): Promise<boolean> {
    const conn = await db();
    const tx = conn.transaction(["receipts", "jobs"], "readwrite");
    const receipts = tx.objectStore("receipts");
    const jobs = tx.objectStore("jobs");
    const [cur, existing] = await Promise.all([
      receipts.get(id),
      jobs.index("byReceipt").getAll(id),
    ]);
    const next = jobRows.requeued(cur, existing, Date.now(), uid("job"));
    if (cur && next) {
      await Promise.all([
        receipts.put({ ...normalizeReceipt(cur), ...next.patch }),
        ...next.jobs.map((j) => jobs.put(j)),
      ]);
    }
    await tx.done;
    if (!next) return false;
    this.notify();
    return true;
  }

  /** Atomically claim the oldest unlocked job (by `createdAt` — upload
   *  order), if any. The stale window is generous because a healthy run
   *  routinely exceeds a minute (serialized OCR, binarize rescue, first-use
   *  model downloads); the queue heartbeats `touchJob` while a job runs, so
   *  only a genuinely dead run goes stale. The jobs table is tiny (one row
   *  per unprocessed receipt), so a full scan per claim is fine. */
  async claimNextJob(staleLockMs = STALE_LOCK_MS): Promise<Job | null> {
    const conn = await db();
    const tx = conn.transaction("jobs", "readwrite");
    const now = Date.now();
    const oldest = jobRows.nextClaim(await tx.store.getAll(), now, staleLockMs);
    let claimed: Job | null = null;
    if (oldest) {
      claimed = jobRows.claimed(oldest, now);
      await tx.store.put(claimed);
    }
    await tx.done;
    return claimed;
  }

  /** Refresh a running job's lock so it never looks stale. No-op once the
   *  row is gone — a blind put would resurrect a completed job — and on an
   *  unlocked row (`jobRows.touched`). */
  async touchJob(jobId: string): Promise<void> {
    const conn = await db();
    const tx = conn.transaction("jobs", "readwrite");
    const job = await tx.store.get(jobId);
    const touched = job ? jobRows.touched(job, Date.now()) : null;
    if (touched) await tx.store.put(touched);
    await tx.done;
  }

  async completeJob(jobId: string): Promise<void> {
    await (await db()).delete("jobs", jobId);
  }

  /** Finish a run's job — delete it, or keep it unlocked when a Retry
   *  re-armed it mid-run (`jobRows.retired`), in one transaction. */
  async retireJob(jobId: string): Promise<void> {
    const conn = await db();
    const tx = conn.transaction("jobs", "readwrite");
    const cur = await tx.store.get(jobId);
    if (cur) {
      const keep = jobRows.retired(cur);
      if (keep) await tx.store.put(keep);
      else await tx.store.delete(jobId);
    }
    await tx.done;
  }

  /** Unlock a job for retry — only if it still exists (read-then-put in one
   *  transaction), so a job a successful run already deleted stays deleted.
   *  The stored row keeps its `createdAt` (`jobRows.released`). */
  async releaseJob(job: Job): Promise<void> {
    const conn = await db();
    const tx = conn.transaction("jobs", "readwrite");
    const cur = await tx.store.get(job.id);
    if (cur) await tx.store.put(jobRows.released(cur, job.attempts));
    await tx.done;
  }

  /** Give a claim back untouched — the queue's pause (`jobRows.unclaimed`:
   *  unlike releaseJob's failed attempt, the attempt is returned too). No-op
   *  once the row is gone. */
  async unclaimJob(jobId: string): Promise<void> {
    const conn = await db();
    const tx = conn.transaction("jobs", "readwrite");
    const job = await tx.store.get(jobId);
    if (job) await tx.store.put(jobRows.unclaimed(job));
    await tx.done;
  }

  async pendingJobCount(): Promise<number> {
    return (await db()).count("jobs");
  }

  // ---- User-taught logo brands ------------------------------------------

  async putBrand(brand: StoredBrand): Promise<void> {
    await (await db()).put("brands", brand);
    this.notify();
  }

  async listBrands(): Promise<StoredBrand[]> {
    const all = await (await db()).getAll("brands");
    return all.map(normalizeBrand).sort((a, b) => a.createdAt - b.createdAt);
  }

  async deleteBrand(id: string): Promise<void> {
    await (await db()).delete("brands", id);
    await this.recordPendingDelete("brand_logos", id, []);
    this.notify();
  }

  /** Record a deletion for the sync engine to tombstone remotely later — it
   *  must be captured at delete time (blob keys included) because it cannot
   *  be reconstructed afterwards. kv-only, so signed-out use stays sync-free;
   *  a queued entry for a row that was never pushed no-ops remotely (the
   *  tombstone is an UPDATE, not an upsert). */
  private async recordPendingDelete(
    table: SyncTable,
    id: string,
    blobKeys: string[],
  ): Promise<void> {
    const list =
      (await this.getSetting<PendingDelete[]>(PENDING_DELETES_KEY)) ?? [];
    await this.setSetting(
      PENDING_DELETES_KEY,
      appendPendingDelete(list, { table, id, blobKeys, at: Date.now() }),
    );
  }

  /** Clear this device's stores outright: batches, receipts, jobs, blobs,
   *  taught brands, the pending-delete log and the owner mark. NOT through
   *  deleteReceipt/deleteBrand — those queue tombstones, and these rows may
   *  belong to another account (the foreign-owner sync block is the reason
   *  this exists). Settings and preferences in kv survive. */
  async wipeLocalData(): Promise<void> {
    const conn = await db();
    const stores = ["batches", "receipts", "jobs", "blobs", "brands", "kv"] as const;
    const tx = conn.transaction(stores, "readwrite");
    await Promise.all([
      tx.objectStore("batches").clear(),
      tx.objectStore("receipts").clear(),
      tx.objectStore("jobs").clear(),
      tx.objectStore("blobs").clear(),
      tx.objectStore("brands").clear(),
      tx.objectStore("kv").delete(PENDING_DELETES_KEY),
      tx.objectStore("kv").delete(OWNER_KEY),
    ]);
    await tx.done;
    this.notify();
  }

  // ---- Settings (small key/value) ---------------------------------------

  async getSetting<T>(key: string): Promise<T | undefined> {
    const rec = await (await db()).get("kv", key);
    return rec?.value as T | undefined;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await (await db()).put("kv", { key, value });
  }
}

export const repo = new Repo();
