// Cooperative cancellation for the reading pause (pipeline/queue.ts). A
// promise can't be cancelled — only stopped being waited on — so a paused
// read unwinds at its next checkpoint (`throwIfAborted`) and every wait that
// could outlive the pause is raced against the signal (`abortable`). Pure;
// Node-tested.

/** The error a paused read unwinds with. Its NAME is the contract (the
 *  platform's own aborts are DOMExceptions named "AbortError" too); the
 *  message is only what a log would show. */
export function abortError(): Error {
  const err = new Error("Reading paused.");
  err.name = "AbortError";
  return err;
}

/** An abort, whether ours or the platform's (fetch, a DOMException — which
 *  inherits Error). Matched by name, never message. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** A checkpoint: throws an AbortError once the signal has fired. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/**
 * Settle with `p`, or reject with an AbortError the moment `signal` fires
 * (at once when it already has). `p` keeps running — the caller just stops
 * waiting for it, which is the point: tesseract.js terminate() never settles
 * the jobs it kills, so an unraced await on one waits forever. `p`'s late
 * rejection, if one ever comes, is still observed, so it can't surface as an
 * unhandled rejection. Without a signal, `p` itself is returned.
 */
export function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * One signal that fires when ANY of `signals` does, carrying that signal's
 * reason. `AbortSignal.any` where the platform has it (Chromium 116+,
 * Safari 17.4+); a listener-based stand-in otherwise (`native` is
 * injectable so tests reach that path).
 */
export function anySignal(
  signals: AbortSignal[],
  native: ((signals: AbortSignal[]) => AbortSignal) | null = nativeAny(),
): AbortSignal {
  if (native) return native(signals);
  const ctl = new AbortController();
  const fired = signals.find((s) => s.aborted);
  if (fired) {
    ctl.abort(fired.reason);
    return ctl.signal;
  }
  const listeners = signals.map((s) => {
    const onAbort = (): void => {
      listeners.forEach(([other, fn]) => other.removeEventListener("abort", fn));
      ctl.abort(s.reason);
    };
    s.addEventListener("abort", onAbort, { once: true });
    return [s, onAbort] as const;
  });
  return ctl.signal;
}

function nativeAny(): ((signals: AbortSignal[]) => AbortSignal) | null {
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  return typeof any === "function" ? (signals) => any.call(AbortSignal, signals) : null;
}
