// Strong defaults — "zero-config beats configurable" (§3). A first-time user
// should never face a choice to get a result. These are the guardrails that
// also cap cost/abuse (§11) and the levers that keep marginal cost ~ $0 (§9).

export const APP_NAME = "Reimbursements F5";

/** Input hardening + per-batch volume caps (§11). Polite refusal, not an invoice. */
export const LIMITS = {
  /** Max receipts per batch. Keeps storage/throughput bounded. */
  maxReceiptsPerBatch: 200,
  /** Max original upload size each. Larger photos are downscaled anyway. */
  maxFileBytes: 25 * 1024 * 1024,
  /** Accepted input types. */
  acceptedMime: [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "application/pdf",
  ] as const,
  acceptedExtensions: [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".heic",
    ".heif",
    ".pdf",
  ] as const,
};

/** Image pre-pass settings (§5 step 1, §14). Downscaling is also a cost lever:
 *  smaller images OCR faster and would make any optional paid call cheaper. */
export const IMAGE_PREP = {
  /** Longest edge of the STORED cleaned image (display + export), in px. */
  maxEdge: 1600,
  /** Longest edge of the transient higher-res copy handed to OCR, in px.
   *  Small receipt print blurs at 1600px on a 4k phone photo — the original
   *  app OCRs at full resolution for exactly this reason. The OCR copy is
   *  never persisted, so the only cost is recognition time. */
  ocrMaxEdge: 2600,
  /** JPEG quality of the STORED cleaned image (display + export only — the
   *  OCR copy uses `ocrQuality`). */
  quality: 0.85,
  /** JPEG quality of the transient OCR render (higher: compression artifacts
   *  cost recognition accuracy, and this blob is never persisted). */
  ocrQuality: 0.95,
  /** Convert to grayscale before OCR (helps Tesseract, shrinks bytes). */
  grayscale: true,
  /** Attempt to auto-crop the receipt away from its background. */
  autoCrop: true,
  /** Estimate and correct small tilt (projection-profile deskew) before OCR —
   *  Tesseract's line finder degrades quickly past ~1–2° of skew. */
  deskew: true,
  /** Largest tilt the deskew pass searches for, in degrees. */
  deskewMaxAngle: 8,
};

/** Weak-read rescue: when the first OCR pass reports low confidence or the
 *  rules find no amount, retry on an adaptively binarized (Bradley) copy and
 *  keep whichever read extracts better. Binarization rescues unevenly lit
 *  thermal paper but can hurt clean scans, so it is retry-only — the same
 *  "try alternatives only when the read is weak" pattern the original app
 *  uses for orientation. */
export const OCR_RESCUE = {
  minConfidence: 65,
  binarize: true,
};

/** Confidence thresholds that drive the board + review routing. */
export const CONFIDENCE = {
  /** At/above this, a receipt is auto-"done"; below, it needs review. */
  reviewBelow: 0.8,
  /** A field rendered with a "low" treatment below this. */
  fieldLow: 0.6,
};

/** Heuristic thresholds for flags. */
export const FLAGS = {
  /** Flag receipts older than this many days as possibly stale. */
  staleAfterDays: 120,
  /** Flag unusually large amounts for a closer look. */
  largeAmount: 1000,
  /** Allowed gap between summed line items and printed total to "reconcile". */
  reconcileTolerance: 0.02,
};

/** OCR language-data location. By default the data is vendored at build time
 *  and served same-origin (offline, $0, no third-party CDN). Set
 *  VITE_TESSDATA_LOCAL=0 to fetch from the public CDN instead. Either way the
 *  service worker caches it after first use. */
export const OCR = {
  language: "eng",
  /** Public CDN fallback (the tesseract.js default host). */
  cdnLangPath: "https://tessdata.projectnaptha.com/4.0.0",
  /** Same-origin path (relative to BASE_URL) for the vendored data. */
  localLangPath: "vendor/tessdata/4.0.0",
  // `import.meta.env` is replaced at build time by Vite; guard for non-Vite
  // contexts (e.g. the Node test runner) where it is undefined.
  useLocal: import.meta.env?.VITE_TESSDATA_LOCAL !== "0",
};

/** How many receipts to OCR at once. OCR is CPU-bound; a small pool keeps the
 *  UI responsive while still draining a batch quickly. */
export const PROCESSING = {
  concurrency: 2,
  maxAttempts: 2,
};

export const CURRENCY_DEFAULT = "USD";
