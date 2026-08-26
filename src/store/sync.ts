import { supabase } from "../supabase/client.ts";
import { repo } from "./repo.ts";
import { db, type ReimburseDB } from "./db.ts";
import type { Batch, Receipt, StoredBrand } from "../types.ts";
import type { IDBPDatabase } from "idb";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import {
  PENDING_DELETES_KEY,
  pruneConsumed,
  remoteAction,
  uploadedBlobsKey,
  type PendingDelete,
} from "./syncMerge.ts";

// The sync engine: IndexedDB stays the working store (local-first — the app is
// complete without this file ever running); signing in mirrors it to the
// user's own Supabase workspace. Reconciliation is last-write-wins on the
// record's `updatedAt` (ms) — enforced on pull here (syncMerge.remoteAction)
// and on push by migration 0004's lww_guard trigger, so a stale device can't
// revert newer cloud rows. Deletes travel as tombstones: repo records each
// local delete in kv (sync.pendingDeletes) and this engine pushes them as
// `deleted_at` UPDATEs before any upsert, removing the storage objects too.
// Each row carries the full record as `payload` jsonb plus a few indexed
// columns for queries/Realtime; blobs (original + cleaned images) go to the
// private `receipts` storage bucket under `<uid>/<blobKey>`.

type SyncStatus = "off" | "syncing" | "idle" | "error";

interface ReceiptRow {
  id: string;
  batch_id: string;
  updated_at: number;
  created_at: number;
  deleted_at: string | null;
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
  deleted_at: string | null;
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
  /** Brands are immutable, so this is created_at on live rows; a tombstone
   *  bumps it to the delete time (always newer) for the LWW guard. */
  updated_at: number;
  deleted_at: string | null;
}

type Conn = IDBPDatabase<ReimburseDB>;

const BLOB_BUCKET = "receipts";
const PUSH_DEBOUNCE_MS = 1500;

function receiptToRow(r: Receipt): ReceiptRow {
  return {
    id: r.id,
    batch_id: r.batchId,
    updated_at: r.updatedAt,
    created_at: r.createdAt,
    deleted_at: null, // a genuinely newer local edit revives a tombstone (LWW)
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
    deleted_at: null,
    employee: b.employee,
    job_name: b.jobName,
    job_number: b.jobNumber,
    payload: b,
  };
}

function brandToRow(b: StoredBrand): BrandRow {
  return {
    id: b.id,
    name: b.name,
    category: b.category,
    embedding: b.embedding,
    created_at: b.createdAt,
    updated_at: b.createdAt,
    deleted_at: null,
  };
}

class SyncEngine {
  status: SyncStatus = "off";
  lastError = "";
  private userId: string | null = null;
  /** True only after start() fully succeeded — a failed start leaves this
   *  false so the next auth event (TOKEN_REFRESHED fires hourly) retries
   *  instead of short-circuiting on userId for the whole session. */
  private started = false;
  private channel: RealtimeChannel | null = null;
  private unsubRepo: (() => void) | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private applyingRemote = false;
  /** A local write notified while applyingRemote was held; flush it. */
  private dirtyWhileApplying = false;
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
    if (!c || (this.started && this.userId === userId)) return;
    this.stop();
    this.userId = userId;
    this.setStatus("syncing");
    // Per-account (M3): the old unscoped key let account B inherit A's list.
    this.uploaded = new Set(
      (await repo.getSetting<string[]>(uploadedBlobsKey(userId))) ?? [],
    );
    try {
      // Deletes first: pull would otherwise re-insert a row this device
      // deleted while offline, resurrecting it before the tombstone lands.
      await this.pushDeletes(c);
      await this.pullAll(c);
      await this.pushAll(c);
      this.subscribeRealtime(c, userId);
      this.unsubRepo = repo.subscribe(() => {
        if (this.applyingRemote) this.dirtyWhileApplying = true;
        else this.schedulePush();
      });
      this.started = true;
      this.setStatus("idle");
    } catch (err) {
      this.started = false;
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
    this.started = false;
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

  /** Run `fn` with local-echo suppression held only across the local writes
   *  themselves (never blob transfers), then flush any local change that
   *  notified meanwhile so it still schedules a push (M2). */
  private async suppressed(fn: () => Promise<void> | void): Promise<void> {
    this.applyingRemote = true;
    try {
      await fn();
    } finally {
      this.applyingRemote = false;
      if (this.dirtyWhileApplying) {
        this.dirtyWhileApplying = false;
        this.schedulePush();
      }
    }
  }

  // ---- push ---------------------------------------------------------------

  /** Consume repo's pending-delete log: tombstone each remote row (an UPDATE,
   *  so a never-pushed row is a no-op; the lww_guard trigger silently keeps
   *  rows a newer remote edit revived) and drop its storage objects. Entries
   *  whose remote call failed stay queued and retry on the next push. */
  private async pushDeletes(c: SupabaseClient): Promise<void> {
    const list =
      (await repo.getSetting<PendingDelete[]>(PENDING_DELETES_KEY)) ?? [];
    if (list.length === 0) return;
    const consumed: PendingDelete[] = [];
    for (const entry of list) {
      try {
        const { error } = await c
          .from(entry.table)
          .update({
            deleted_at: new Date(entry.at).toISOString(),
            updated_at: entry.at,
          })
          .eq("id", entry.id);
        if (error) throw new Error(error.message);
        if (entry.blobKeys.length > 0) {
          const paths = entry.blobKeys.map((k) => `${this.userId}/${k}`);
          const { error: se } = await c.storage.from(BLOB_BUCKET).remove(paths);
          if (se) throw new Error(se.message);
          for (const k of entry.blobKeys) this.uploaded.delete(k);
        }
        consumed.push(entry);
      } catch {
        // kept in kv for the next push
      }
    }
    if (consumed.length > 0) {
      // Re-read: deletes recorded while this loop ran must survive the prune.
      const current =
        (await repo.getSetting<PendingDelete[]>(PENDING_DELETES_KEY)) ?? [];
      await repo.setSetting(PENDING_DELETES_KEY, pruneConsumed(current, consumed));
      if (this.userId) {
        await repo.setSetting(uploadedBlobsKey(this.userId), [...this.uploaded]);
      }
    }
  }

  private async pushAll(c: SupabaseClient): Promise<void> {
    this.setStatus("syncing");
    // Tombstones go first — before an upsert could revive a deleted row.
    await this.pushDeletes(c);
    const conn = await db();
    const batches = await conn.getAll("batches");
    const receipts = await conn.getAll("receipts");
    const brands = await conn.getAll("brands");

    if (batches.length) {
      const { error } = await c
        .from("batches")
        .upsert(batches.map(batchToRow), { onConflict: "user_id,id" });
      if (error) throw new Error(`batches push: ${error.message}`);
    }
    if (receipts.length) {
      const { error } = await c
        .from("receipts")
        .upsert(receipts.map(receiptToRow), { onConflict: "user_id,id" });
      if (error) throw new Error(`receipts push: ${error.message}`);
    }
    if (brands.length) {
      const { error } = await c
        .from("brand_logos")
        .upsert(brands.map(brandToRow), { onConflict: "user_id,id" });
      if (error) throw new Error(`brands push: ${error.message}`);
    }

    // Upload referenced blobs not yet in storage.
    for (const r of receipts) {
      for (const key of [r.fileKey, r.cleanedKey, r.annotatedKey]) {
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
    if (this.userId) {
      await repo.setSetting(uploadedBlobsKey(this.userId), [...this.uploaded]);
    }
    this.setStatus("idle");
  }

  // ---- pull ---------------------------------------------------------------

  private async pullAll(c: SupabaseClient): Promise<void> {
    const [batches, receipts, brands] = await Promise.all([
      c.from("batches").select("payload, updated_at, deleted_at"),
      c.from("receipts").select("payload, updated_at, deleted_at"),
      c
        .from("brand_logos")
        .select("id, name, category, embedding, created_at, updated_at, deleted_at"),
    ]);
    if (batches.error) throw new Error(`batches pull: ${batches.error.message}`);
    if (receipts.error) throw new Error(`receipts pull: ${receipts.error.message}`);
    if (brands.error) throw new Error(`brands pull: ${brands.error.message}`);

    const conn = await db();
    const needBlobs: Receipt[] = [];
    await this.suppressed(async () => {
      for (const row of (batches.data ?? []) as Pick<
        BatchRow,
        "payload" | "updated_at" | "deleted_at"
      >[]) {
        const remote = row.payload;
        const local = await repo.getBatch(remote.id);
        const action = remoteAction(
          local?.updatedAt,
          Number(row.updated_at),
          row.deleted_at,
        );
        if (action === "apply") await conn.put("batches", remote);
        else if (action === "deleteLocal") await conn.delete("batches", remote.id);
      }
      for (const row of (receipts.data ?? []) as Pick<
        ReceiptRow,
        "payload" | "updated_at" | "deleted_at"
      >[]) {
        const remote = row.payload;
        const local = await repo.getReceipt(remote.id);
        const action = remoteAction(
          local?.updatedAt,
          Number(row.updated_at),
          row.deleted_at,
        );
        if (action === "apply") {
          await conn.put("receipts", remote);
          needBlobs.push(remote);
        } else if (action === "deleteLocal" && local) {
          await this.deleteLocalReceipt(conn, local);
        }
      }
      for (const row of (brands.data ?? []) as BrandRow[]) {
        const existing = await conn.get("brands", row.id);
        const action = remoteAction(
          existing?.createdAt,
          Number(row.updated_at ?? row.created_at),
          row.deleted_at,
        );
        if (action === "apply") {
          const brand: StoredBrand = {
            id: row.id,
            name: row.name,
            category: row.category as StoredBrand["category"],
            embedding: row.embedding,
            createdAt: row.created_at,
          };
          await conn.put("brands", brand);
        } else if (action === "deleteLocal") {
          await conn.delete("brands", row.id);
        }
      }
    });
    // Blob downloads run OUTSIDE the suppression window (M2): they take
    // multi-seconds and never notify, so a local edit meanwhile must still
    // schedule its push.
    for (const r of needBlobs) await this.ensureBlobs(c, r);
    // One notify for the whole merge (guarded, so it can't echo into a push).
    await this.suppressed(() => repo.externalChange());
    await repo.setSetting("sync.lastPullAt", Date.now());
  }

  /** Apply a remote tombstone locally: row, blobs, any queued job. Direct
   *  conn deletes — repo.deleteReceipt would record a fresh pending delete
   *  and echo the tombstone back with a newer timestamp. */
  private async deleteLocalReceipt(conn: Conn, r: Receipt): Promise<void> {
    for (const key of [r.fileKey, r.cleanedKey, r.annotatedKey]) {
      if (!key) continue;
      await conn.delete("blobs", key);
      this.uploaded.delete(key);
    }
    await conn.delete("receipts", r.id);
    const jobs = await conn.getAllFromIndex("jobs", "byReceipt", r.id);
    for (const j of jobs) await conn.delete("jobs", j.id);
  }

  /** Download any storage blobs a merged receipt references but we don't hold. */
  private async ensureBlobs(c: SupabaseClient, r: Receipt): Promise<void> {
    for (const key of [r.fileKey, r.cleanedKey, r.annotatedKey]) {
      if (!key) continue;
      if (await repo.getBlob(key)) continue;
      const path = `${this.userId}/${key}`;
      const { data, error } = await c.storage.from(BLOB_BUCKET).download(path);
      if (!error && data) {
        const kind =
          key === r.fileKey ? "original" : key === r.cleanedKey ? "cleaned" : "annotated";
        await repo.putBlob(data, kind, key);
        this.uploaded.add(key);
      }
    }
  }

  // ---- realtime -----------------------------------------------------------

  /** All three tables (H2: batches/brands used to stay stale all session).
   *  Tombstones arrive as UPDATE events (deleted_at set); hard DELETE events
   *  carry no payload and are ignored — this design never hard-deletes. */
  private subscribeRealtime(c: SupabaseClient, userId: string): void {
    const on = (table: string) => ({
      event: "*" as const,
      schema: "public",
      table,
      filter: `user_id=eq.${userId}`,
    });
    this.channel = c
      .channel("receipts-sync")
      .on("postgres_changes", on("receipts"), (payload) => {
        void this.applyRemoteReceipt(c, payload.new as ReceiptRow | null);
      })
      .on("postgres_changes", on("batches"), (payload) => {
        void this.applyRemoteBatch(payload.new as BatchRow | null);
      })
      .on("postgres_changes", on("brand_logos"), (payload) => {
        void this.applyRemoteBrand(payload.new as BrandRow | null);
      })
      .subscribe();
  }

  private async applyRemoteReceipt(
    c: SupabaseClient,
    row: ReceiptRow | null,
  ): Promise<void> {
    const remote = row?.payload;
    if (!row || !remote?.id) return;
    const local = await repo.getReceipt(remote.id);
    const action = remoteAction(
      local?.updatedAt,
      Number(row.updated_at),
      row.deleted_at,
    );
    if (action === "ignore") return; // our own echo / stale row
    const conn = await db();
    if (action === "deleteLocal") {
      await this.suppressed(async () => {
        if (local) await this.deleteLocalReceipt(conn, local);
        repo.externalChange();
      });
      return;
    }
    await this.suppressed(async () => {
      await conn.put("receipts", remote);
    });
    await this.ensureBlobs(c, remote); // outside suppression — multi-second
    await this.suppressed(() => repo.externalChange());
  }

  private async applyRemoteBatch(row: BatchRow | null): Promise<void> {
    const remote = row?.payload;
    if (!row || !remote?.id) return;
    const local = await repo.getBatch(remote.id);
    const action = remoteAction(
      local?.updatedAt,
      Number(row.updated_at),
      row.deleted_at,
    );
    if (action === "ignore") return;
    const conn = await db();
    await this.suppressed(async () => {
      if (action === "deleteLocal") await conn.delete("batches", remote.id);
      else await conn.put("batches", remote);
      repo.externalChange();
    });
  }

  private async applyRemoteBrand(row: BrandRow | null): Promise<void> {
    if (!row?.id) return;
    const conn = await db();
    const existing = await conn.get("brands", row.id);
    const action = remoteAction(
      existing?.createdAt,
      Number(row.updated_at ?? row.created_at),
      row.deleted_at,
    );
    if (action === "ignore") return;
    await this.suppressed(async () => {
      if (action === "deleteLocal") {
        await conn.delete("brands", row.id);
      } else {
        const brand: StoredBrand = {
          id: row.id,
          name: row.name,
          category: row.category as StoredBrand["category"],
          embedding: row.embedding,
          createdAt: row.created_at,
        };
        await conn.put("brands", brand);
      }
      repo.externalChange();
    });
  }
}

export const sync = new SyncEngine();
