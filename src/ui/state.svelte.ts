import { repo } from "../store/repo.ts";
import { queue } from "../pipeline/queue.ts";
import { sync } from "../store/sync.ts";
import { syncConfigured } from "../supabase/client.ts";
import { onAuthChange, currentUser } from "../supabase/auth.ts";
import { saveVisionConfig } from "../pipeline/vision/config.ts";
import { validateFile, safeBasename, isPdf, isZip } from "../util/files.ts";
import { chooseAdoptionBatch, type AdoptionCandidate } from "../store/syncMerge.ts";
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
  /** The OS scheme, tracked live — "auto" follows it, and the toggle's icon
   *  used to go stale when the OS flipped while the page was open. */
  osDark = $state(false);
  isDark = $derived(this.theme === "dark" || (this.theme === "auto" && this.osDark));

  /** Receipt ids whose job lives in THIS browser's work-list. A queued or
   *  processing receipt without one arrived through sync and is being read
   *  on another device — the card says so instead of "Reading on your
   *  device…", which nothing here was doing. */
  localJobIds = $state(new Set<string>());
  /** Receipt currently open in the review modal (id), if any. */
  reviewId = $state<string | null>(null);
  settingsOpen = $state(false);

  /** Boot could not open IndexedDB (a storage-blocked embed, some private
   *  modes): the landing shows it and every add explains itself with it. */
  storageError = $state<string | null>(null);
  /** A new build is installed and waiting; calling this reloads into it. */
  updateReady = $state<null | (() => void)>(null);
  /** Signed-in Supabase user (null when signed out or sync unconfigured). */
  userEmail = $state<string | null>(null);
  syncStatus = $state<"off" | "syncing" | "idle" | "error">("off");
  /** The engine's last error message (shown in Settings and on the chip). */
  syncError = $state("");
  /** Sync refused because this device's data belongs to another account. */
  syncForeign = $state(false);
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

  /** True after the user explicitly navigated back to the landing page. */
  wentHome = $state(false);

  showWorkspace = $derived(
    !this.wentHome && (this.entered || this.receipts.length > 0),
  );

  /** Object URLs for stored blobs, keyed by blob key. Revoked when the
   *  receipt that owns them is deleted — they otherwise pinned every
   *  thumbnail's blob for the life of the tab. */
  private urlCache = new Map<string, string>();

  private revokeBlobUrls(r: Receipt): void {
    for (const key of [r.fileKey, r.cleanedKey, r.annotatedKey]) {
      if (!key) continue;
      const url = this.urlCache.get(key);
      if (!url) continue;
      this.urlCache.delete(key);
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* already gone */
      }
    }
  }

  async init(): Promise<void> {
    try {
      await this.boot();
    } catch (err) {
      // Storage refused (blocked third-party IndexedDB in an embed, private
      // mode, …): the splash must still clear so the landing page renders.
      console.error("init failed", err);
      this.storageError =
        "Couldn't open this browser's storage, so receipts can't be saved here. Open dueback.duanehamilton.net directly, or allow site data for it.";
      this.toast(this.storageError, "err");
    } finally {
      this.booting = false;
    }
  }

  private async boot(): Promise<void> {
    // Theme first so there's no flash. localStorage can throw in a
    // storage-blocked iframe (the Carrd embed) — fall back to "auto".
    let saved: ThemePref | null = null;
    try {
      saved = localStorage.getItem(THEME_KEY) as ThemePref | null;
    } catch {
      // storage blocked
    }
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      this.osDark = mq.matches;
      mq.addEventListener("change", (e) => {
        this.osDark = e.matches;
      });
    }
    this.applyTheme(saved ?? "auto");

    let batchId = await repo.getSetting<string>(ACTIVE_BATCH_KEY);
    let batch = batchId ? await repo.getBatch(batchId) : undefined;
    if (!batch) {
      batch = await repo.createBatch({ employee: "", jobName: "", jobNumber: "" });
      await repo.setSetting(ACTIVE_BATCH_KEY, batch.id);
    }
    this.batch = batch;

    repo.subscribe(() => this.scheduleRefresh());
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
        this.syncError = sync.lastError;
        this.syncForeign = sync.foreignOwner;
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
    // Adopt a synced batch only when this call actually started the engine
    // (its initial pull just ran). Auth fires this for every TOKEN_REFRESHED
    // too — hourly, and on tab focus — and re-running adoption then repointed
    // an intentionally fresh empty batch at the last non-empty one.
    if (await sync.start(userId)) await this.maybeAdoptSyncedBatch();
  }

  /** A fresh device pins a brand-new empty batch before sync runs, so pulled
   *  receipts would otherwise live in a batch the UI never shows. After the
   *  initial pull, adopt the most recently updated batch that has receipts —
   *  never stealing an active batch that already has its own. */
  private async maybeAdoptSyncedBatch(): Promise<void> {
    if (sync.status === "off" || sync.status === "error") return; // no pull ran
    const candidates: AdoptionCandidate[] = [];
    for (const b of await repo.listBatches()) {
      candidates.push({
        id: b.id,
        updatedAt: b.updatedAt,
        receiptCount: (await repo.listReceipts(b.id)).length,
      });
    }
    const adoptId = chooseAdoptionBatch(this.batch?.id ?? null, candidates);
    if (!adoptId) return;
    const batch = await repo.getBatch(adoptId);
    if (!batch) return;
    await repo.setSetting(ACTIVE_BATCH_KEY, batch.id);
    this.batch = batch;
    await this.refresh();
    if (this.receipts.length > 0) this.entered = true;
  }

  /** Coalesce bursts of repo notifications into one board read. Every
   *  pipeline write, every one of a clear-all's 200 deletes and every synced
   *  row notified, and each notification re-read and re-deserialized the
   *  whole batch — O(N²) over a batch run. */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 40);
  }

  async refresh(): Promise<void> {
    if (!this.batch) return;
    this.receipts = await repo.listReceipts(this.batch.id);
    // Drop object URLs for blobs no receipt on the board references any
    // more (deleted, re-baked by a review save, replaced by sync) — the
    // cache only ever grew and pinned every stale Blob for the tab's life.
    const live = new Set(
      this.receipts.flatMap((r) =>
        [r.fileKey, r.cleanedKey, r.annotatedKey].filter((k): k is string => !!k),
      ),
    );
    for (const [key, url] of this.urlCache) {
      if (live.has(key)) continue;
      this.urlCache.delete(key);
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* already gone */
      }
    }
    // Receipts first, then jobs: a receipt and its job land in one
    // transaction, so this order can only ever see a job for a receipt
    // already listed — never a listed receipt whose job is still coming.
    this.localJobIds = new Set(await repo.listJobReceiptIds());
    const fresh = await repo.getBatch(this.batch.id);
    if (fresh) this.batch = fresh;
  }

  enter(): void {
    this.entered = true;
    this.wentHome = false;
  }

  /** Navigate back to the landing page (receipts stay put). */
  goHome(): void {
    // The workspace owns #process; hand the URL back to the landing BEFORE
    // the surface swap renders, so the landing's hash router can't read the
    // stale workspace hash and bounce straight back in.
    if (location.hash.replace(/^#\/?/, "") === "process") {
      history.replaceState(null, "", location.pathname + location.search + "#home");
    }
    this.wentHome = true;
  }

  /** Delete every receipt on the board. Immediate — no dialog; the action is
   *  explicit enough and a blocking confirm popup was unwanted friction. */
  async clearAll(): Promise<void> {
    const ids = this.receipts.map((r) => r.id);
    for (const r of this.receipts) this.revokeBlobUrls(r);
    for (const id of ids) await repo.deleteReceipt(id);
    this.toast(
      ids.length === 0
        ? "Nothing to delete."
        : ids.length === 1
          ? "Deleted 1 receipt."
          : `Deleted ${ids.length} receipts.`,
      "info",
    );
  }

  /** Re-queue a failed receipt for a fresh read — the text reader may have
   *  failed to start, the network may be back. Never touches an approved
   *  receipt (a human's work outranks a retry) and re-runs the same intake
   *  path as addFiles, so the pipeline's completion write lands a full
   *  extraction: the retry's updatedAt precedes the claim. Fields a human
   *  already edited stay theirs (`touchedBeforeClaim`). */
  async retryReceipt(id: string): Promise<boolean> {
    const r = await repo.getReceipt(id);
    if (!r || r.status !== "failed" || r.approved) return false;
    await repo.updateReceipt(id, {
      status: "queued",
      error: undefined,
      flags: [],
      reviewRequired: false,
    });
    await repo.enqueue(id);
    void queue.wake();
    return true;
  }

  /** Retry every failed receipt on the board. */
  async retryFailed(): Promise<void> {
    let n = 0;
    for (const r of this.receipts) {
      if (r.status === "failed" && (await this.retryReceipt(r.id))) n++;
    }
    this.toast(
      n === 0 ? "Nothing to retry." : n === 1 ? "Reading 1 receipt again." : `Reading ${n} receipts again.`,
      "info",
    );
  }

  /** Wipe every receipt, batch, job, blob, taught brand and queued delete on
   *  THIS device — the way out of the foreign-owner sync block (another
   *  account's data is here) without pushing tombstones for rows that were
   *  never this account's. Starts over on a fresh empty batch and, when
   *  signed in, lets sync adopt it. */
  async resetLocalCopy(): Promise<void> {
    for (const r of this.receipts) this.revokeBlobUrls(r);
    this.reviewId = null;
    await repo.wipeLocalData();
    const batch = await repo.createBatch({ employee: "", jobName: "", jobNumber: "" });
    await repo.setSetting(ACTIVE_BATCH_KEY, batch.id);
    this.batch = batch;
    await this.refresh();
    this.toast("This device's local copy was removed.", "info");
    const user = await currentUser();
    if (user && (await sync.start(user.id))) await this.maybeAdoptSyncedBatch();
  }

  applyTheme(pref: ThemePref): void {
    this.theme = pref;
    const root = document.documentElement;
    if (pref === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", pref);
    try {
      localStorage.setItem(THEME_KEY, pref);
    } catch {
      // storage blocked — the choice just won't stick
    }
    // Browser/PWA chrome color follows the surface. index.html carries two
    // media-scoped theme-color tags (values = each theme's --bg) that cover
    // "auto"; an explicit choice must override both, since the media query
    // tracks the OS, not data-theme.
    const bg: Record<"light" | "dark", string> = {
      light: "#f7f5f1",
      dark: "#12100e",
    };
    for (const m of document.querySelectorAll<HTMLMetaElement>(
      'meta[name="theme-color"]',
    )) {
      const scheme = m.media.includes("light") ? "light" : "dark";
      m.content = bg[pref === "auto" ? scheme : pref];
    }
  }

  /** The header button flips between light and dark; "auto" (follow the OS)
   *  is reachable from Settings → Appearance. */
  toggleTheme(): void {
    this.applyTheme(this.isDark ? "light" : "dark");
  }

  toast(message: string, kind: Toast["kind"] = "info"): void {
    const t: Toast = { id: uid("toast"), message, kind };
    // A drop of twenty rejected files used to stack twenty toasts down the
    // page; keep the newest few. Errors stay long enough to be read.
    this.toasts = [...this.toasts, t].slice(-5);
    setTimeout(
      () => {
        this.toasts = this.toasts.filter((x) => x.id !== t.id);
      },
      kind === "err" ? 8000 : 4200,
    );
  }

  /** Validate, store, and enqueue a set of dropped/picked files. Two inputs
   *  are *stacks* of receipts rather than single ones and are expanded here:
   *  a multi-page PDF (scanner output) becomes one receipt per page, and a
   *  ZIP becomes one receipt per usable entry, however deeply the archive
   *  nests its folders. Processing only page 1 / ignoring the archive
   *  silently dropped the rest. */
  addFiles(files: Iterable<File>): Promise<void> {
    if (!this.batch) {
      // Boot couldn't open storage; the toast it showed is long gone by the
      // time the user drops files, so say it again here.
      this.toast(
        this.storageError ?? "Storage is unavailable in this browser, so receipts can't be added.",
        "err",
      );
      return Promise.resolve();
    }
    this.entered = true;
    this.wentHome = false;
    // Snapshot NOW: a drop hands over the live dataTransfer.files, which
    // empties once the event is over (the picker's FileList has the same
    // trap) — iterating it after waiting on an earlier intake lost files.
    const list = Array.from(files);
    // Serialized: two overlapping intakes (a drop while a ZIP is still
    // unpacking) each counted the batch from the same stale board and
    // together overshot the cap.
    const run = this.intake.then(() => this.addFilesNow(list));
    this.intake = run.catch(() => {});
    return run;
  }

  private intake: Promise<void> = Promise.resolve();

  private async addFilesNow(files: File[]): Promise<void> {
    // The store's count, not the reactive array's: the board lags the
    // async refresh, and the previous intake's receipts may not be in it yet.
    const existing = (await repo.listReceipts(this.batch!.id)).length;
    let accepted = 0;
    let capped = false;

    const atCap = (): boolean => {
      if (existing + accepted < LIMITS.maxReceiptsPerBatch) return false;
      if (!capped) {
        capped = true;
        this.toast(
          `Batch cap reached (${LIMITS.maxReceiptsPerBatch} receipts).`,
          "warn",
        );
      }
      return true;
    };

    const enqueueOne = async (
      blob: Blob,
      fileName: string,
      mimeType: string,
      originalFileName?: string,
    ): Promise<void> => {
      const now = Date.now();
      const receipt: Receipt = {
        id: uid("rcpt"),
        batchId: this.batch!.id,
        fileKey: uid("blob"),
        fileName,
        originalFileName,
        mimeType,
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
      // Blob, row and job in one transaction — all or nothing.
      await repo.addReceipt(receipt, blob);
      accepted++;
    };

    // `label` is how this file should read on the card: for a file the user
    // picked that is just its name, but for something unpacked from an
    // archive it is the path inside it ("trip.zip › march/tesla_12.pdf"),
    // which is often the only thing telling twelve "receipt.pdf" files apart.
    const addOne = async (
      file: File,
      depth: number,
      label?: string,
    ): Promise<void> => {
      const shown = label ?? safeBasename(file.name);
      const check = validateFile(file);
      if (!check.ok) {
        this.toast(`Skipped ${shown}: ${check.reason}`, "warn");
        return;
      }

      if (isZip(file)) {
        await addArchive(file, depth, shown);
        return;
      }

      if (isPdf(file)) {
        let pages: import("../pipeline/pdf.ts").PdfPageImage[] = [];
        let failedPages: number[] = [];
        try {
          const { expandPdf } = await import("../pipeline/pdf.ts");
          // Only render pages the batch still has room for — rasterizing a
          // 1000-page statement the cap would discard anyway OOMs the tab.
          const out = await expandPdf(
            file,
            LIMITS.maxReceiptsPerBatch - (existing + accepted),
          );
          pages = out.pages;
          failedPages = out.failedPages;
        } catch (err) {
          const { isPasswordProtectedPdf } = await import("../pipeline/pdf.ts");
          if (isPasswordProtectedPdf(err)) {
            // Queuing it would only produce a guaranteed failure with pdf.js
            // internals as the message.
            this.toast(
              `Skipped ${shown}: this PDF is password-protected — remove the password and add it again.`,
              "warn",
            );
            return;
          }
          // Unreadable/odd PDF: store it as-is — the pipeline still decodes
          // the first page (the pre-expansion behavior).
          pages = [];
        }
        if (pages.length > 0) {
          const { pdfPageNames } = await import("../pipeline/pdf.ts");
          const base = safeBasename(file.name);
          for (const p of pages) {
            if (atCap()) break;
            const names = pdfPageNames(base, p.pageNumber, p.pageCount, shown);
            await enqueueOne(p.blob, names.fileName, "image/jpeg", names.originalFileName);
          }
          const pageCount = pages[0]!.pageCount;
          if (failedPages.length > 0) {
            this.toast(
              failedPages.length === 1
                ? `${shown}: page ${failedPages[0]} couldn't be rendered and was skipped.`
                : `${shown}: ${failedPages.length} pages couldn't be rendered and were skipped.`,
              "warn",
            );
          }
          if (pages.length + failedPages.length < pageCount) {
            this.toast(
              `${shown}: only the first ${pages.length} of ${pageCount} pages were read.`,
              "warn",
            );
          } else if (pages.length > 1) {
            this.toast(
              `${shown}: ${pages.length} pages, one receipt each.`,
              "info",
            );
          }
          return;
        }
      }

      await enqueueOne(
        file,
        safeBasename(file.name),
        file.type || "application/octet-stream",
        label,
      );
    };

    /** Unpack a ZIP and feed every usable entry back through `addOne`, so an
     *  archived PDF still expands per page and an archived ZIP still opens. */
    const addArchive = async (
      file: File,
      depth: number,
      label: string,
    ): Promise<void> => {
      if (depth >= LIMITS.maxArchiveDepth) {
        this.toast(`Skipped ${label}: archives nested too deep.`, "warn");
        return;
      }
      const unzip = await import("../pipeline/unzip.ts");
      let result: import("../pipeline/unzip.ts").ZipReadResult;
      try {
        result = await unzip.readZip(await file.arrayBuffer(), {
          extensions: LIMITS.acceptedExtensions,
          maxEntryBytes: LIMITS.maxFileBytes,
          maxEntries: LIMITS.maxArchiveEntries,
          maxTotalBytes: LIMITS.maxArchiveInflatedBytes,
        });
      } catch {
        this.toast(`Skipped ${label}: not a readable ZIP.`, "warn");
        return;
      }
      if (result.entries.length === 0) {
        this.toast(`${label}: no receipts inside.`, "warn");
        return;
      }
      // Central-directory order is whatever the archiver used; folder order
      // is what the user expects to see the receipts arrive in.
      const entries = [...result.entries].sort((a, b) =>
        a.path.localeCompare(b.path, undefined, { numeric: true }),
      );
      const before = accepted;
      for (const entry of entries) {
        if (atCap()) break;
        const names = unzip.archiveEntryName(label, entry.path);
        const mime = unzip.mimeForPath(entry.path);
        const inner = new File([entry.data as BlobPart], names.fileName, {
          type: mime,
        });
        await addOne(inner, depth + 1, names.originalFileName);
      }
      const found = accepted - before;
      this.toast(
        found === 1
          ? `${label}: 1 receipt found.`
          : `${label}: ${found} receipts found.`,
        found > 0 ? "info" : "warn",
      );
      if (result.skipped.length > 0) {
        this.toast(
          `${label}: skipped ${result.skipped.length} non-receipt ${
            result.skipped.length === 1 ? "file" : "files"
          }.`,
          "info",
        );
      }
      if (result.truncated) {
        this.toast(
          `${label}: only the first ${LIMITS.maxArchiveEntries} files were read.`,
          "warn",
        );
      }
    };

    let failed = 0;
    for (const file of files) {
      if (atCap()) break;
      try {
        await addOne(file, 0);
      } catch (err) {
        // One file failing to store (quota, IO) must not drop the rest.
        failed++;
        console.error("addFiles failed", err);
        this.toast(`Couldn't add ${safeBasename(file.name)}: storage error.`, "err");
      }
    }

    if (accepted > 0) {
      this.toast(
        accepted === 1 ? "1 receipt queued." : `${accepted} receipts queued.`,
        "ok",
      );
      void queue.wake();
    } else if (failed > 0) {
      this.toast("No files could be added — storage may be full.", "err");
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
    const r = this.receipts.find((x) => x.id === id);
    if (r) this.revokeBlobUrls(r);
    await repo.deleteReceipt(id);
    this.toast("Receipt removed.", "info");
  }
}

export const app = new AppState();
