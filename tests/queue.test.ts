import { test } from "node:test";
import assert from "node:assert/strict";
import { ProcessingQueue, type QueueDeps, type QueueProgress } from "../src/pipeline/queue.ts";
import { jobRows, STALE_LOCK_MS } from "../src/store/repo.ts";
import { abortError } from "../src/util/abort.ts";
import { PROCESSING } from "../src/config/constants.ts";
import type { Job } from "../src/types.ts";

// The reading pause (pipeline/queue.ts): pause() stops claiming and unwinds
// every run in flight back to its claim — lock AND attempt returned, never a
// failure — and resume() picks the work up again in upload order. The queue
// runs against an in-memory work-list driven by the repo's own row rules
// (`jobRows`), since there is no IndexedDB under Node.

const flush = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

const NOW = 1_000_000;

type Jobs = QueueDeps["jobs"];

class FakeJobs implements Jobs {
  rows = new Map<string, Job>();
  log: string[] = [];
  claimCalls = 0;
  /** Every fill reads the count (the re-wake check, the announce): a proxy
   *  for "the pool woke". */
  countCalls = 0;
  /** Holds the next claim open (a pause landing mid-claim). */
  claimGate: Promise<void> | null = null;
  /** Delays unclaim's acknowledgement AFTER its write, like a transaction
   *  still committing — the window a stray heartbeat used to land in. */
  unclaimGate: Promise<void> | null = null;

  constructor(ids: string[]) {
    ids.forEach((id, i) =>
      this.rows.set(id, { id, receiptId: id, attempts: 0, lockedAt: null, createdAt: i + 1 }),
    );
  }

  async claimNextJob(): Promise<Job | null> {
    this.claimCalls++;
    if (this.claimGate) await this.claimGate;
    const next = jobRows.nextClaim([...this.rows.values()], NOW, STALE_LOCK_MS);
    if (!next) return null;
    const claimed = jobRows.claimed(next, NOW);
    this.rows.set(claimed.id, claimed);
    this.log.push(`claim ${claimed.id}`);
    return claimed;
  }
  async touchJob(id: string): Promise<void> {
    this.log.push(`touch ${id}`);
    const cur = this.rows.get(id);
    const touched = cur ? jobRows.touched(cur, NOW + 1) : null;
    if (touched) this.rows.set(id, touched);
  }
  async completeJob(id: string): Promise<void> {
    this.log.push(`complete ${id}`);
    this.rows.delete(id);
  }
  async releaseJob(job: Job): Promise<void> {
    this.log.push(`release ${job.id}`);
    const cur = this.rows.get(job.id);
    if (cur) this.rows.set(job.id, jobRows.released(cur, job.attempts));
  }
  async unclaimJob(id: string): Promise<void> {
    this.log.push(`unclaim ${id}`);
    const cur = this.rows.get(id);
    if (cur) this.rows.set(id, jobRows.unclaimed(cur));
    if (this.unclaimGate) await this.unclaimGate;
  }
  async pendingJobCount(): Promise<number> {
    this.countCalls++;
    return this.rows.size;
  }
}

interface Run {
  id: string;
  resolve(): void;
  reject(err: Error): void;
  /** A run past its last checkpoint (inside a metered AI call) ignores the
   *  pause and finishes. */
  ignorePause: boolean;
}

function harness(ids: string[]) {
  const jobs = new FakeJobs(ids);
  const runs: Run[] = [];
  const progress: QueueProgress[] = [];
  let stopOcrCalls = 0;
  const deps: QueueDeps = {
    jobs,
    process: (id, signal) =>
      new Promise<void>((resolve, reject) => {
        const run: Run = { id, resolve, reject, ignorePause: false };
        runs.push(run);
        // Like a pipeline checkpoint: the pause unwinds the run.
        signal.addEventListener(
          "abort",
          () => {
            if (!run.ignorePause) reject(abortError());
          },
          { once: true },
        );
      }),
    stopOcr: async () => {
      stopOcrCalls++;
    },
  };
  const q = new ProcessingQueue(deps);
  q.onProgress((p) => progress.push(p));
  return {
    q,
    jobs,
    runs,
    progress,
    stopOcrCalls: () => stopOcrCalls,
    /** The newest run for a receipt (a resumed receipt runs again). */
    live: (id: string): Run => runs.filter((r) => r.id === id).at(-1)!,
  };
}

test("pause unwinds every read in flight to its claim — lock and attempt returned — and resume re-reads in upload order", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  assert.equal(PROCESSING.concurrency, 2, "the case below assumes two slots");
  const h = harness(["a", "b", "c"]);
  await h.q.wake();
  await flush();
  assert.deepEqual(h.runs.map((r) => r.id), ["a", "b"]);

  h.q.pause();
  await flush();
  assert.equal(h.q.isPaused, true);
  assert.deepEqual(h.jobs.log, ["claim a", "claim b", "unclaim a", "unclaim b"]);
  for (const job of h.jobs.rows.values()) {
    assert.equal(job.lockedAt, null, `${job.id} unlocked`);
    assert.equal(job.attempts, 0, `${job.id} kept its attempts`);
  }
  assert.equal(h.stopOcrCalls(), 1, "the OCR worker is stopped once");
  assert.deepEqual(h.progress.at(-1), { remaining: 3, running: 0 });

  // A drop while paused queues but never starts.
  await h.q.wake();
  await flush();
  assert.equal(h.runs.length, 2);

  h.q.resume();
  await flush();
  assert.deepEqual(h.runs.map((r) => r.id), ["a", "b", "a", "b"]);
  assert.equal(h.jobs.rows.get("a")?.attempts, 1, "the resumed claim is attempt 1 again");

  h.live("a").resolve();
  await flush();
  assert.deepEqual(h.runs.map((r) => r.id), ["a", "b", "a", "b", "c"]);
  h.live("b").resolve();
  h.live("c").resolve();
  await flush();
  assert.equal(h.jobs.rows.size, 0);
  assert.ok(!h.jobs.log.some((l) => l.startsWith("release")), "a pause is never a failed attempt");
  assert.deepEqual(h.progress.at(-1), { remaining: 0, running: 0 });
});

test("a run past its last checkpoint (a metered AI call) finishes and completes instead of unwinding", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness(["a"]);
  await h.q.wake();
  await flush();
  h.runs[0]!.ignorePause = true;
  h.q.pause();
  await flush();
  assert.deepEqual(h.jobs.log, ["claim a"]);
  h.runs[0]!.resolve();
  await flush();
  assert.deepEqual(h.jobs.log, ["claim a", "complete a"]);
  assert.deepEqual(h.progress.at(-1), { remaining: 0, running: 0 });
});

test("a real error is a failed attempt — unpaused, paused, and an AbortError the pause didn't cause", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness(["a"]);
  await h.q.wake();
  await flush();
  h.live("a").reject(new Error("decode"));
  await flush();
  assert.deepEqual(h.jobs.log, ["claim a", "release a", "claim a"]);
  h.live("a").reject(new Error("decode"));
  await flush();
  assert.deepEqual(h.jobs.log.at(-1), "complete a", "gives up after maxAttempts");

  // Paused: the pause path needs BOTH the fired signal and an AbortError.
  const p = harness(["b"]);
  await p.q.wake();
  await flush();
  p.live("b").ignorePause = true;
  p.q.pause();
  await flush();
  p.live("b").reject(new Error("decode"));
  await flush();
  assert.deepEqual(p.jobs.log, ["claim b", "release b"]);
  assert.equal(p.jobs.rows.get("b")?.attempts, 1, "the failed attempt counts");

  // Not paused: an AbortError from inside the run (a fetch deadline, say)
  // is an ordinary failure.
  const u = harness(["c"]);
  await u.q.wake();
  await flush();
  u.live("c").reject(abortError());
  await flush();
  assert.deepEqual(u.jobs.log, ["claim c", "release c", "claim c"]);
  u.live("c").resolve();
  await flush();
});

test("a claim that lands after the pause is handed straight back, never run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness(["a"]);
  let open!: () => void;
  h.jobs.claimGate = new Promise<void>((r) => (open = r));
  const woke = h.q.wake();
  await flush();
  h.q.pause();
  h.jobs.claimGate = null;
  open();
  await woke;
  await flush();
  assert.deepEqual(h.jobs.log, ["claim a", "unclaim a"]);
  assert.equal(h.runs.length, 0);
  assert.deepEqual(h.jobs.rows.get("a"), { id: "a", receiptId: "a", attempts: 0, lockedAt: null, createdAt: 1 });
});

test("pause + resume inside one claim runs the job exactly once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness(["a"]);
  let open!: () => void;
  h.jobs.claimGate = new Promise<void>((r) => (open = r));
  const woke = h.q.wake();
  await flush();
  h.q.pause();
  h.q.resume();
  h.jobs.claimGate = null;
  open();
  await woke;
  await flush();
  assert.deepEqual(h.jobs.log, ["claim a", "unclaim a", "claim a"]);
  assert.equal(h.runs.length, 1);
  h.live("a").resolve();
  await flush();
  assert.equal(h.jobs.rows.size, 0);
});

test("the heartbeat stops before the claim is handed back — a late beat never re-locks it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness(["a"]);
  await h.q.wake();
  await flush();
  t.mock.timers.tick(20_000); // a normal beat while the read runs
  await flush();
  assert.deepEqual(h.jobs.log, ["claim a", "touch a"]);

  let open!: () => void;
  h.jobs.unclaimGate = new Promise<void>((r) => (open = r));
  h.q.pause();
  await flush();
  t.mock.timers.tick(60_000); // beats that would land while unclaim commits
  await flush();
  open();
  await flush();
  assert.deepEqual(h.jobs.log, ["claim a", "touch a", "unclaim a"]);
  assert.equal(h.jobs.rows.get("a")?.lockedAt, null);
});

test("the 30 s re-wake is never armed while paused, and pause() clears a pending one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness(["a"]);
  // A lock held by a run elsewhere (another tab): nothing claimable, one job left.
  h.jobs.rows.set("a", { ...h.jobs.rows.get("a")!, lockedAt: NOW });

  h.q.pause();
  await h.q.wake();
  await flush();
  const woken = h.jobs.countCalls;
  t.mock.timers.tick(31_000);
  await flush();
  assert.equal(h.jobs.claimCalls, 0, "paused: no claim");
  assert.equal(h.jobs.countCalls, woken, "paused: no re-wake was armed");

  h.q.resume();
  await flush();
  assert.equal(h.jobs.claimCalls, 1);
  t.mock.timers.tick(31_000);
  await flush();
  assert.equal(h.jobs.claimCalls, 2, "unpaused, the re-wake still looks again");

  h.q.pause();
  const paused = h.jobs.countCalls;
  t.mock.timers.tick(31_000);
  await flush();
  assert.equal(h.jobs.claimCalls, 2);
  assert.equal(h.jobs.countCalls, paused, "pause() cleared the armed re-wake");
});

// ---- the row rules themselves (store/repo.ts jobRows) ---------------------

const job = (over: Partial<Job>): Job => ({
  id: "j",
  receiptId: "r",
  attempts: 0,
  lockedAt: null,
  createdAt: 1,
  ...over,
});

test("a claim takes the oldest free or stale job by createdAt (upload order)", () => {
  const rows = [
    job({ id: "late", createdAt: 30 }),
    job({ id: "held", createdAt: 10, lockedAt: NOW - 1_000 }),
    job({ id: "stale", createdAt: 20, lockedAt: NOW - STALE_LOCK_MS - 1 }),
  ];
  assert.equal(jobRows.nextClaim(rows, NOW, STALE_LOCK_MS)?.id, "stale");
  assert.equal(jobRows.nextClaim([rows[1]!], NOW, STALE_LOCK_MS), null);
  assert.deepEqual(jobRows.claimed(rows[0]!, NOW), { ...rows[0]!, lockedAt: NOW, attempts: 1 });
});

test("a released job keeps its stored createdAt, so a retry doesn't jump the queue", () => {
  const stored = job({ id: "retry", createdAt: 50, attempts: 1, lockedAt: NOW });
  // The queue hands releaseJob a copy WITHOUT createdAt.
  const released = jobRows.released(stored, 1);
  assert.deepEqual(released, { ...stored, lockedAt: null });
  const next = jobRows.nextClaim([released, job({ id: "older", createdAt: 20 })], NOW, STALE_LOCK_MS);
  assert.equal(next?.id, "older");
});

test("unclaimed returns the lock AND the attempt, floored at 0, createdAt kept", () => {
  assert.deepEqual(jobRows.unclaimed(job({ attempts: 2, lockedAt: NOW, createdAt: 7 })), job({ attempts: 1, createdAt: 7 }));
  assert.equal(jobRows.unclaimed(job({ attempts: 0, lockedAt: NOW })).attempts, 0);
});

test("a heartbeat refreshes a lock but never creates one", () => {
  assert.equal(jobRows.touched(job({ lockedAt: null }), NOW), null);
  assert.equal(jobRows.touched(job({ lockedAt: NOW - 5 }), NOW)?.lockedAt, NOW);
});
