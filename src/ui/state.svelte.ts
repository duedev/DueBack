import { repo } from "../store/repo.ts";
import { queue } from "../pipeline/queue.ts";
import { sync } from "../store/sync.ts";
import { syncConfigured } from "../supabase/client.ts";
import { onAuthChange, currentUser } from "../supabase/auth.ts";
import { saveVisionConfig } from "../pipeline/vision/config.ts";
import { validateFile, safeBasename } from "../util/files.ts";
import { uid } from "../util/id.ts";
import { LIMITS, CURRENCY_DEFAULT } from "../config/constants.ts";
import type { Batch, Receipt, ReceiptStatus } from "../types.ts";

// The one reactive bridge between the storage/pipeline layer (framework-free)
// and the Svelte UI. Components read `app.*` runes; every mutation goes through
// a method here, which delegates to the repo and lets the repo's subscription
// fan the change back into state.

export interface Toast {
  id: string;
  message: string;
  kind: "info" | "ok" | "warn" | "err";
}

const ACTIVE_BATCH_KEY = "activeBatchId";
const THEME_KEY = "theme";

export type ThemePref = "auto" | "light" | "dark";

class AppState {
  booting = $state(true);
  /** True once the user has entered the workspace (or has receipts already). */
  entered = $state(false);

  batch = $state<Batch | null>(null);
  receipts = $state<Receipt[]>([]);
  pendingJobs = $state(0);
  toasts = $state<Toast[]>([]);
  theme = $state<ThemePref>("auto");

  /** Receipt currently open in the review modal (id), if any. */
  reviewId = $state<string | null>(null);
  settingsOpen = $state(false);

  /** Signed-in Supabase user (null when signed out or sync unconfigured). */
  userEmail = $state<string | null>(null);
  syncStatus = $state<"off" | "syncing" | "idle" | "error">("off");
  readonly syncConfigured = syncConfigured();

  counts = $derived.by(() => {
    const c: Record<ReceiptStatus, number> = {
      queued: 0,
      processing: 0,
      done: 0,
      needs_review: 0,
      failed: 0,
    };
    for (const r of this.receipts) c[r.status]++;
    return c;
  });

  showWorkspace = $derived(this.entered || this.receipts.length > 0);

  /** Object URLs for stored blobs, keyed by blob key (revoked on refresh). */
  private urlCache = new Map<string, string>();

  async init(): Promise<void> {
    // Theme first so there's no flash.
    const saved = localStorage.getItem(THEME_KEY) as ThemePref | null;
    this.applyTheme(saved ?? "auto");

    let batchId = await repo.getSetting<string>(ACTIVE_BATCH_KEY);
    let batch = batchId ? await repo.getBatch(batchId) : undefined;
    if (!batch) {
      batch = await repo.createBatch({ employee: "", jobName: "", jobNumber: "" });
      await repo.setSetting(ACTIVE_BATCH_KEY, batch.id);
    }
    this.batch = batch;

    repo.subscribe(() => void this.refresh());
    queue.onProgress((remaining) => {
      this.pendingJobs = remaining;
    });

    await this.refresh();
    if (this.receipts.length > 0) this.entered = true;
    this.booting = false;
    // Resume any work left over from a previous visit.
    void queue.wake();

    // Optional cloud sync: mirror the local store when signed in.
    if (this.syncConfigured) {
      sync.onStatus((s) => {
        this.syncStatus = s;
      });
      const boot = await currentUser();
      if (boot) void this.onSignedIn(boot.id, boot.email ?? "");
      onAuthChange(({ user }) => {
        if (user) void this.onSignedIn(user.id, user.email ?? "");
        else {
          this.userEmail = null;
          sync.stop();
        }
      });
    }
  }

  private async onSignedIn(userId: string, email: string): Promise<void> {
    this.userEmail = email || "signed in";
    // First sign-in on this device: turn the server-keyed AI assist on once
    // (the user can switch it off in Settings; we never flip it again).
    const flag = await repo.getSetting<boolean>("ai.autoEnabledOnSignIn");
    if (!flag) {
      saveVisionConfig({ enabled: true });
      await repo.setSetting("ai.autoEnabledOnSignIn", true);
    }
    await sync.start(userId);
  }

  async refresh(): Promise<void> {
    if (!this.batch) return;
    this.receipts = await repo.listReceipts(this.batch.id);
    const fresh = await repo.getBatch(this.batch.id);
    if (fresh) this.batch = fresh;
  }

  enter(): void {
    this.entered = true;
  }

  applyTheme(pref: ThemePref): void {
    this.theme = pref;
    const root = document.documentElement;
    if (pref === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", pref);
    localStorage.setItem(THEME_KEY, pref);
  }

  toggleTheme(): void {
    const dark =
      this.theme === "dark" ||
      (this.theme === "auto" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    this.applyTheme(dark ? "light" : "dark");
  }

  toast(message: string, kind: Toast["kind"] = "info"): void {
    const t: Toast = { id: uid("toast"), message, kind };
    this.toasts = [...this.toasts, t];
    setTimeout(() => {
      this.toasts = this.toasts.filter((x) => x.id !== t.id);
    }, 4200);
  }

  /** Validate, store, and enqueue a set of dropped/picked files. */
  async addFiles(files: Iterable<File>): Promise<void> {
    if (!this.batch) return;
    this.entered = true;
    const existing = this.receipts.length;
    let accepted = 0;
    for (const file of files) {
      if (existing + accepted >= LIMITS.maxReceiptsPerBatch) {
        this.toast(
          `Batch cap reached (${LIMITS.maxReceiptsPerBatch} receipts).`,
          "warn",
        );
        break;
      }
      const check = validateFile(file);
      if (!check.ok) {
        this.toast(`Skipped ${safeBasename(file.name)}: ${check.reason}`, "warn");
        continue;
      }
      const fileKey = await repo.putBlob(file, "original");
      const now = Date.now();
      const receipt: Receipt = {
        id: uid("rcpt"),
        batchId: this.batch.id,
        fileKey,
        fileName: safeBasename(file.name),
        mimeType: file.type || "application/octet-stream",
        status: "queued",
        vendor: { value: "", confidence: 0 },
        date: { value: "", confidence: 0 },
        amount: { value: 0, confidence: 0 },
        tax: { value: 0, confidence: 0 },
        currency: CURRENCY_DEFAULT,
        category: { value: "Other", confidence: 0 },
        confidence: 0,
        flags: [],
        methodUsed: "rules",
        cost: 0,
        approved: false,
        reviewRequired: false,
        createdAt: now,
        updatedAt: now,
      };
      await repo.putReceipt(receipt);
      await repo.enqueue(receipt.id);
      accepted++;
    }
    if (accepted > 0) {
      this.toast(
        accepted === 1 ? "1 receipt queued." : `${accepted} receipts queued.`,
        "ok",
      );
      void queue.wake();
    }
  }

  /** Object URL for a stored blob (cached; stable across re-renders). */
  async blobUrl(key: string | undefined): Promise<string | null> {
    if (!key) return null;
    const hit = this.urlCache.get(key);
    if (hit) return hit;
    const blob = await repo.getBlob(key);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.urlCache.set(key, url);
    return url;
  }

  async deleteReceipt(id: string): Promise<void> {
    await repo.deleteReceipt(id);
    this.toast("Receipt removed.", "info");
  }
}

export const app = new AppState();
