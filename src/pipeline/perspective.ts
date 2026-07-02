// Document perspective correction — the one preprocessing step that needs real
// computer vision. An angled phone photo of a receipt OCRs far worse than a
// straightened one; this module finds the receipt's quad and warps it flat.
//
// OpenCV.js is ~8 MB of WASM, so it is NEVER in the main bundle: it lazy-loads
// from the vendored copy on first use (see scripts/vendor-paddle.mjs's pattern)
// and the whole step is best-effort — any failure (missing lib, no quad found,
// degenerate geometry) returns null and the pipeline continues with the
// unwarped image. Enable with VITE_PERSPECTIVE=1.

interface CvMat {
  delete(): void;
  rows: number;
  cols: number;
  data32S: Int32Array;
  size(): { width: number; height: number };
}

interface CvModule {
  imread(canvas: HTMLCanvasElement): CvMat;
  imshow(canvas: HTMLCanvasElement, mat: CvMat): void;
  cvtColor(src: CvMat, dst: CvMat, code: number): void;
  GaussianBlur(src: CvMat, dst: CvMat, size: unknown, sigma: number): void;
  Canny(src: CvMat, dst: CvMat, lo: number, hi: number): void;
  findContours(src: CvMat, contours: unknown, hierarchy: CvMat, mode: number, method: number): void;
  approxPolyDP(curve: CvMat, out: CvMat, epsilon: number, closed: boolean): void;
  arcLength(curve: CvMat, closed: boolean): number;
  contourArea(c: CvMat): number;
  getPerspectiveTransform(src: CvMat, dst: CvMat): CvMat;
  warpPerspective(src: CvMat, dst: CvMat, m: CvMat, size: unknown): void;
  matFromArray(rows: number, cols: number, type: number, arr: number[]): CvMat;
  Mat: new () => CvMat;
  MatVector: new () => { size(): number; get(i: number): CvMat; delete(): void };
  Size: new (w: number, h: number) => unknown;
  COLOR_RGBA2GRAY: number;
  RETR_EXTERNAL: number;
  CHAIN_APPROX_SIMPLE: number;
  CV_32FC2: number;
}

let cvPromise: Promise<CvModule | null> | null = null;

function base(): string {
  return import.meta.env?.BASE_URL || "/";
}

async function loadCv(): Promise<CvModule | null> {
  if (!cvPromise) {
    cvPromise = (async () => {
      try {
        // Vendored same-origin (public/vendor/opencv/opencv.js); not bundled.
        const url = `${base()}vendor/opencv/opencv.js`;
        const mod = await import(/* @vite-ignore */ url);
        const cv = (mod.default ?? (globalThis as { cv?: unknown }).cv) as
          | CvModule
          | (Promise<CvModule> & CvModule)
          | undefined;
        if (!cv) return null;
        // opencv.js resolves asynchronously in some builds.
        return "then" in cv ? await cv : cv;
      } catch {
        return null;
      }
    })();
  }
  return cvPromise;
}

export function perspectiveEnabled(): boolean {
  return import.meta.env?.VITE_PERSPECTIVE === "1";
}

/** Order 4 points as [tl, tr, br, bl]. */
function orderQuad(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const tl = bySum[0]!;
  const br = bySum[3]!;
  const byDiff = [...pts].sort((a, b) => a.y - a.x - (b.y - b.x));
  const tr = byDiff[0]!;
  const bl = byDiff[3]!;
  return [tl, tr, br, bl];
}

/**
 * Detect the receipt's quad and warp it flat. Returns the corrected bitmap, or
 * null when the step is disabled, the lib is unavailable, or no convincing
 * document quad exists (the common already-flat case).
 */
export async function correctPerspective(
  bmp: ImageBitmap,
): Promise<ImageBitmap | null> {
  if (!perspectiveEnabled()) return null;
  const cv = await loadCv();
  if (!cv) return null;

  const work = document.createElement("canvas");
  // Analyze at reduced size for speed; warp at full resolution.
  const maxSide = 720;
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  work.width = Math.round(bmp.width * scale);
  work.height = Math.round(bmp.height * scale);
  work.getContext("2d")!.drawImage(bmp, 0, 0, work.width, work.height);

  const src = cv.imread(work);
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, 60, 180);
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let bestQuad: { x: number; y: number }[] | null = null;
    let bestArea = work.width * work.height * 0.2; // must cover ≥20% of frame
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
      if (approx.rows === 4) {
        const area = cv.contourArea(approx);
        if (area > bestArea) {
          bestArea = area;
          const pts: { x: number; y: number }[] = [];
          for (let p = 0; p < 4; p++) {
            pts.push({
              x: (approx.data32S[p * 2] ?? 0) / scale,
              y: (approx.data32S[p * 2 + 1] ?? 0) / scale,
            });
          }
          bestQuad = orderQuad(pts);
        }
      }
      approx.delete();
      c.delete();
    }
    if (!bestQuad) return null;

    const [tl, tr, br, bl] = bestQuad as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ];
    const wTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const wBot = Math.hypot(br.x - bl.x, br.y - bl.y);
    const hL = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    const hR = Math.hypot(br.x - tr.x, br.y - tr.y);
    const outW = Math.round(Math.max(wTop, wBot));
    const outH = Math.round(Math.max(hL, hR));
    if (outW < 80 || outH < 80) return null;

    // Full-resolution warp.
    const full = document.createElement("canvas");
    full.width = bmp.width;
    full.height = bmp.height;
    full.getContext("2d")!.drawImage(bmp, 0, 0);
    const srcFull = cv.imread(full);
    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y,
    ]);
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0, outW, 0, outW, outH, 0, outH,
    ]);
    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    const out = new cv.Mat();
    try {
      cv.warpPerspective(srcFull, out, M, new cv.Size(outW, outH));
      const outCanvas = document.createElement("canvas");
      outCanvas.width = outW;
      outCanvas.height = outH;
      cv.imshow(outCanvas, out);
      return await createImageBitmap(outCanvas);
    } finally {
      srcFull.delete();
      srcTri.delete();
      dstTri.delete();
      M.delete();
      out.delete();
    }
  } catch {
    return null;
  } finally {
    src.delete();
    gray.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();
  }
}
