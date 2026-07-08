# CLAUDE.md — Repo Map & Working Notes

> Read this first; open only the files you need. Update it when structure changes.

## What this is

**DueBack** (repo `ReimbursementsF5`, formerly "Reimbursements F5") — a
browser-only receipt → reimbursement-report app. `APP_NAME` in
`src/config/constants.ts` is the single product-name source; the IndexedDB
name stays `reimbursements-f5` so existing users keep their data.
Receipts are read **on-device** (OCR + visual logo recognition), reviewed in a
keyboard sweep, and exported as a themed multi-sheet Excel workbook. Local-first
(IndexedDB); **optional** Supabase layer adds auth/sync/realtime and a
server-keyed AI assist. Static build, embeddable (Carrd), PWA.

Rebuilt from scratch from the Python app in `../Reimbursements` (see its
`CLAUDE.md`); the extraction *ideas/data* are ported, not the code. Intended to
be transplanted to `duedev/ReimbursementsF5`.

## Stack

Vite 7 · TypeScript · Svelte 5 (runes) · Tesseract.js (default OCR, vendored) ·
PaddleOCR on onnxruntime-web (opt-in tier) · transformers.js CLIP (logo layer,
lazy) · ExcelJS + Chart.js (export) · idb · @supabase/supabase-js (optional) ·
vite-plugin-pwa. Fonts self-hosted (@fontsource Inter + Fraunces).

## Map

| Path | What lives here |
|---|---|
| `src/types.ts` | Domain model: Receipt/Batch/Job/Field/Flag/LogoMatch/StoredBrand |
| `src/pipeline/pipeline.ts` | Per-receipt flow: clean → hash/cache → OCR (+binarized weak-read rescue) → rules → **logo fusion** → vision assist → highlighter bake (`annotate.ts` → `annotatedKey`) → Python-convention rename (`util/rename.ts`) → dedup → status |
| `src/pipeline/imagePrep.ts` | canvas prep: EXIF rotate → (opt) perspective → projection-profile deskew → grayscale → edge-energy autocrop → two renders (transient hi-res `ocrBlob` for OCR + stored 1600px blob); `binarizeBlob` for the weak-read rescue |
| `src/pipeline/binarize.ts` | pure image math (no DOM, Node-tested): luminance, Bradley adaptive threshold, projection-profile skew estimation |
| `src/pipeline/perspective.ts` | opt-in OpenCV.js quad detect + warp (`VITE_PERSPECTIVE=1`, vendored lib) |
| `src/pipeline/ocr.ts` | `OcrEngine` seam; Tesseract default; `VITE_OCR_ENGINE=paddle` → `engines/paddle/*` (ONNX det+rec+CTC) |
| `src/config/vendors.ts` | Brand matcher: curated table + `src/data/vendorDb.extra.json` (generated, 329 brands); passes: exact → glyph-normalized (`normalizeGlyphs`) → bounded fuzzy (`fuzzyMatchVendor`); slogans as long aliases |
| `src/pipeline/extract.ts` | Rules: grand-total tiers + reconcile, **pump-math reconcile** (corroboration-gated; payment-line anchors correct, non-payment anchors keep), footing math with tip guard, US-first dates (stamp-glyph repair), tax, vendor line heuristic (greeting/address/pump-data rejects) + fuzzy hook, confidence, flags, `forcesManualReview()` (**`total_suspect`**/`vendor_unclear` warns force review — `total_mismatch` stays advisory), `locateValue()` (post-hoc field location for corrections) |
| `src/train/corrections.ts` | The improvement loop: review edits diffed into `CorrectionRecord`s (with located bbox + OCR line), appended to kv `training.log` (cap 2000); Settings → Improvement log downloads/clears it |
| `src/pipeline/logo/` | Visual logo layer: `embedder.ts` (CLIP seam, lazy, test-fakeable), `index.ts` (bundled `logoIndex.json` + user brands, cosine NN, header-band crop, `addBrandFromImage`), `fuse.ts` (Layer-3 fusion; `LOGO_ACCEPT`) — inert (no model download) while the index is empty |
| `src/pipeline/vision/` | Opt-in AI assist (OpenRouter/Gemini/Anthropic), spend cap, build-time free key; signed-in users route via `supabase/aiProxy.ts` → `ai-extract` Edge Function |
| `src/store/` | `db.ts` (IndexedDB v1: batches/receipts/jobs/blobs/brands/kv), `repo.ts` (the one read/write + notify seam), `sync.ts` (Supabase mirror: LWW on `updatedAt`, storage blobs, realtime) |
| `src/supabase/` | `client.ts` (null unless `VITE_SUPABASE_URL/ANON_KEY`), `auth.ts`, `aiProxy.ts` |
| `src/ui/` | Svelte 5: `theme.css` (tokens, light/dark), `state.svelte.ts` (the one reactive bridge), `App/Landing(hero+marketing)/Workspace/Card/Dropzone/ReviewModal/ExportBar/Settings/Toasts/ThemeToggle` |
| `src/export/` | `zip.ts` (dependency-free ZIP for the images download), `workbook.ts` (xlsx in the ORIGINAL app's layout: Summary form w/ per-category tables whose `#` cells hyperlink to per-receipt anchors on the category image sheets; anchors precomputed via `blockRows` — keep in sync with the image-block layout; no flat "All Receipts" sheet — the Summary IS the receipt table; Insights = executive dashboard of KPI tiles + 5 charts), `charts.ts` (Chart.js→PNG), `insights.ts`, `csv.ts`, `images.ts` |
| `supabase/` | `migrations/0001_core.sql` (tables+RLS+storage+realtime), `0002_pgvector.sql` (optional), `functions/ai-extract` (key-holding chat-completions proxy), `functions/logo-search` |
| `scripts/` | `vendor-tesseract.mjs` (prebuild), `vendor-paddle.mjs` (opt-in), `export_vendor_db.py` (regenerates vendorDb.extra.json from `../Reimbursements/vendor_db.py`), `gen-icons.mjs` |
| `tests/` | node:test via tsx; `testkit/` = the fixed 9-challenge accuracy gate (+ logo case); `e2e.mjs` + `screenshots.mjs` (Playwright vs `vite preview`) |

## Commands

`npm run dev` · `npm test` · `npm run testkit` · `npm run typecheck` (tsc +
svelte-check) · `npm run build` · `npm run e2e` · `node tests/screenshots.mjs`.

## Gotchas

- **Svelte $state proxies can't enter IndexedDB** — `structuredClone` throws on
  them. Unwrap with `$state.snapshot(...)` before any `repo` write that carries
  objects from reactive state (see `ReviewModal.patchFromForm`).
- **Money parsing is US-first and deliberately strict** (`util/money.ts` +
  `MONEY_SRC` in `extract.ts`): a single dot with 3 decimals is a *decimal*
  ("$3.499/gal", "11.204 GAL"), never thousands grouping — the permissive form
  read gallons as $11,204 and promoted it to the total. Dot-grouping only
  counts as money with a comma-cents tail. Within a total tier the **largest**
  value wins (FUEL TOTAL vs combined TOTAL, as in the original app), and the
  line *below* a label-only TOTAL must match strict money (a lenient grab
  there turned "Date: 05/10/2026" into a $2,026 total).
- **OCR reads a transient higher-res render (`ocrMaxEdge` 2600px), not the
  stored 1600px blob** — both come from the same cleaned frame, so normalized
  boxes land on either; never persist `ocrBlob`. Binarization is retry-only
  (`OCR_RESCUE`): it rescues unevenly lit photos but can hurt clean scans, so
  it only runs when the grayscale pass reads weak or finds no amount.
- **Copy a picker's FileList before clearing `input.value`**
  (Landing/Dropzone `onPicked`) — resetting the input empties the live
  FileList mid-await, silently dropping every file after the first.
- **`npm run e2e` is the real-OCR accuracy gate** — three receipts (easy
  coffee, fuel with per-gallon pricing + FUEL TOTAL, split-label TOTAL) run
  through actual Tesseract in Chromium with per-receipt amount assertions. The
  testkit exercises the rules on synthetic text only; regressions in the real
  path show up here.
- **Digit-only brand aliases ("76") are excluded from the glyph pass** — its
  punctuation stripping would turn a price ending `.76` into a brand hit; the
  exact pass (with the numeric boundary guard) is where they match.
- The logo layer never downloads the CLIP model while the index is empty
  (`logoIndexAvailable()` gate). Tests inject a fake via `setEmbedderFactory`.
- Export modules (ExcelJS/Chart.js) are **lazy-imported** in `ExportBar` — keep
  it that way; they dominated the main chunk otherwise.
- `buildWorkbook` must keep working headless (Node tests): chart rendering
  returns null without a DOM and the workbook builds without images.
- Curated `KNOWN_VENDORS` beats the generated JSON on name conflicts; regenerate
  the JSON with `python3 scripts/export_vendor_db.py` (commit the result).
- **Taxonomy: Fuel and Materials lead `CATEGORIES`, Other closes** — and the
  workbook renders Other as "Miscellaneous" (`displayCategory`). Hardware/
  building brands map to Materials (the original's `mats`). The meals category
  is named **"Meals"** (renamed from "Meals & Entertainment"); legacy stored
  values are normalized on every `repo` read (`LEGACY_CATEGORIES`).
- **`total_mismatch` is advisory; `total_suspect` gates.** Only the dedicated
  `total_suspect` warn (and `vendor_unclear`) force `needs_review` — reconcile's
  advisories fire on ordinary tip/savings/balance receipts and must not. Tip
  awareness must stay symmetric between `applyFootingMath` and parseReceipt's
  far-above-subtotal gate (2× subtotal ceiling with a TIP line, 1.5× without).
- **Receipts persist pruned `ocrLines`** (text+bbox, no words) so a review
  correction can be re-located (`locateValue`), re-highlighted (ReviewModal
  `applyPatch` re-bakes the annotated copy), and logged for training.
- **Board views:** Workspace has a Grid/Kanban toggle + sort select
  (localStorage `board.view`/`board.sort`); kanban lanes are status groups.
- **Dark scan borders** (CamScanner sawtooth strips) are trimmed by
  `darkBorderInsets` (binarize.ts, Node-tested) before the edge-energy crop —
  pre-scanned uploads otherwise look "uncropped" (nothing else to trim).
- **Corrections never silently swap a plausible total.** Pump/footing math only
  auto-corrects decimal-slip-scale garbles (ratio ≈ ×10/×100) or values the
  receipt's own arithmetic contradicts; anything moderate keeps the printed
  total and emits a warn-severity `total_mismatch`, which — like
  `vendor_unclear` — forces `needs_review` via `extract.forcesManualReview()`.
  Tips (TIP_RE) widen footing's expectations; per-gallon price lines are
  excluded from reconcile's `allMax`.
- **Workbook columns autofit** (`autofitColumns` in workbook.ts — ExcelJS has
  none): merged band cells are skipped, notes wrap in a capped column
  (`NOTES_WRAP_CHARS` drives row heights). Insights keeps FIXED widths — the
  two-up chart grid anchors images at column offsets 0/6, so autofitting there
  would overlap the charts. Chart text renders ~26px (titles 34px) because the
  900px canvases embed at 0.62 scale (≈ 16px / 21px on-sheet).
- **Receipts are renamed post-extraction** to `{cat}_{MM-DD-YY}_{vendor}.ext`
  (`util/rename.ts`, the original app's convention); the upload's name survives
  in `originalFileName` — the e2e keys receipts by it, not `fileName`.
- `.env.example` lists every knob; all optional. Deploy secrets/vars are wired
  in `.github/workflows/deploy.yml`.
