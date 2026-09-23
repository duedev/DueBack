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
  /** The receipts' status as retireJob sees it (default: not queued). */
  receipts = new Map<string, { status: "queued" | "processing" | "done" | "needs_review" | "failed"; approved: boolean }>();
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
  async retireJob(id: string): Promise<void> {
    this.log.push(`retire ${id}`);
    const cur = this.rows.get(id);
    const keep = cur ? jobRows.retired(cur, this.receipts.get(cur.receiptId) ?? { status: "done", approved: false }) : null;
    if (keep) this.rows.set(id, keep);
    else this.rows.delete(id);
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
  assert.deepEqual(h.jobs.log, ["claim a", "retire a"]);
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
  assert.deepEqual(h.jobs.log.at(-1), "retire a", "gives up after maxAttempts");

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

test("a Retry while paused re-arms the failed receipt's released job instead of adding a second — resume reads it once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness(["a"]);
  await h.q.wake();
  await flush();
  // A real error lands after the pause (cleanImage takes no signal): the
  // receipt is "failed" and its job released, unclaimed for the whole pause.
  h.live("a").ignorePause = true;
  h.q.pause();
  await flush();
  h.live("a").reject(new Error("canvas encode failed"));
  await flush();
  assert.deepEqual(h.jobs.log, ["claim a", "release a"]);

  // "Retry reading" — the rule repo.requeueFailed applies in one transaction.
  const next = jobRows.requeued(
    { id: "a", status: "failed", approved: false },
    [...h.jobs.rows.values()].filter((j) => j.receiptId === "a"),
    NOW,
    "a-retry",
  );
  assert.ok(next);
  for (const j of next.jobs) h.jobs.rows.set(j.id, j);
  assert.equal(h.jobs.rows.size, 1, "no second job for the receipt");

  h.q.resume();
  await flush();
  assert.deepEqual(h.runs.map((r) => r.id), ["a", "a"], "one read on resume, not two at once");
  h.live("a").resolve();
  await flush();
  assert.equal(h.jobs.rows.size, 0);
});

test("the pool never starts a second read of a receipt it is already reading", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness([]);
  // Two rows for one receipt (a duplicate from an older build's Retry).
  h.jobs.rows.set("a1", { id: "a1", receiptId: "a", attempts: 0, lockedAt: null, createdAt: 1 });
  h.jobs.rows.set("a2", { id: "a2", receiptId: "a", attempts: 0, lockedAt: null, createdAt: 2 });
  h.jobs.rows.set("b", { id: "b", receiptId: "b", attempts: 0, lockedAt: null, createdAt: 3 });
  await h.q.wake();
  await flush();
  assert.deepEqual(h.runs.map((r) => r.id), ["a", "b"], "the slot goes to other work");
  assert.deepEqual(h.jobs.log, ["claim a1", "claim a2", "complete a2", "claim b"]);

  // The running read's OWN row re-claimed (its lock went stale under a
  // starved heartbeat): left locked — never deleted out from under the run.
  h.jobs.rows.set("a1", { ...h.jobs.rows.get("a1")!, lockedAt: NOW - STALE_LOCK_MS - 1 });
  h.live("b").resolve();
  await flush();
  assert.deepEqual(h.runs.map((r) => r.id), ["a", "b"]);
  assert.equal(h.jobs.rows.get("a1")?.lockedAt, NOW, "still held by the running read");

  // The run still owns its retry (and its pause) through its own row.
  h.live("a").reject(new Error("decode"));
  await flush();
  assert.deepEqual(h.runs.map((r) => r.id), ["a", "b", "a"], "released, then read again — once");
  h.live("a").resolve();
  await flush();
  assert.equal(h.jobs.rows.size, 0);
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

// "Retry reading" (repo.requeueFailed → jobRows.requeued): at most one job
// per receipt. repo.enqueue always inserted, so a receipt that failed while
// paused (its released job still in the table) got a SECOND job, and resume
// read it twice at once — the older claim's extraction discarded, its blobs
// orphaned, the metered assist possibly billed twice.
const failed = { id: "r", status: "failed" as const, approved: false };

test("retry: a failed receipt with no job gets exactly one new job, and is queued afresh", () => {
  const next = jobRows.requeued(failed, [], NOW, "new");
  assert.deepEqual(next?.jobs, [job({ id: "new", createdAt: NOW })]);
  assert.deepEqual(next?.patch, {
    status: "queued",
    error: undefined,
    flags: [],
    reviewRequired: false,
    updatedAt: NOW,
  });
});

test("retry: a failed receipt whose job was released keeps that one job, attempts back to 0", () => {
  const released = job({ id: "old", attempts: 1, createdAt: 7 });
  const next = jobRows.requeued(failed, [released], NOW, "new");
  assert.deepEqual(next?.jobs, [{ ...released, attempts: 0 }], "createdAt kept — no queue jump");
});

test("retry: a locked job (a run unwinding, another tab) keeps its lock — only the attempts reset", () => {
  const locked = job({ id: "old", attempts: 2, lockedAt: NOW - 1_000 });
  const next = jobRows.requeued(failed, [locked], NOW, "new");
  assert.deepEqual(next?.jobs, [{ ...locked, attempts: 0 }]);
});

test("retry: a receipt that is no longer failed, or is approved, is left alone", () => {
  assert.equal(jobRows.requeued(undefined, [], NOW, "new"), null, "deleted");
  for (const status of ["queued", "processing", "done", "needs_review"] as const) {
    assert.equal(jobRows.requeued({ ...failed, status }, [], NOW, "new"), null, status);
  }
  assert.equal(jobRows.requeued({ ...failed, approved: true }, [], NOW, "new"), null, "approved");
});

test("a Retry that lands while the last failed attempt winds down keeps the receipt's job", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness(["a"]);
  // The final attempt is already running (claimed at maxAttempts).
  h.jobs.rows.set("a", { ...h.jobs.rows.get("a")!, attempts: PROCESSING.maxAttempts - 1 });
  await h.q.wake();
  await flush();
  // "failed" lands; before the queue finishes the job, the human clicks Retry
  // (jobRows.requeued re-arms the still-locked row: attempts back to 0).
  const next = jobRows.requeued({ id: "a", status: "failed", approved: false }, [h.jobs.rows.get("a")!], NOW, "a-new");
  assert.ok(next);
  for (const j of next.jobs) h.jobs.rows.set(j.id, j);
  h.jobs.receipts.set("a", { status: "queued", approved: false });
  h.live("a").reject(new Error("The source image could not be decoded."));
  await flush();
  // Retired, not deleted: the re-armed row survives, unlocked, and is read again.
  assert.equal(h.jobs.rows.size, 1, "the receipt still has its job");
  assert.equal(h.jobs.rows.get("a")?.attempts, 1, "claimed once more");
  assert.deepEqual(h.runs.map((r) => r.id), ["a", "a"]);
  // Without the Retry, the last failed attempt deletes the row as before.
  const queued = { status: "queued" as const, approved: false };
  assert.equal(jobRows.retired({ id: "x", receiptId: "x", attempts: PROCESSING.maxAttempts, lockedAt: NOW }, queued), null);
  assert.deepEqual(jobRows.retired({ id: "x", receiptId: "x", attempts: 0, lockedAt: NOW }, queued), {
    id: "x",
    receiptId: "x",
    attempts: 0,
    lockedAt: null,
  });
  // A re-armed row whose receipt the run then finished (done / review /
  // failed again, or approved) is NOT kept: that would read it twice.
  for (const r of [
    { status: "done" as const, approved: false },
    { status: "needs_review" as const, approved: false },
    { status: "failed" as const, approved: false },
    { status: "queued" as const, approved: true },
  ]) {
    assert.equal(jobRows.retired({ id: "x", receiptId: "x", attempts: 0, lockedAt: NOW }, r), null, JSON.stringify(r));
  }
});

test("a Retry that landed before the claim's stamp, on a run that then SUCCEEDS, reads the receipt once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness(["a"]);
  await h.q.wake();
  await flush();
  // The Retry re-armed the row (attempts 0) just before the run stamped the
  // receipt "processing"; the run then lands "done".
  h.jobs.rows.set("a", { ...h.jobs.rows.get("a")!, attempts: 0 });
  h.jobs.receipts.set("a", { status: "done", approved: false });
  h.live("a").resolve();
  await flush();
  assert.equal(h.jobs.rows.size, 0, "no second read of a finished receipt");
  assert.deepEqual(h.runs.map((r) => r.id), ["a"]);
});
