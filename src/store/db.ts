import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Batch, Receipt, Job, StoredBlob, StoredBrand } from "../types.ts";

// IndexedDB is both the "file store" (original/derived image blobs) and the
// "results store" (= the board + export source). Keeping everything in one
// local database is the cheapest possible realization: $0 fixed, $0 marginal,
// nothing to host, and by default the user's receipts never leave the device.
// Signing in (Supabase, optional) mirrors this store to the cloud — it never
// replaces it.

interface ReimburseDB extends DBSchema {
  batches: {
    key: string;
    value: Batch;
    indexes: { byCreated: number };
  };
  receipts: {
    key: string;
    value: Receipt;
    indexes: { byBatch: string; byStatus: string; byHash: string };
  };
  jobs: {
    key: string;
    value: Job;
    indexes: { byReceipt: string };
  };
  blobs: {
    key: string;
    value: StoredBlob;
  };
  /** User-taught logo brands (zero-shot additions to the embedding index). */
  brands: {
    key: string;
    value: StoredBrand;
  };
  /** Small key/value settings (theme, sync cursors, opt-ins). */
  kv: {
    key: string;
    value: { key: string; value: unknown };
  };
}

const DB_NAME = "reimbursements-f5";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<ReimburseDB>> | null = null;

export function db(): Promise<IDBPDatabase<ReimburseDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ReimburseDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        const batches = database.createObjectStore("batches", {
          keyPath: "id",
        });
        batches.createIndex("byCreated", "createdAt");

        const receipts = database.createObjectStore("receipts", {
          keyPath: "id",
        });
        receipts.createIndex("byBatch", "batchId");
        receipts.createIndex("byStatus", "status");
        receipts.createIndex("byHash", "imageHash");

        const jobs = database.createObjectStore("jobs", { keyPath: "id" });
        jobs.createIndex("byReceipt", "receiptId");

        database.createObjectStore("blobs", { keyPath: "key" });
        database.createObjectStore("brands", { keyPath: "id" });
        database.createObjectStore("kv", { keyPath: "key" });
      },
    });
  }
  return dbPromise;
}

export type { ReimburseDB };
