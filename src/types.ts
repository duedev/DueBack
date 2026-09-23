// Domain model — the single source of truth for the whole app.
// Mirrors §7 of DESIGN_FROM_SCRATCH.md. `receipts` *is* the board, the results
// list, and the export source; `batches` group a submission; `jobs` are the
// cheap work-list. In this client-side build these live in IndexedDB, but the
// shapes are storage-agnostic so a server could host them unchanged.

export type ReceiptStatus =
  | "queued"
  | "processing"
  | "done"
  | "needs_review"
  | "failed";

/** Which extraction tier produced a result, recorded per-receipt so the
 *  "this batch cost you $0.00" line is honest. "paid" is the PERSISTED name
 *  for any AI-assist read — local and self-hosted models included, which
 *  cost $0 — kept so stored and synced rows need no migration;
 *  `methodDetail` names the backend/model/strategy and `cost` what it cost. */
export type ExtractionMethod = "rules" | "paid";

/** Expense categories used for the per-category sheets and the lookup table. */
export type Category =
  | "Meals"
  | "Travel"
  | "Lodging"
  | "Ground Transportation"
  | "Fuel"
  | "Materials"
  | "Office Supplies"
  | "Software & Subscriptions"
  | "Utilities & Phone"
  | "Shipping & Postage"
  | "Professional Services"
  | "Other";

/** A normalized rectangle (0..1) over the *cleaned* image, used to draw
 *  on-image markers and zoomed callouts next to each extracted field. */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FlagCode =
  | "low_confidence"
  | "no_amount"
  | "no_date"
  | "no_vendor"
  | "total_mismatch"
  | "total_suspect"
  | "date_suspect"
  | "vendor_unclear"
  | "future_date"
  | "stale_date"
  | "duplicate"
  | "uncategorized"
  | "large_amount"
  | "logo_mismatch";

export interface Flag {
  code: FlagCode;
  message: string;
  severity: "info" | "warn" | "error";
}

/** A single extracted field plus where on the image it came from and how
 *  sure we are about it. Powers inline editing and the zoomed callouts. */
export interface Field<T> {
  value: T;
  /** 0..1 confidence for this specific field. */
  confidence: number;
  /** Where on the cleaned image the value was read from, if known. */
  bbox?: BBox;
  /** True once a human has confirmed/edited the value in review. */
  edited?: boolean;
  /** True when the box was DRAWN by hand in review — automatic relocation
   *  (`locateValue`) must never move a human-placed box. */
  manualBox?: boolean;
}

/** Flat daily allowance added to the report on top of the receipts:
 *  `rate` dollars per day × `days` days. `enabled` is kept separate so
 *  toggling the option off in the UI preserves the entered values. */
export interface PerDiem {
  enabled: boolean;
  /** US dollars reimbursed per day. */
  rate: number;
  /** Duration in days (fractions allowed for half days). */
  days: number;
}

/** Phone-service reimbursement: a monthly rate × the months the user picked.
 *  Months are "YYYY-MM"; non-contiguous selections are fine. */
export interface PhoneService {
  enabled: boolean;
  months: string[];
  /** Dollars per month. Optional: batches saved before the rate was
   *  adjustable have none, and read back at the
   *  `PHONE_SERVICE_MONTHLY_USD` default (util/phone.ts `phoneServiceRate`). */
  rate?: number;
}

export interface Batch {
  id: string;
  employee: string;
  jobName: string;
  jobNumber: string;
  /** Optional per-diem allowance; rides the sync payload like every field. */
  perDiem?: PerDiem;
  /** Optional phone-service reimbursement; rides the sync payload too. */
  phoneService?: PhoneService;
  createdAt: number;
  updatedAt: number;
}

/** How the vendor identity was (or wasn't) confirmed by the visual logo layer. */
export interface LogoMatch {
  brand: string;
  /** Cosine similarity 0..1 against the brand-logo embedding index. */
  score: number;
  /** Which signal named the vendor: exact OCR text, visual logo, or AI assist. */
  source: "ocr" | "logo" | "ai";
}

/** Who read a receipt when the AI assist produced its result, and how
 *  (vision/provenance.ts builds it). Rides the sync payload with no
 *  migration. Absent on rules reads — and on AI reads stored before it
 *  existed, whose `ocrText` holds the model's answer instead of the OCR read
 *  (`isLegacyAiRead`). The endpoint URL and key are deliberately NOT
 *  recorded: a self-hosted host name is internal network topology that
 *  would sync and ship in mailed tuning bundles, and the key is a secret —
 *  `host` and `keySource` answer "where" and "whose" without either. The
 *  literal unions keep this file free of pipeline imports; assigning
 *  vision's `Backend`/`Strategy` to them makes tsc catch any drift. */
export interface AssistProvenance {
  backend: "local" | "selfhosted" | "cloud";
  /** The endpoint's label — the server KIND ("Ollama", "Self-hosted",
   *  "OpenRouter"…), never its address. */
  provider: string;
  /** The configured model id. */
  model: string;
  /** The model the server says answered, when it differs from `model`:
   *  OpenRouter's free router picks one per request, and a dated snapshot
   *  answers for an alias. An agent run lists each ("a, b"). */
  servedModel?: string;
  /** Where the model ran — this machine, the local network, or the internet
   *  (did the image leave the building?). Derived from the URL, never it. */
  host: "this-device" | "private-network" | "internet";
  /** Whose credential the call used: the user's own key, the build's free
   *  router key, the signed-in account proxy, or none (a keyless server). */
  keySource: "own" | "builtin" | "account" | "none";
  /** The strategy Settings asked for, and the one that ran — the account
   *  proxy relays one-shot reads only, so the two can differ. */
  requestedStrategy: "oneshot" | "agentic";
  strategy: "oneshot" | "agentic";
  viaProxy: boolean;
  /** Model calls the read took (1 for one-shot). */
  calls: number;
  /** The model's own answer — one-shot JSON, the agent's trace, or a
   *  thinking model's reasoning — tail-capped (`ASSIST_RAW_MAX`). */
  rawAnswer: string;
  /** The free rules tier's read the AI replaced: tells "rules were right and
   *  the model broke it" apart from "both missed". */
  rules: {
    vendor: string;
    date: string;
    amount: number;
    tax: number;
    category: Category;
    confidence: number;
  };
}

/** A brand the user taught the app by uploading a logo image (zero-shot,
 *  no retraining) — stored locally, synced to `brand_logos` when signed in. */
export interface StoredBrand {
  id: string;
  name: string;
  category: Category;
  /** L2-normalized image-embedding vector of the reference logo. */
  embedding: number[];
  createdAt: number;
}

export interface Receipt {
  id: string;
  batchId: string;

  /** Pointer to the original blob in the file store (IndexedDB blob store). */
  fileKey: string;
  /** Pointer to the cleaned/downscaled image the OCR boxes map to (review + export). */
  annotatedKey?: string;
  cleanedKey?: string;
  /** Basename-only, sanitized original filename — for display and export. */
  fileName: string;
  /** The upload's original name, kept when the file is renamed to the
   *  {category}_{MM-DD-YY}_{vendor} convention after extraction. */
  originalFileName?: string;
  mimeType: string;

  status: ReceiptStatus;

  /** SHA-256 of the cleaned image bytes — extraction cache key + dedup key. */
  imageHash?: string;

  // Extracted fields (each carries its own confidence + provenance bbox).
  vendor: Field<string>;
  date: Field<string>; // ISO yyyy-mm-dd
  amount: Field<number>; // grand total, in US dollars
  tax: Field<number>;
  currency: string; // always "USD" — kept for the stored-data shape (older rows may carry other codes)
  category: Field<Category>;

  /** Overall 0..1 confidence across the receipt. */
  confidence: number;
  flags: Flag[];

  /** Full OCR text, kept for re-parsing and the review panel. */
  ocrText?: string;
  /** Pruned per-line OCR geometry (no words), kept so a human correction can
   *  be located and re-highlighted on the image and logged for training. */
  ocrLines?: OcrLine[];

  /** Result of the visual-logo / brand-identity fusion, when it ran. */
  logoMatch?: LogoMatch;

  methodUsed: ExtractionMethod;
  /** When an AI assist produced the result, "provider · model · one-shot|
   *  agentic, N calls" (vision/provenance.ts `assistMethodDetail`) for the
   *  review panel + an honest audit trail. Absent on the free rules path. */
  methodDetail?: string;
  cost: number; // dollars spent on this receipt (free path = 0)
  /** Who read it and how, when an AI assist produced the result. */
  assist?: AssistProvenance;

  approved: boolean;
  reviewRequired: boolean;

  /** Dimensions of the cleaned image, for mapping bboxes to pixels. */
  imageWidth?: number;
  imageHeight?: number;

  error?: string;

  createdAt: number;
  updatedAt: number;
}

export interface Job {
  id: string;
  receiptId: string;
  attempts: number;
  /** Epoch ms when a worker claimed this job (null = available). */
  lockedAt: number | null;
  /** Epoch ms when the job was queued — the claim order. Ids are random
   *  UUIDs, so key order (the old claim order) was random: a 40-photo drop
   *  processed in no relation to the order it was added. Absent on jobs
   *  queued by older versions, which claim first. */
  createdAt?: number;
}

/** Stored original/derived image bytes. The "file store" of §4. */
export interface StoredBlob {
  key: string;
  blob: Blob;
  kind: "original" | "cleaned" | "annotated" | "export";
  createdAt: number;
}

/** What the OCR capability returns — interface, not a specific model (§5). */
export interface OcrWord {
  text: string;
  confidence: number; // 0..100 from the engine
  bbox: BBox; // normalized to the image it ran on
}

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: BBox;
  words: OcrWord[];
}

export interface OcrResult {
  text: string;
  confidence: number; // 0..100 overall
  lines: OcrLine[];
  words: OcrWord[];
}
