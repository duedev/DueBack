import { db } from "./db.ts";
import type {
  Batch,
  Receipt,
  Job,
  StoredBlob,
  StoredBrand,
  ReceiptStatus,
  Category,
} from "../types.ts";
import { uid } from "../util/id.ts";
import {
  appendPendingDelete,
  PENDING_DELETES_KEY,
  type PendingDelete,
  type SyncTable,
} from "./syncMerge.ts";

// Categories renamed since older data was stored (locally or in Supabase).
// Normalized on every read so legacy receipts keep working untouched.
const LEGACY_CATEGORIES: Record<string, Category> = {
  "Meals & Entertainment": "Meals",
};

function normalizeReceipt(r: Receipt): Receipt {
  const mapped = LEGACY_CATEGORIES[r.category?.value as string];
  return mapped ? { ...r, category: { ...r.category, value: mapped } } : r;
}

function normalizeBrand(b: StoredBrand): StoredBrand {
  const mapped = LEGACY_CATEGORIES[b.category as string];
  return mapped ? { ...b, category: mapped } : b;
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
    const cur = await this.getBatch(id);
    if (!cur) return;
    await (await db()).put("batches", { ...cur, ...patch, updatedAt: Date.now() });
    this.notify();
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

  async updateReceipt(id: string, patch: Partial<Receipt>): Promise<Receipt | undefined> {
    const cur = await this.getReceipt(id);
    if (!cur) return undefined;
    const next: Receipt = { ...cur, ...patch, updatedAt: Date.now() };
    await (await db()).put("receipts", next);
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

  async deleteReceipt(id: string): Promise<void> {
    const r = await this.getReceipt(id);
    const blobKeys = r
      ? [r.fileKey, r.cleanedKey, r.annotatedKey].filter((k): k is string => !!k)
      : [];
    for (const key of blobKeys) await this.deleteBlob(key).catch(() => {});
    const conn = await db();
    await conn.delete("receipts", id);
    // Drop any pending job too.
    const jobs = await conn.getAllFromIndex("jobs", "byReceipt", id);
    await Promise.all(jobs.map((j) => conn.delete("jobs", j.id)));
    await this.recordPendingDelete("receipts", id, blobKeys);
    this.notify();
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

  async enqueue(receiptId: string): Promise<Job> {
    const job: Job = {
      id: uid("job"),
      receiptId,
      attempts: 0,
      lockedAt: null,
      createdAt: Date.now(),
    };
    await (await db()).put("jobs", job);
    return job;
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
    let oldest: Job | null = null;
    for (const job of await tx.store.getAll()) {
      const available = job.lockedAt === null || now - job.lockedAt > staleLockMs;
      if (!available) continue;
      if (!oldest || (job.createdAt ?? 0) < (oldest.createdAt ?? 0)) oldest = job;
    }
    let claimed: Job | null = null;
    if (oldest) {
      claimed = { ...oldest, lockedAt: now, attempts: oldest.attempts + 1 };
      await tx.store.put(claimed);
    }
    await tx.done;
    return claimed;
  }

  /** Refresh a running job's lock so it never looks stale. No-op once the
   *  row is gone — a blind put would resurrect a completed job. */
  async touchJob(jobId: string): Promise<void> {
    const conn = await db();
    const tx = conn.transaction("jobs", "readwrite");
    const job = await tx.store.get(jobId);
    if (job) await tx.store.put({ ...job, lockedAt: Date.now() });
    await tx.done;
  }

  async completeJob(jobId: string): Promise<void> {
    await (await db()).delete("jobs", jobId);
  }

  /** Unlock a job for retry — only if it still exists (read-then-put in one
   *  transaction), so a job a successful run already deleted stays deleted. */
  async releaseJob(job: Job): Promise<void> {
    const conn = await db();
    const tx = conn.transaction("jobs", "readwrite");
    const cur = await tx.store.get(job.id);
    if (cur) await tx.store.put({ ...job, lockedAt: null });
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
