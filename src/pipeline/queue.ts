import { repo } from "../store/repo.ts";
import { processReceipt } from "./pipeline.ts";
import { getOcrEngine } from "./ocr.ts";
import { PROCESSING } from "../config/constants.ts";
import { isAbortError } from "../util/abort.ts";

// The decoupled work-list (§4, §8). Extraction takes seconds per receipt; the
// user shouldn't wait on it. A small concurrency pool drains the `jobs` table,
// retries transient failures, and stays out of the UI thread (OCR runs in its
// own worker). At this scale a row in a table *is* the queue.

/** What the header and the reload bar need to know. */
export interface QueueProgress {
  /** Jobs in this browser's work-list — waiting, running or paused. */
  remaining: number;
  /** Runs in flight. While paused, these are the only work a reload strands. */
  running: number;
}

type ProgressListener = (p: QueueProgress) => void;

/** Everything the queue touches outside itself — the seam the Node tests
 *  (tests/queue.test.ts) fill with an in-memory work-list. */
export interface QueueDeps {
  jobs: Pick<
    typeof repo,
    "claimNextJob" | "touchJob" | "completeJob" | "retireJob" | "releaseJob" | "unclaimJob" | "pendingJobCount"
  >;
  process(receiptId: string, signal: AbortSignal): Promise<void>;
  /** Stop in-flight OCR at once (terminate the worker) — the pause. */
  stopOcr(): Promise<void>;
}

const appDeps: QueueDeps = {
  jobs: repo,
  process: (receiptId, signal) => processReceipt(receiptId, getOcrEngine(), signal),
  stopOcr: async () => {
    await getOcrEngine().interrupt?.();
  },
};

/** How long to wait before re-checking for jobs whose locks may have gone
 *  stale (a reload mid-run, a tab that died). */
const REWAKE_MS = 30_000;
/** Lock refresh while a job runs (repo.STALE_LOCK_MS is 90 s: four beats). */
const HEARTBEAT_MS = 20_000;

export class ProcessingQueue {
  private running = 0;
  /** fill() is a single runner: a wake that lands while one is already
   *  claiming sets `rewake` and the runner loops once more, instead of a
   *  second runner overlapping it. Two overlapping fills each checked the
   *  cap BEFORE their own `await claimNextJob()` and incremented after, so
   *  a drop that landed mid-drain ran concurrency + 1 receipts — a third
   *  2600 px canvas and OCR blob live at once on a phone. */
  private filling = false;
  private rewake = false;
  /** receiptId → the job id of the run reading it in this tab. Two runs of
   *  one receipt race each other's writes (the older claim's extraction is
   *  discarded, its blobs orphaned, the metered assist billed twice). */
  private inFlight = new Map<string, string>();
  private listeners = new Set<ProgressListener>();
  private rewakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Paused: nothing is claimed, and the runs in flight unwind at their next
   *  checkpoint. ONE controller is shared by every run — the pause is "stop
   *  everything", and terminating the shared OCR worker must never strand a
   *  sibling read whose own signal hadn't fired. Replaced on resume. */
  private paused = false;
  private controller = new AbortController();

  constructor(private readonly deps: QueueDeps = appDeps) {}

  get isPaused(): boolean {
    return this.paused;
  }

  onProgress(fn: ProgressListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async announce(): Promise<void> {
    const remaining = await this.deps.jobs.pendingJobCount();
    const p: QueueProgress = { remaining, running: this.running };
    for (const fn of this.listeners) fn(p);
  }

  /** Kick the pool. Safe to call repeatedly (e.g. after each enqueue) — and
   *  a no-op while paused (a drop still queues; it just waits). */
  async wake(): Promise<void> {
    return this.fill();
  }

  /** Halt reading: stop claiming, abort every run in flight (each unwinds
   *  to "queued" and gives its claim back — see run()) and free the CPU.
   *  A run already inside a metered AI call finishes and lands instead:
   *  that answer is billed, and re-reading on resume would bill it twice
   *  (the pipeline has no checkpoint once runVisionAssist starts, and only
   *  a free local/self-hosted call listens to the signal). */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    // Abort FIRST: every OCR wait is raced against this signal, so they all
    // settle before the worker they wait on is terminated below — a killed
    // tesseract job never settles on its own.
    this.controller.abort();
    if (this.rewakeTimer) {
      clearTimeout(this.rewakeTimer);
      this.rewakeTimer = null;
    }
    void this.deps.stopOcr().catch(() => {});
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.controller = new AbortController();
    void this.wake();
  }

  private async fill(): Promise<void> {
    if (this.filling) {
      this.rewake = true;
      return;
    }
    this.filling = true;
    try {
      do {
        this.rewake = false;
        while (!this.paused && this.running < PROCESSING.concurrency) {
          // Captured BEFORE the claim: a pause landing while the claim is
          // in flight must still reach the job it returns.
          const signal = this.controller.signal;
          const job = await this.deps.jobs.claimNextJob();
          if (!job) break;
          if (signal.aborted) {
            // Paused mid-claim — hand it straight back, attempt and all.
            await this.deps.jobs.unclaimJob(job.id);
            break;
          }
          const holder = this.inFlight.get(job.receiptId);
          if (holder !== undefined) {
            // Already being read here — never a second run beside it. A
            // DIFFERENT row is a duplicate job: drop it (the running read
            // owns the receipt, and its own row carries any retry or pause).
            // The run's OWN row, re-claimed because its lock looked stale,
            // is left as the claim re-locked it — deleting or unlocking it
            // would strand a paused run's receipt or invite another tab in.
            // Either way the row is no longer claimable, so this can't spin.
            if (holder !== job.id) await this.deps.jobs.completeJob(job.id);
            continue;
          }
          this.inFlight.set(job.receiptId, job.id);
          this.running++;
          void this.run(job.id, job.receiptId, job.attempts, signal);
        }
      } while (this.rewake);
      // Jobs remain but none was claimable: their locks belong to a run that
      // is gone (reload) or still heartbeating elsewhere. Look again shortly —
      // nothing else ever re-woke the pool, so those receipts stayed
      // "Reading…" until the next drop. Never armed while paused.
      if (
        !this.paused &&
        this.running === 0 &&
        !this.rewakeTimer &&
        (await this.deps.jobs.pendingJobCount()) > 0
      ) {
        this.rewakeTimer = setTimeout(() => {
          this.rewakeTimer = null;
          void this.wake();
        }, REWAKE_MS);
      }
    } finally {
      this.filling = false;
    }
    // Every wake and every run's end reports — the header's "Pausing…" and
    // the reload bar need `running` as it drops, not only after a finish.
    await this.announce().catch(() => {});
  }

  private async run(
    jobId: string,
    receiptId: string,
    attempts: number,
    signal: AbortSignal,
  ): Promise<void> {
    // Heartbeat the lock while the job runs — extraction routinely outlives
    // the stale window (model downloads, binarize rescue, vision), and a
    // stale-looking lock would let the pool claim the same job twice.
    const heartbeat = setInterval(() => void this.deps.jobs.touchJob(jobId), HEARTBEAT_MS);
    try {
      try {
        await this.deps.process(receiptId, signal);
      } finally {
        // Stopped as soon as the run settles, BEFORE the job is completed,
        // released or unclaimed: a tick landing during that write would
        // re-lock the row just handed back, hiding it from every claim for
        // the stale window after a resume.
        clearInterval(heartbeat);
      }
      // retire, not a blind delete: a Retry may have re-armed the row.
      await this.deps.jobs.retireJob(jobId);
    } catch (err) {
      if (signal.aborted && isAbortError(err)) {
        // Paused mid-read — not a failed attempt. processReceipt put the
        // receipt back to "queued"; give the claim (and its attempt) back.
        await this.deps.jobs.unclaimJob(jobId);
      } else if (attempts >= PROCESSING.maxAttempts) {
        // processReceipt already marked the receipt failed; retry a couple
        // times. Retired, not deleted: a Retry may already have re-armed it.
        await this.deps.jobs.retireJob(jobId);
      } else {
        await this.deps.jobs.releaseJob({ id: jobId, receiptId, attempts, lockedAt: null });
      }
    } finally {
      clearInterval(heartbeat);
      this.inFlight.delete(receiptId);
      this.running--;
      // Pull the next job if any remain — through the same single runner,
      // so this can never push the pool past its cap. It also announces.
      await this.fill().catch((err) => console.error("queue fill failed", err));
    }
  }
}

export const queue = new ProcessingQueue();
