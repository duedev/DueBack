import { repo } from "../store/repo.ts";
import { processReceipt } from "./pipeline.ts";
import { getOcrEngine } from "./ocr.ts";
import { PROCESSING } from "../config/constants.ts";

// The decoupled work-list (§4, §8). Extraction takes seconds per receipt; the
// user shouldn't wait on it. A small concurrency pool drains the `jobs` table,
// retries transient failures, and stays out of the UI thread (OCR runs in its
// own worker). At this scale a row in a table *is* the queue.

type ProgressListener = (remaining: number) => void;

/** How long to wait before re-checking for jobs whose locks may have gone
 *  stale (a reload mid-run, a tab that died). */
const REWAKE_MS = 30_000;

class ProcessingQueue {
  private running = 0;
  /** fill() is a single runner: a wake that lands while one is already
   *  claiming sets `rewake` and the runner loops once more, instead of a
   *  second runner overlapping it. Two overlapping fills each checked the
   *  cap BEFORE their own `await claimNextJob()` and incremented after, so
   *  a drop that landed mid-drain ran concurrency + 1 receipts — a third
   *  2600 px canvas and OCR blob live at once on a phone. */
  private filling = false;
  private rewake = false;
  private listeners = new Set<ProgressListener>();
  private rewakeTimer: ReturnType<typeof setTimeout> | null = null;

  onProgress(fn: ProgressListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async announce(): Promise<void> {
    const remaining = await repo.pendingJobCount();
    for (const fn of this.listeners) fn(remaining);
  }

  /** Kick the pool. Safe to call repeatedly (e.g. after each enqueue). */
  async wake(): Promise<void> {
    return this.fill();
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
        while (this.running < PROCESSING.concurrency) {
          const job = await repo.claimNextJob();
          if (!job) break;
          this.running++;
          void this.run(job.id, job.receiptId, job.attempts);
        }
      } while (this.rewake);
      // Jobs remain but none was claimable: their locks belong to a run that
      // is gone (reload) or still heartbeating elsewhere. Look again shortly —
      // nothing else ever re-woke the pool, so those receipts stayed
      // "Reading…" until the next drop.
      if (this.running === 0 && !this.rewakeTimer && (await repo.pendingJobCount()) > 0) {
        this.rewakeTimer = setTimeout(() => {
          this.rewakeTimer = null;
          void this.wake();
        }, REWAKE_MS);
      }
    } finally {
      this.filling = false;
    }
  }

  private async run(
    jobId: string,
    receiptId: string,
    attempts: number,
  ): Promise<void> {
    // Heartbeat the lock while the job runs — extraction routinely outlives
    // the stale window (model downloads, binarize rescue, vision), and a
    // stale-looking lock would let the pool claim the same job twice.
    const heartbeat = setInterval(() => void repo.touchJob(jobId), 20_000);
    try {
      await processReceipt(receiptId, getOcrEngine());
      await repo.completeJob(jobId);
    } catch {
      // processReceipt already marked the receipt failed; retry a couple times.
      if (attempts >= PROCESSING.maxAttempts) {
        await repo.completeJob(jobId);
      } else {
        await repo.releaseJob({ id: jobId, receiptId, attempts, lockedAt: null });
      }
    } finally {
      clearInterval(heartbeat);
      this.running--;
      await this.announce();
      // Pull the next job if any remain — through the same single runner,
      // so this can never push the pool past its cap.
      await this.fill().catch((err) => console.error("queue fill failed", err));
    }
  }
}

export const queue = new ProcessingQueue();
