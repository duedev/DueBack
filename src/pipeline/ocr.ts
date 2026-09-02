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

/** First-use start-up fetches the worker, a ~3.4 MB wasm core and ~4 MB of
 *  language data; on a slow connection that is minutes, so the deadline is
 *  generous — but it exists, because a hung start used to park every
 *  receipt in "processing" for good. */
const OCR_INIT_TIMEOUT_MS = 180_000;

class TesseractEngine implements OcrEngine {
  private worker: Worker | null = null;
  private initPromise: Promise<Worker> | null = null;

  private async getWorker(): Promise<Worker> {
    if (this.worker) return this.worker;
    if (!this.initPromise) {
      const langPath = OCR.useLocal
        ? `${base()}${OCR.localLangPath}`
        : OCR.cdnLangPath;
      const init = createWorker(OCR.language, 1, {
        workerPath: `${vendorDir()}worker.min.js`,
        corePath: vendorDir(),
        langPath,
      }).then((w) => {
        this.worker = w;
        return w;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("The OCR engine took too long to start — check the connection and try again.")),
          OCR_INIT_TIMEOUT_MS,
        );
      });
      // A failed or timed-out start is forgotten, so the next receipt
      // retries instead of inheriting a permanently rejected promise (the
      // old behaviour: one bad start failed every receipt for the session).
      this.initPromise = Promise.race([init, deadline])
        .finally(() => clearTimeout(timer))
        .catch((err) => {
          this.initPromise = null;
          throw err;
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
