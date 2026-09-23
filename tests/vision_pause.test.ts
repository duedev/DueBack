import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { visionFetch } from "../src/pipeline/vision/clients/shared.ts";
import { runVisionAssist } from "../src/pipeline/vision/index.ts";
import { parseReceipt } from "../src/pipeline/extract.ts";
import { isAbortError } from "../src/util/abort.ts";

// The reading pause vs the AI assist. A FREE call (local / self-hosted — the
// owner runs one with a 300 s deadline) listens to the pause and unwinds, and
// runVisionAssist rethrows that AbortError so the pipeline requeues the
// receipt instead of completing it rules-only. A METERED call never listens:
// it is billed once sent, so it finishes and lands.

/** Wait for the request to go out (the cloud plan lazily imports the
 *  account-proxy module first, which takes more than a few ticks). */
async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for the request");
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface FetchCall {
  url: string;
  signal: AbortSignal | undefined;
  respond(body: unknown, status?: number): void;
}

/** A fetch that answers only when told to — and, like the platform, rejects
 *  with the signal's reason the moment its signal aborts. */
function stubFetch(t: TestContext): FetchCall[] {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? undefined;
      calls.push({
        url: String(url),
        signal,
        respond: (body, status = 200) =>
          resolve(
            new Response(JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json" },
            }),
          ),
      });
      const fail = (): void => reject(signal?.reason);
      if (signal?.aborted) fail();
      else signal?.addEventListener("abort", fail, { once: true });
    })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/** The AI-assist config as Settings would have stored it. */
function withVisionConfig(t: TestContext, cfg: Record<string, unknown>): void {
  const store = new Map<string, string>([["ro.vision.config.v2", JSON.stringify(cfg)]]);
  const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, "localStorage", before);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });
}

const FREE = {
  backend: "selfhosted" as const,
  label: "Self-hosted",
  baseUrl: "http://gpu.lan:8000/v1",
  timeoutMs: 300_000,
  metered: false,
};
const METERED = {
  backend: "cloud" as const,
  label: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  timeoutMs: 90_000,
  metered: true,
};

test("visionFetch: the pause aborts a free call with an AbortError, not a timeout message", async (t) => {
  const calls = stubFetch(t);
  const pause = new AbortController();
  const req = visionFetch(FREE, `${FREE.baseUrl}/chat/completions`, { method: "POST" }, pause.signal);
  assert.equal(calls.length, 1);
  pause.abort();
  await assert.rejects(req, (err: unknown) => {
    assert.ok(isAbortError(err), `an AbortError (got ${String(err)})`);
    assert.doesNotMatch((err as Error).message, /timed out/);
    return true;
  });
});

test("visionFetch: a metered call never hears the pause — it finishes and lands", async (t) => {
  const calls = stubFetch(t);
  const pause = new AbortController();
  const req = visionFetch(METERED, `${METERED.baseUrl}/chat/completions`, { method: "POST" }, pause.signal);
  pause.abort();
  assert.equal(calls[0]!.signal?.aborted, false, "the request's signal is the deadline alone");
  calls[0]!.respond({ ok: true });
  assert.equal((await req).status, 200);
});

test("visionFetch: with a pause wired in, the deadline still reads as a timeout", async (t) => {
  stubFetch(t);
  // AbortSignal.timeout's timer is unref'd in Node: hold the loop open.
  const keepAlive = setTimeout(() => {}, 5_000);
  t.after(() => clearTimeout(keepAlive));
  const pause = new AbortController();
  await assert.rejects(
    visionFetch({ ...FREE, timeoutMs: 5 }, `${FREE.baseUrl}/chat/completions`, {}, pause.signal),
    (err: unknown) => !isAbortError(err) && /timed out after/.test((err as Error).message),
  );
});

const weakRead = () => parseReceipt({ text: "", confidence: 0, lines: [], words: [] });
const image = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
const answer = (cost = 0) => ({
  choices: [
    {
      finish_reason: "stop",
      message: {
        content: JSON.stringify({
          vendor: "Target",
          date: "2026-05-10",
          amount: 15.75,
          tax: 1.2,
          category: "Materials",
        }),
      },
    },
  ],
  usage: { cost },
});

test("runVisionAssist: a paused self-hosted call rethrows the AbortError (the pipeline requeues)", async (t) => {
  withVisionConfig(t, {
    enabled: true,
    backend: "selfhosted",
    strategy: "oneshot",
    selfhosted: { url: FREE.baseUrl, model: "bonsai-27b", apiKey: "" },
  });
  const calls = stubFetch(t);
  const pause = new AbortController();
  const run = runVisionAssist(image(), weakRead(), [], { signal: pause.signal });
  await until(() => calls.length > 0);
  assert.equal(calls.length, 1, "the self-hosted call went out");
  assert.match(calls[0]!.url, /gpu\.lan/);
  pause.abort();
  await assert.rejects(run, (err: unknown) => isAbortError(err));
});

test("runVisionAssist: without a pause the same call lands as before", async (t) => {
  withVisionConfig(t, {
    enabled: true,
    backend: "selfhosted",
    strategy: "oneshot",
    selfhosted: { url: FREE.baseUrl, model: "bonsai-27b", apiKey: "" },
  });
  const calls = stubFetch(t);
  const run = runVisionAssist(image(), weakRead(), [], { signal: new AbortController().signal });
  await until(() => calls.length > 0);
  calls[0]!.respond(answer());
  const assist = await run;
  assert.equal(assist?.extraction.amount.value, 15.75);
});

test("runVisionAssist: a metered cloud call finishes through the pause and its answer lands", async (t) => {
  withVisionConfig(t, {
    enabled: true,
    backend: "cloud",
    strategy: "oneshot",
    cloud: { provider: "openrouter", model: "vendor/paid-vision", apiKey: "sk-own-key" },
    spendCapUsd: 0,
  });
  const calls = stubFetch(t);
  const pause = new AbortController();
  const run = runVisionAssist(image(), weakRead(), [], { signal: pause.signal });
  await until(() => calls.length > 0);
  assert.equal(calls.length, 1);
  pause.abort();
  assert.equal(calls[0]!.signal?.aborted, false, "the billed request is not cancelled");
  calls[0]!.respond(answer(0.002));
  const assist = await run;
  assert.equal(assist?.extraction.amount.value, 15.75);
  assert.equal(assist?.costUsd, 0.002);
});

test("runVisionAssist: a real failure while paused still falls back to the rules result", async (t) => {
  withVisionConfig(t, {
    enabled: true,
    backend: "cloud",
    strategy: "oneshot",
    cloud: { provider: "openrouter", model: "vendor/paid-vision", apiKey: "sk-own-key" },
    spendCapUsd: 0,
  });
  const calls = stubFetch(t);
  const pause = new AbortController();
  const run = runVisionAssist(image(), weakRead(), [], { signal: pause.signal });
  await until(() => calls.length > 0);
  pause.abort();
  calls[0]!.respond({ error: { message: "upstream down" } }, 500);
  assert.equal(await run, null);
});

test("runVisionAssist: a pause that landed before the call starts nothing — even a metered one", async (t) => {
  withVisionConfig(t, {
    enabled: true,
    backend: "cloud",
    strategy: "oneshot",
    cloud: { provider: "openrouter", model: "vendor/paid-vision", apiKey: "sk-own-key" },
    spendCapUsd: 0,
  });
  const calls = stubFetch(t);
  const pause = new AbortController();
  pause.abort();
  await assert.rejects(runVisionAssist(image(), weakRead(), [], { signal: pause.signal }), (err: unknown) =>
    isAbortError(err),
  );
  assert.equal(calls.length, 0, "nothing was sent, so nothing was billed");
});
