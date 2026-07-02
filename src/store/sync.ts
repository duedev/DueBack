import { supabase } from "../supabase/client.ts";
import { repo } from "./repo.ts";
import { db } from "./db.ts";
import type { Batch, Receipt, StoredBrand } from "../types.ts";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

// The sync engine: IndexedDB stays the working store (local-first — the app is
// complete without this file ever running); signing in mirrors it to the
// user's own Supabase workspace. Reconciliation is last-write-wins on the
// record's `updatedAt` (ms). Each row carries the full record as `payload`
// jsonb plus a few indexed columns for queries/Realtime; blobs (original +
// cleaned images) go to the private `receipts` storage bucket under
// `<uid>/<blobKey>`.

type SyncStatus = "off" | "syncing" | "idle" | "error";

interface ReceiptRow {
  id: string;
  batch_id: string;
  updated_at: number;
  created_at: number;
  image_hash: string | null;
  status: string;
  vendor: string;
  date: string;
  amount: number;
  category: string;
  approved: boolean;
  review_required: boolean;
  logo_match: unknown;
  payload: Receipt;
}

interface BatchRow {
  id: string;
  updated_at: number;
  created_at: number;
  employee: string;
  job_name: string;
  job_number: string;
  payload: Batch;
}

interface BrandRow {
  id: string;
  name: string;
  category: string;
  embedding: number[];
  created_at: number;
}

const BLOB_BUCKET = "receipts";
const SYNCED_BLOBS_KEY = "sync.uploadedBlobs";
const PUSH_DEBOUNCE_MS = 1500;

function receiptToRow(r: Receipt): ReceiptRow {
  return {
    id: r.id,
    batch_id: r.batchId,
    updated_at: r.updatedAt,
    created_at: r.createdAt,
    image_hash: r.imageHash ?? null,
    status: r.status,
    vendor: r.vendor.value,
    date: r.date.value,
    amount: r.amount.value,
    category: r.category.value,
    approved: r.approved,
    review_required: r.reviewRequired,
    logo_match: r.logoMatch ?? null,
    payload: r,
  };
}

function batchToRow(b: Batch): BatchRow {
  return {
    id: b.id,
    updated_at: b.updatedAt,
    created_at: b.createdAt,
    employee: b.employee,
    job_name: b.jobName,
    job_number: b.jobNumber,
    payload: b,
  };
}

class SyncEngine {
  status: SyncStatus = "off";
  lastError = "";
  private userId: string | null = null;
  private channel: RealtimeChannel | null = null;
  private unsubRepo: (() => void) | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private applyingRemote = false;
  private uploaded = new Set<string>();
  private listeners = new Set<(s: SyncStatus) => void>();

  onStatus(fn: (s: SyncStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setStatus(s: SyncStatus, err = ""): void {
    this.status = s;
    this.lastError = err;
    for (const fn of this.listeners) fn(s);
  }

  async start(userId: string): Promise<void> {
    const c = supabase();
    if (!c || this.userId === userId) return;
    this.stop();
    this.userId = userId;
    this.setStatus("syncing");
    this.uploaded = new Set(
      (await repo.getSetting<string[]>(SYNCED_BLOBS_KEY)) ?? [],
    );
    try {
      await this.pullAll(c);
      await this.pushAll(c);
      this.subscribeRealtime(c, userId);
      this.unsubRepo = repo.subscribe(() => {
        if (!this.applyingRemote) this.schedulePush();
      });
      this.setStatus("idle");
    } catch (err) {
      this.setStatus("error", err instanceof Error ? err.message : String(err));
    }
  }

  stop(): void {
    this.channel?.unsubscribe();
    this.channel = null;
    this.unsubRepo?.();
    this.unsubRepo = null;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.userId = null;
    this.setStatus("off");
  }

  private schedulePush(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      const c = supabase();
      if (c && this.userId) {
        void this.pushAll(c).catch((err) => {
          this.setStatus("error", err instanceof Error ? err.message : String(err));
        });
      }
    }, PUSH_DEBOUNCE_MS);
  }

  // ---- push ---------------------------------------------------------------

  private async pushAll(c: SupabaseClient): Promise<void> {
    this.setStatus("syncing");
    const conn = await db();
    const batches = await conn.getAll("batches");
    const receipts = await conn.getAll("receipts");
    const brands = await conn.getAll("brands");

    if (batches.length) {
      const { error } = await c
        .from("batches")
        .upsert(batches.map(batchToRow), { onConflict: "id" });
      if (error) throw new Error(`batches push: ${error.message}`);
    }
    if (receipts.length) {
      const { error } = await c
        .from("receipts")
        .upsert(receipts.map(receiptToRow), { onConflict: "id" });
      if (error) throw new Error(`receipts push: ${error.message}`);
    }
    if (brands.length) {
      const rows: BrandRow[] = brands.map((b) => ({
        id: b.id,
        name: b.name,
        category: b.category,
        embedding: b.embedding,
        created_at: b.createdAt,
      }));
      const { error } = await c
        .from("brand_logos")
        .upsert(rows, { onConflict: "id" });
      if (error) throw new Error(`brands push: ${error.message}`);
    }

    // Upload referenced blobs not yet in storage.
    for (const r of receipts) {
      for (const key of [r.fileKey, r.cleanedKey]) {
        if (!key || this.uploaded.has(key)) continue;
        const blob = await repo.getBlob(key);
        if (!blob) continue;
        const path = `${this.userId}/${key}`;
        const { error } = await c.storage
          .from(BLOB_BUCKET)
          .upload(path, blob, { upsert: true, contentType: blob.type || "image/jpeg" });
        if (!error) this.uploaded.add(key);
      }
    }
    await repo.setSetting(SYNCED_BLOBS_KEY, [...this.uploaded]);
    this.setStatus("idle");
  }

  // ---- pull ---------------------------------------------------------------

  private async pullAll(c: SupabaseClient): Promise<void> {
    const [batches, receipts, brands] = await Promise.all([
      c.from("batches").select("payload, updated_at"),
      c.from("receipts").select("payload, updated_at"),
      c.from("brand_logos").select("id, name, category, embedding, created_at"),
    ]);
    if (batches.error) throw new Error(`batches pull: ${batches.error.message}`);
    if (receipts.error) throw new Error(`receipts pull: ${receipts.error.message}`);
    if (brands.error) throw new Error(`brands pull: ${brands.error.message}`);

    this.applyingRemote = true;
    try {
      const conn = await db();
      for (const row of (batches.data ?? []) as { payload: Batch }[]) {
        const remote = row.payload;
        const local = await repo.getBatch(remote.id);
        if (!local || remote.updatedAt > local.updatedAt) {
          await conn.put("batches", remote);
        }
      }
      for (const row of (receipts.data ?? []) as { payload: Receipt }[]) {
        const remote = row.payload;
        const local = await repo.getReceipt(remote.id);
        if (!local || remote.updatedAt > local.updatedAt) {
          await conn.put("receipts", remote);
          await this.ensureBlobs(c, remote);
        }
      }
      for (const row of (brands.data ?? []) as BrandRow[]) {
        const existing = await conn.get("brands", row.id);
        if (!existing) {
          const brand: StoredBrand = {
            id: row.id,
            name: row.name,
            category: row.category as StoredBrand["category"],
            embedding: row.embedding,
            createdAt: row.created_at,
          };
          await conn.put("brands", brand);
        }
      }
    } finally {
      this.applyingRemote = false;
    }
    // One notify for the whole merge (guarded, so it can't echo into a push).
    this.applyingRemote = true;
    try {
      repo.externalChange();
    } finally {
      this.applyingRemote = false;
    }
    await repo.setSetting("sync.lastPullAt", Date.now());
  }

  /** Download any storage blobs a merged receipt references but we don't hold. */
  private async ensureBlobs(c: SupabaseClient, r: Receipt): Promise<void> {
    for (const key of [r.fileKey, r.cleanedKey]) {
      if (!key) continue;
      if (await repo.getBlob(key)) continue;
      const path = `${this.userId}/${key}`;
      const { data, error } = await c.storage.from(BLOB_BUCKET).download(path);
      if (!error && data) {
        await repo.putBlob(data, key === r.fileKey ? "original" : "cleaned", key);
        this.uploaded.add(key);
      }
    }
  }

  // ---- realtime -----------------------------------------------------------

  private subscribeRealtime(c: SupabaseClient, userId: string): void {
    this.channel = c
      .channel("receipts-sync")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "receipts",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          void this.applyRemoteReceipt(c, payload.new as ReceiptRow | null);
        },
      )
      .subscribe();
  }

  private async applyRemoteReceipt(
    c: SupabaseClient,
    row: ReceiptRow | null,
  ): Promise<void> {
    const remote = row?.payload;
    if (!remote?.id) return;
    const local = await repo.getReceipt(remote.id);
    if (local && remote.updatedAt <= local.updatedAt) return; // our own echo
    this.applyingRemote = true;
    try {
      const conn = await db();
      await conn.put("receipts", remote);
      await this.ensureBlobs(c, remote);
      repo.externalChange();
    } finally {
      this.applyingRemote = false;
    }
  }
}

export const sync = new SyncEngine();
