# DueBack

**Receipts in. What you're due, back.**

Snap or drop a pile of receipts. They're read **on your device**, the text
*and* the logos. You review the flagged ones in a keyboard-driven sweep, and
out comes a polished multi-sheet Excel workbook with the receipt images
embedded and totals that foot. Free, no install, no account required.

Built from scratch as a browser-only successor to the original local
[Reimbursements](https://github.com/duedev/Reimbursements) app: same
battle-tested extraction ideas (vendor database, amount reconciliation,
US-first dates, confidence + dedup, review UX, themed workbook), re-architected
for the web with two new pillars: **visual logo recognition** and an
**optional Supabase sync layer**.

## How it works

1. **Snap or drop:** photos, scans, or PDFs; the phone camera works directly.
   Each image is straightened, cleaned, and read on-device.
2. **Review the flagged few:** most receipts file themselves; the uncertain
   ones queue for an `Approve & Next` sweep with each extracted field
   highlighted right on the image (with zoomed callouts).
3. **Download the workbook:** a themed `.xlsx` (Summary that foots with real
   formulas, an Insights dashboard with charts, per-category sheets with the
   receipt images embedded) plus a one-click CSV and an images ZIP.

## The extraction pipeline

| Stage | What runs |
|---|---|
| Clean | EXIF auto-rotate → optional perspective straightening (OpenCV.js, lazy) → grayscale → edge-energy auto-crop → downscale |
| Read | **Tesseract.js** on-device (default, $0, offline), or the opt-in **PaddleOCR PP-OCRv5** tier on onnxruntime-web for tough photos |
| Name the merchant | curated **~300-brand vendor DB** with word-boundary matching, **glyph-normalized** OCR-confusion folding (`7-ELEUEN` → 7-Eleven), printed-slogan aliases ("How doers get more done." → The Home Depot), and a bounded fuzzy backstop |
| **See the logo** | when the name is a logo the OCR can't spell: CLIP image embeddings (transformers.js, on-device) vs. a brand-logo index. **Teach it any brand with one image**, no retraining |
| Extract | grand-total selection reconciled against the receipt's own arithmetic (subtotal + tax footing, pump math on fuel receipts), US-first dates, tax, currency, category |
| Trust | per-field confidence + provenance boxes, flags, semantic + image-hash duplicate detection; anything the rules can't verify is queued for manual review instead of shipping wrong |
| Assist (opt-in) | low-confidence receipts can get a vision-LLM second opinion. Bring your own key, or sign in and use the server-keyed proxy |

Everything above the "Assist" row runs entirely in your browser.

## Privacy model

- **Default:** receipts never leave your device. Storage is IndexedDB; OCR,
  logo recognition, and the Excel build are all client-side.
- **AI assist (opt-in):** low-confidence receipts go to the model you chose.
- **Sync (opt-in):** signing in mirrors your data to *your own* Supabase
  workspace with row-level security. See [`SUPABASE_SETUP.md`](./SUPABASE_SETUP.md).

## Develop

```bash
npm install
npm run dev        # vendors Tesseract assets, starts Vite
npm test           # unit suites (node:test via tsx)
npm run testkit    # the fixed accuracy gate (9 challenge receipts + logo case)
npm run typecheck  # tsc + svelte-check
npm run build      # typecheck + production build (dist/)
```

Optional tiers:

```bash
npm i onnxruntime-web && npm run vendor:paddle   # PaddleOCR tier
VITE_OCR_ENGINE=paddle npm run dev
```

## Deploy

Static output (`dist/`) with a GitHub Pages workflow included
(`.github/workflows/deploy.yml`). Optional build-time settings:
`OPENROUTER_API_KEY` (free zero-click AI assist), `VITE_SUPABASE_URL` +
`VITE_SUPABASE_ANON_KEY` (sync layer). The app is embeddable in an iframe
(e.g. a Carrd Embed block); it's a single relative-path static bundle.

## Stack

Vite · TypeScript · Svelte 5 · Tesseract.js / PaddleOCR (onnxruntime-web) ·
transformers.js (CLIP) · ExcelJS + Chart.js · idb · Supabase (optional) · PWA.
