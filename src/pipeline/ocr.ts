import { createWorker, type Worker } from "tesseract.js";
import { OCR } from "../config/constants.ts";
import type { OcrResult, OcrLine, OcrWord, BBox } from "../types.ts";

// "Reading text" is a *capability*, not a model (§5). Everything upstream and
// downstream is identical whether this is open-source OCR, a paid OCR API, or a
// vision model — so it sits behind one tiny interface. The default, free,
// runs-on-device implementation is Tesseract.js (its own web worker keeps the
// main thread free), with assets served same-origin for offline use.

export interface OcrEngine {
  /** Recognize text + word boxes from a cleaned image. */
  recognize(image: Blob, width: number, height: number): Promise<OcrResult>;
  /** Release resources (terminate workers). */
  dispose(): Promise<void>;
}

function base(): string {
  // Resolves correctly whether served from a domain root or a project subpath.
  return import.meta.env.BASE_URL || "/";
}

// The vendored worker + cores live under vendor/tesseract/<version>/ (see
// scripts/vendor-tesseract.mjs): the service worker caches /vendor/ for a
// year, so the path must change with the library or an upgrade keeps serving
// the old worker to the new bundle. Injected by vite.config.ts; the guard
// keeps the module importable outside Vite (the Node test runner).
declare const __TESSERACT_VERSION__: string;
const TESSERACT_VERSION: string =
  typeof __TESSERACT_VERSION__ === "string" ? __TESSERACT_VERSION__ : "";
function vendorDir(): string {
  return `${base()}vendor/tesseract/${TESSERACT_VERSION ? `${TESSERACT_VERSION}/` : ""}`;
}

interface RawBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface RawWord {
  text: string;
  confidence: number;
  bbox: RawBox;
}

interface RawLine {
  text: string;
  confidence: number;
  bbox: RawBox;
  words?: RawWord[];
}

interface RawBlock {
  paragraphs?: { lines?: RawLine[] }[];
}

/** After a failed start, how long later receipts fail fast with the same
 *  error before a fresh createWorker is attempted. Every failed attempt
 *  leaks one idle Worker (tesseract keeps the handle private) and the
 *  queue retries at once — attempt 2 of the same receipt, then each other
 *  queued one — so without a cooldown a dead connection spawned a worker
 *  per receipt. */
const OCR_INIT_COOLDOWN_MS = 30_000;

/** First-use start-up fetches the worker, a ~3.4 MB wasm core and ~11 MB of
 *  language data; on a slow mobile link that is minutes, so this backstop
 *  is generous. It IS only a backstop: a fetch that fails is reported at
 *  once through tesseract's `errorHandler` — createWorker itself never
 *  settles when the language data or the initialize step fails (only the
 *  'load' action rejects its promise), which used to park every receipt in
 *  "Reading…" with the heartbeat keeping the job lock alive. */
const OCR_INIT_TIMEOUT_MS = 300_000;

class TesseractEngine implements OcrEngine {
  private worker: Worker | null = null;
  private initPromise: Promise<Worker> | null = null;
  private initFailedAt = 0;
  private initError: Error | null = null;

  private async getWorker(): Promise<Worker> {
    if (this.worker) return this.worker;
    if (!this.initPromise) {
      if (this.initError && Date.now() - this.initFailedAt < OCR_INIT_COOLDOWN_MS) {
        throw this.initError;
      }
      this.initError = null;
      const langPath = OCR.useLocal
        ? `${base()}${OCR.localLangPath}`
        : OCR.cdnLangPath;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const init = new Promise<Worker>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The OCR engine took too long to start — check the connection and try again.")),
          OCR_INIT_TIMEOUT_MS,
        );
        createWorker(OCR.language, 1, {
          workerPath: `${vendorDir()}worker.min.js`,
          corePath: vendorDir(),
          langPath,
          // Called with the loadLanguage/initialize rejection reason — the
          // failures whose outer promise never settles. Rejecting an
          // already-settled promise is a no-op, so the same handler is safe
          // for later job errors too (and silences tesseract's re-throw).
          errorHandler: (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))),
        }).then(resolve, reject);
      });
      // A failed or timed-out start is forgotten (after the cooldown), so
      // the next receipt retries instead of inheriting a permanently
      // rejected promise — one bad start used to fail every receipt for
      // the session.
      this.initPromise = init
        .then((w) => {
          this.worker = w;
          return w;
        })
        .finally(() => clearTimeout(timer))
        .catch((err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err));
          this.initPromise = null;
          this.worker = null;
          this.initFailedAt = Date.now();
          this.initError = e;
          throw e;
        });
    }
    return this.initPromise;
  }

  async recognize(image: Blob, width: number, height: number): Promise<OcrResult> {
    const worker = await this.getWorker();
    const { data } = await worker.recognize(
      image,
      {},
      { text: true, blocks: true },
    );

    const norm = (b: RawBox): BBox => ({
      x: clamp01(b.x0 / width),
      y: clamp01(b.y0 / height),
      w: clamp01((b.x1 - b.x0) / width),
      h: clamp01((b.y1 - b.y0) / height),
    });

    const words: OcrWord[] = [];
    const lines: OcrLine[] = [];

    // tesseract.js v5 nests results in blocks → paragraphs → lines → words.
    const blocks = (data as unknown as { blocks?: RawBlock[] }).blocks ?? [];
    for (const block of blocks) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) {
          const lineWords: OcrWord[] = (line.words ?? []).map((w) => ({
            text: w.text,
            confidence: w.confidence,
            bbox: norm(w.bbox),
          }));
          words.push(...lineWords);
          lines.push({
            text: line.text.trim(),
            confidence: line.confidence,
            bbox: norm(line.bbox),
            words: lineWords,
          });
        }
      }
    }

    return {
      text: data.text ?? "",
      confidence: data.confidence ?? 0,
      lines,
      words,
    };
  }

  async dispose(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      this.initPromise = null;
    }
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Defers building (and lazily importing) a heavier engine until first use, so
 *  its code/runtime never enters the main bundle unless it's actually selected. */
class DeferredEngine implements OcrEngine {
  private real: OcrEngine | null = null;
  constructor(private readonly factory: () => Promise<OcrEngine>) {}
  private async get(): Promise<OcrEngine> {
    if (!this.real) this.real = await this.factory();
    return this.real;
  }
  async recognize(image: Blob, width: number, height: number): Promise<OcrResult> {
    return (await this.get()).recognize(image, width, height);
  }
  async dispose(): Promise<void> {
    if (this.real) await this.real.dispose();
  }
}

let singleton: OcrEngine | null = null;

/** The active engine (§5). Tesseract is the default $0/offline/private path;
 *  set `VITE_OCR_ENGINE=paddle` to opt into the on-device PaddleOCR upgrade
 *  (Tier 1) — both implement the same interface, so nothing downstream changes. */
export function getOcrEngine(): OcrEngine {
  if (singleton) return singleton;
  if (import.meta.env?.VITE_OCR_ENGINE === "paddle") {
    singleton = new DeferredEngine(async () => {
      const { PaddleEngine } = await import("./engines/paddle/index.ts");
      return new PaddleEngine();
    });
  } else {
    singleton = new TesseractEngine();
  }
  return singleton;
}
