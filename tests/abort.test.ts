import { test } from "node:test";
import assert from "node:assert/strict";
import {
  abortError,
  abortable,
  anySignal,
  isAbortError,
  throwIfAborted,
} from "../src/util/abort.ts";

// The reading pause's cancellation helpers (util/abort.ts). The case that
// matters most: tesseract.js terminate() never settles the jobs it kills, so
// every OCR wait is raced against the pause signal — and whatever the killed
// promise does later must never surface as an unhandled rejection (the e2e
// fails on any console error).

const flush = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

test("abortable passes a live signal's result through", async () => {
  const ctl = new AbortController();
  assert.equal(await abortable(Promise.resolve(3), ctl.signal), 3);
});

test("abortable rejects the moment the signal fires, and observes the killed promise's late rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    let rejectLater!: (e: Error) => void;
    const never = new Promise<number>((_, reject) => (rejectLater = reject));
    const ctl = new AbortController();
    const raced = abortable(never, ctl.signal);
    ctl.abort();
    await assert.rejects(raced, (err: unknown) => isAbortError(err));
    // The terminated worker's job rejecting AFTER the pause.
    rejectLater(new Error("worker terminated"));
    await flush();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("abortable rejects at once on an already-aborted signal", async () => {
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(abortable(new Promise(() => {}), ctl.signal), (err: unknown) =>
    isAbortError(err),
  );
});

test("abortable passes the promise's own rejection through unchanged", async () => {
  const ctl = new AbortController();
  await assert.rejects(abortable(Promise.reject(new Error("x")), ctl.signal), /x/);
});

test("abortable without a signal returns the promise itself", () => {
  const p = Promise.resolve(1);
  assert.strictEqual(abortable(p), p);
});

test("throwIfAborted is a checkpoint: throws an AbortError once fired, no-op otherwise", () => {
  const ctl = new AbortController();
  assert.doesNotThrow(() => throwIfAborted(ctl.signal));
  assert.doesNotThrow(() => throwIfAborted(undefined));
  ctl.abort();
  assert.throws(() => throwIfAborted(ctl.signal), (err: unknown) => isAbortError(err));
});

test("isAbortError matches by NAME — the platform's DOMException too — never by message", () => {
  assert.equal(isAbortError(abortError()), true);
  assert.equal(isAbortError(new DOMException("x", "AbortError")), true);
  assert.equal(isAbortError(new Error("AbortError")), false);
  assert.equal(isAbortError(new DOMException("slow", "TimeoutError")), false);
  assert.equal(isAbortError("AbortError"), false);
});

for (const [label, native] of [
  ["native AbortSignal.any", undefined],
  ["the listener fallback", null],
] as const) {
  test(`anySignal (${label}) fires with whichever signal fired, carrying its reason`, () => {
    const a = new AbortController();
    const b = new AbortController();
    const both = native === null ? anySignal([a.signal, b.signal], null) : anySignal([a.signal, b.signal]);
    assert.equal(both.aborted, false);
    b.abort("paused");
    assert.equal(both.aborted, true);
    assert.equal(both.reason, "paused");
    a.abort("late"); // a second abort changes nothing
    assert.equal(both.reason, "paused");
  });

  test(`anySignal (${label}) is born aborted when an input already is`, () => {
    const a = new AbortController();
    a.abort("gone");
    const both =
      native === null
        ? anySignal([a.signal, new AbortController().signal], null)
        : anySignal([a.signal, new AbortController().signal]);
    assert.equal(both.aborted, true);
    assert.equal(both.reason, "gone");
  });
}
