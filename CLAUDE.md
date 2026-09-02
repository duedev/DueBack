# CLAUDE.md — Repo Map & Working Notes

> Read this first; open only the files you need. Update it when structure changes.

## What this is

**DueBack** (repo `duedev/DueBack`, formerly "Reimbursements F5"; deployed at
`dueback.duanehamilton.net`) — a browser-only receipt → reimbursement-report
app. `APP_NAME` in `src/config/constants.ts` is the single product-name source; the IndexedDB
name stays `reimbursements-f5` so existing users keep their data.
Receipts are read **on-device** (OCR + visual logo recognition), reviewed in a
keyboard sweep, and exported as a themed multi-sheet Excel workbook. Local-first
(IndexedDB); **optional** Supabase layer adds auth/sync/realtime and a
server-keyed AI assist. Static build, embeddable (Carrd), PWA.

Rebuilt from scratch from the Python app in `../Reimbursements` (see its
`CLAUDE.md`); the extraction *ideas/data* are ported, not the code.

## Stack

Vite 7 · TypeScript · Svelte 5 (runes) · Tesseract.js (default OCR, vendored) ·
PaddleOCR on onnxruntime-web (opt-in tier) · transformers.js CLIP (logo layer,
lazy) · ExcelJS + Chart.js (export) · idb · @supabase/supabase-js (optional) ·
vite-plugin-pwa. Fonts self-hosted (@fontsource Inter + **Lora** for display; Lora replaced Fraunces, whose display letterforms — the lowercase f — kept reading as a glitch).

## Map

| Path | What lives here |
|---|---|
| `src/types.ts` | Domain model: Receipt/Batch/Job/Field/Flag/LogoMatch/StoredBrand |
| `src/pipeline/pipeline.ts` | Per-receipt flow: clean → hash/cache → OCR (+binarized weak-read rescue) → rules → **logo fusion** → vision assist → highlighter bake (`annotate.ts` → `annotatedKey`) → Python-convention rename (`util/rename.ts`) → dedup → status |
| `src/pipeline/imagePrep.ts` | canvas prep: EXIF rotate → (opt) perspective → projection-profile deskew → grayscale → autocrop (paper-slab first via `paperRegionBox`, edge-energy fallback) → two renders (transient hi-res `ocrBlob` for OCR + stored 1600px blob); `binarizeBlob` for the weak-read rescue |
| `src/pipeline/pdf.ts` | Multi-page PDF intake: `expandPdf` renders pages to JPEG (long edge ≈ `ocrMaxEdge`) so `addFiles` makes one receipt per page, capped by the remaining batch capacity (+ `LIMITS.maxPdfPages` backstop) so an unbounded PDF can't rasterize past the cap; one corrupt page is skipped and reported (`failedPages`) instead of discarding the pages that rendered; password-protected PDFs are refused at intake with a toast (`isPasswordProtectedPdf`) rather than queued to fail; `pdfPageNames` names them (`… (page 2 of 8)` in `originalFileName`) |
| `src/pipeline/unzip.ts` | ZIP intake: dependency-free central-directory reader (`readZip`, platform `DecompressionStream`) + archive-junk filter and entry naming; inflation is STREAMED with a running byte count that aborts past `maxEntryBytes` (the forgeable directory size is only a fast path) plus a per-archive `maxTotalBytes`; `addFiles` unpacks an archive into one receipt per usable file, nested folders and all |
| `src/pipeline/binarize.ts` | pure image math (no DOM, Node-tested): luminance, Bradley adaptive threshold, projection-profile skew estimation, `paperRegionBox` (Otsu + saturation gate + largest connected component — the tight-crop pass that ignores food/clutter next to the receipt) |
| `src/pipeline/perspective.ts` | opt-in OpenCV.js quad detect + warp (`VITE_PERSPECTIVE=1`, vendored lib) |
| `src/pipeline/ocr.ts` | `OcrEngine` seam; Tesseract default; `VITE_OCR_ENGINE=paddle` → `engines/paddle/*` (ONNX det+rec+CTC) |
| `src/config/vendors.ts` | Brand matcher: curated table + `src/data/vendorDb.extra.json` (generated, 329 brands; curated wins on name AND alias claims at merge); passes: exact → glyph-normalized (`normalizeGlyphs`) → header-line edit-distance sweep (`fuzzyMatchVendorLines`, merchant-shaped lines only, adopts at `FUZZY_HINT_RATIO`, `FUZZY_STOPWORDS` = known real-word colliders) → bounded fuzzy (`fuzzyMatchVendor`); slogans as long aliases. Wallet tender phrases ("GOOGLE PAY") and `BRAND_EXCLUSIONS` ("subway fare") are masked before every pass; `GENERIC_ALIASES` (shell, hilton, google…) only count on trustworthy header lines via `extract.matchKnownVendor` |
| `src/pipeline/extract.ts` | Rules: grand-total tiers + reconcile (`NON_GRAND_RE` also drops pre-discount "MERCHANDISE TOTAL / TOTAL BEFORE COUPONS" lines; the lenient bare-integer read applies only to label+value-shaped lines, `isLabelValueLine`), **pump-math reconcile** (corroboration-gated; payment-line anchors correct, non-payment anchors keep), footing math with tip guard (never ADOPTS subtotal + tax when the tax exceeds `TAX_MAX_RATIO` of the subtotal — keeps the printed total, `total_suspect`), US-first dates (stamp-glyph repair; a clock time can't donate its hour as a year; ctime order recovers the trailing year; date labels are ranked invoice/order/transaction date > bare Date > unlabeled > due/expiry/ship date), tax (`TAX_ID_RE`/`TAX_RATE_RE` reject registration/rate lines; a printed TOTAL TAX wins, component STATE/COUNTY/CITY lines sum only when total − subtotal corroborates; a tax larger than the printed subtotal — or at/above the settled total when no subtotal is printed — is dropped as a garble), vendor line heuristic (greeting/address/city-in-address-block/date-or-timestamp/tender/staff/footer/loyalty/pump-data rejects; trailing `#NNN` store numbers stripped) + `matchKnownVendor` (generic aliases scoped to header lines) + fuzzy hook, refund/return sign detection (magnitude kept, `total_suspect` gates), confidence, flags, `forcesManualReview()` (**`total_suspect`**/`vendor_unclear` warns force review — `total_mismatch` stays advisory), `locateValue()` (post-hoc field location for corrections; word-bounded vendor probe, shares `lenientTotalLine` with findAmount) |
| `src/train/corrections.ts` | The improvement loop: review edits diffed into `CorrectionRecord`s (with located bbox + OCR line), appended to kv `training.log` (cap 2000); Settings → Improvement log downloads/clears it. `bundle.ts` builds the tuning ZIP (corrections + extraction.json + CSV + original/annotated images), shared by Settings and the landing contact form |
| `src/pipeline/logo/` | Visual logo layer: `embedder.ts` (CLIP seam, lazy, test-fakeable), `index.ts` (bundled `logoIndex.json` + user brands, cosine NN, header-band crop, `addBrandFromImage`), `fuse.ts` (Layer-3 fusion; `LOGO_ACCEPT`) — inert (no model download) while the index is empty |
| `src/pipeline/vision/` | Opt-in AI assist (OpenRouter/Gemini/Anthropic), spend cap, build-time free key; signed-in users route via `supabase/aiProxy.ts` → `ai-extract` Edge Function |
| `src/store/` | `db.ts` (IndexedDB v1: batches/receipts/jobs/blobs/brands/kv; the open forgets itself on `terminated`/`blocking`/rejection so the next call reopens, and `upgrade` is STEPPED — `if (oldVersion < N)` per version, never an unconditional createObjectStore), `repo.ts` (the one read/write + notify seam; `updateReceipt` is a single-transaction read-modify-write with an optional `expect.updatedAt` compare-and-swap that returns null on a miss; deletes record kv pending-delete entries for sync; `wipeLocalData` clears the stores WITHOUT tombstones), `sync.ts` (Supabase mirror: LWW on `updatedAt` BOTH ways — pull via `syncMerge.remoteAction`, push via migration 0004's `lww_guard` trigger; deletes propagate as `deleted_at` tombstones consumed from kv `sync.pendingDeletes` and pushed before upserts and before the first pull; realtime on receipts+batches+brand_logos, a rejoin after a gap triggers a catch-up pull; uploaded-blob memory is per-account kv `sync.uploadedBlobs.<uid>`; the pull is PAGED (`fetchAll`, 1000 rows/page over id order, advancing by the rows returned and stopping only on an EMPTY page — PostgREST's cap silently truncated bigger workspaces, and a deployment whose `max-rows` is below the page size returns short pages that are not the end); a pull also back-fills missing images for rows that were already up to date (an earlier failed download otherwise left the card blank until the row changed); `start()` FAILS CLOSED when kv `sync.ownerUserId` names a different account and local data exists (`syncMerge.ownerDecision` — a shared laptop where A signed out and B signed in used to push A's receipts into B's workspace), `sync.foreignOwner` + `FOREIGN_OWNER_MESSAGE` surface it (Workspace chip → Settings, which offers "Remove this device's local copy" = `state.resetLocalCopy` → `repo.wipeLocalData`), and the owner mark is written after the first successful push; a push carries only rows stamped since the last successful one (`changedSince`, kv `sync.lastPushAt.<uid>`, inclusive so a same-millisecond edit is never skipped — every debounce tick used to upsert the whole store with full payloads), while blob uploads still walk every receipt through the `uploaded` set; blobs upload BEFORE row upserts so the other device's realtime apply finds them; a tombstone only removes storage objects when it LANDED (`tombstoneLanded` on the update's returned row — the `lww_guard` may keep a revived row); UI announcements (`announce()`) never echo into a push; `start()` is single-flight per user and returns whether it freshly started, which is the only time batch adoption runs), `syncMerge.ts` (pure Node-tested sync decisions: LWW/tombstone action, pending-delete log, batch adoption, paging, tombstone landing, owner decision), `jobs.ts` (saved job name⇄number pairs in kv `jobs.saved`, local-only; pure list helpers are Node-tested) |
| `src/supabase/` | `client.ts` (null unless `VITE_SUPABASE_URL/ANON_KEY`), `auth.ts`, `aiProxy.ts` |
| `src/onedrive/` | Optional "Save to OneDrive" (no SDK, hidden unless `VITE_ONEDRIVE_CLIENT_ID`; ONEDRIVE_SETUP.md): `core.ts` (pure, Node-tested: PKCE, auth URL, token mapping, Graph upload w/ injectable fetch), `store.ts` (env + localStorage tokens), `popup.ts` (OAuth-popup relay, called by `main.ts` before mount), `index.ts` (connect popup / refresh / `uploadReport` → `Apps/DueBack`; the report bar uploads the workbook AND the print packet as two files). Errors are typed: `TokenEndpointError` (a refusal — the grant is dead, tokens cleared, popup next) vs plain errors for transport/5xx/429 (tokens KEPT, message shown — a network blip used to force re-consent), `GraphError.status` for Graph; a 401 on upload refreshes silently and, failing that, clears the tokens and asks for a second click (the popup must open inside a gesture) |
| `src/ui/` | Svelte 5: `theme.css` (tokens, light/dark — dark is a warm ladder anchored on `#12100e`, the PWA chrome color), `state.svelte.ts` (the one reactive bridge; `applyTheme` also syncs the theme-color meta pair), `App/Workspace/Card/Dropzone/ReviewModal/ExportBar/Settings/Toasts/ThemeToggle`, `BrandLogo.svelte` (the receipt+return-arrow mark — same glyph as `public/icons/favicon.svg`, keep in sync; used by both headers and the footer); `Landing.svelte` is the marketing orchestrator over `landing/` (Hero/How/Logo/Workbook/Contact partials + `landing.css` shared vocabulary) — ONE scrolling page with a sticky anchor nav (scroll-spy highlights the section in view), a nerd-only Roadmap section, and a Nerd-mode toggle (`landing/prefs.svelte.ts`, kv-free localStorage) revealing `.db-nerd` engineering notes |
| `src/export/` | `order.ts` (THE report order — `exportableReceipts`/`byReportOrder` (date, then createdAt, then id: a total order), `reportOrder` (category sections), `displayCategory` — shared by the workbook, the CSV and the ExportBar's print packet; ExcelJS-free so the bar can sort without the lazy export chunk), `zip.ts` (dependency-free ZIP for the images download), `printPdf.ts` (dependency-free print packet: receipts 2-up on Letter with the employee header, Node-tested; text is Latin-1 for WinAnsi Helvetica — `pdfText` NFC-normalizes and keeps 0xA0–0xFF, content streams are latin1-encoded, never TextEncoder; captions carry a `label` ("Fuel #2") that is never truncated; ExportBar downloads it WITH the workbook — kv `report.printPacket`, default ON), `anchor.ts` (px→EMU drawing anchors — the one place image geometry is computed), `workbook.ts` (xlsx in the ORIGINAL app's layout: Summary form w/ per-category tables whose `#` cells link to per-receipt anchors on the category image sheets as `HYPERLINK("#'Sheet'!A4", n)` FORMULAS with a numeric result — ExcelJS can only write a hyperlink-typed cell as text, which tripped Excel's "number stored as text" triangle on every receipt row; tests/e2e detect either shape via `linkTarget`; Insights' Top Vendors COUNTIF/SUMIF over the per-category receipt RANGES, never `$C:$C` (the employee cell and section headers live in C); anchors precomputed via `blockRows` — keep in sync with the image-block layout; no flat "All Receipts" sheet — the Summary IS the receipt table; **single source of truth**: category-sheet amounts are the stored values, Summary amount cells reference them, Insights KPIs/tables are COUNT/MAX/SUMIF formulas over Summary — edit one amount and everything re-foots; optional allowance lines — per diem (`Batch.perDiem`, `util/perdiem.ts`) and phone service (`Batch.phoneService`, `util/phone.ts`) — sit between the sections and the TOTAL; Insights = executive dashboard of KPI tiles + 5 charts, **`WorkbookOptions.insights` defaults off at the API; the ExportBar toggle defaults ON (kv `report.insights`)**), `charts.ts` (Chart.js→PNG; native xlsx charts are NOT possible with ExcelJS — the PNGs are the deliberate trade; the share doughnut draws `insights.shareSlices` — top 7 + one "All other" remainder so the percentages foot to 100%), `insights.ts`, `csv.ts` (`toCsvBytes` = BOM + UTF-8 for the tuning bundle; `csvField` prefixes `'` to cells starting `= + - @` so an OCR'd vendor can't execute on import), `images.ts` |
| `supabase/` | `migrations/0001_core.sql` (tables+RLS+storage+realtime), `0002_pgvector.sql` (optional), `0003_ai_limits.sql` (`ai_usage` per-user daily AI counts, service-role only), `0004_sync_integrity.sql` (`deleted_at` tombstones, `lww_guard` trigger, composite `(user_id, id)` PKs, realtime for batches/brand_logos), `functions/ai-extract` (POLICED key-holding proxy: model allowlist `AI_ALLOWED_MODELS`, max_tokens cap, per-user daily limit `AI_DAILY_LIMIT`; pure policy in `policy.ts`, Node-tested), `functions/logo-search` |
| `scripts/` | `vendor-tesseract.mjs` (prebuild), `vendor-paddle.mjs` (opt-in), `export_vendor_db.py` (regenerates vendorDb.extra.json from `../Reimbursements/vendor_db.py`), `gen-icons.mjs`, `gen-og.mjs` (the 1200×630 share image `public/og.png` behind `og:image`/`twitter:image` — absolute URLs in index.html, excluded from the PWA precache) |
| `tests/` | node:test via tsx; `testkit/` = the fixed 9-challenge accuracy gate (+ logo case); `e2e.mjs` + `screenshots.mjs` (Playwright vs `vite preview`) |

## Commands

`npm run dev` · `npm test` · `npm run testkit` · `npm run typecheck` (tsc +
svelte-check) · `npm run build` · `npm run e2e` · `node tests/screenshots.mjs`.

## Gotchas

- **Svelte $state proxies can't enter IndexedDB** — `structuredClone` throws on
  them. Unwrap with `$state.snapshot(...)` before any `repo` write that carries
  objects from reactive state (see `ReviewModal.patchFromForm`).
- **The app is USD-only.** Nothing detects or selects a currency: extraction
  and the vision tier always emit `currency: "USD"` (the field stays on
  `Receipt` for the stored-data shape; a ReviewModal save normalizes legacy
  values), `formatMoney` takes no currency, the workbook always renders `$`,
  and the CSV's Currency column is pinned to "USD" (a legacy stored code
  must not contradict the workbook). Don't add per-receipt currency back
  without a product decision.
- **Horizontal touch-panning is clipped at the root** (`html, body`
  `overflow-x: hidden` then `clip`, theme.css — declaration order is the
  fallback and test-pinned; no `overscroll-behavior-x`, which would kill
  swipe-back history navigation). Any element poking past the viewport
  otherwise lets mobile swipes drag the page sideways — and under the clip an
  overflowing bar strands its controls off-screen instead. So fix real
  offenders too: BOTH headers compact below 560px (landing nav: wordmark +
  Nerd-mode label hide; workspace header: wordmark + Delete-all label hide
  and the row wraps) because brand + actions genuinely didn't fit a phone.
  The e2e asserts both surfaces fit 390px with the clip disabled and that
  Settings opens at phone width. Wide content that should scroll gets its
  own `overflow-x: auto` container.
- **Money parsing is US-first and deliberately strict** (`util/money.ts` +
  `MONEY_SRC` in `extract.ts`): a single dot with 3 decimals is a *decimal*
  ("$3.499/gal", "11.204 GAL"), never thousands grouping — the permissive form
  read gallons as $11,204 and promoted it to the total. Dot-grouping only
  counts as money with a comma-cents tail. Within a total tier the **largest**
  value wins (FUEL TOTAL vs combined TOTAL, as in the original app), and the
  line *below* a label-only TOTAL must match strict money (a lenient grab
  there turned "Date: 05/10/2026" into a $2,026 total) — and must not be a
  payment/non-grand line (`NON_GRAND_RE`/`PAYMENT_RE`): "TOTAL" ↵ "CASH 20.00"
  shipped the cash tendered as the total. The lenient bare-integer read on the
  label line itself applies only to label+value-shaped lines
  (`isLabelValueLine`): a header that merely contains "total" ("TOTAL WINE &
  MORE #1234") must not donate its store number. `locateValue`/
  `readValueInBox` share that rule via `lenientTotalLine` — keep them in sync.
- **OCR reads a transient higher-res render (`ocrMaxEdge` 2600px), not the
  stored 1600px blob** — both come from the same cleaned frame, so normalized
  boxes land on either; never persist `ocrBlob`. Binarization is retry-only
  (`OCR_RESCUE`): it rescues unevenly lit photos but can hurt clean scans, so
  it only runs when the grayscale pass reads weak or finds no amount.
- **Copy a picker's FileList before clearing `input.value`**
  (Landing/Dropzone `onPicked`) — resetting the input empties the live
  FileList mid-await, silently dropping every file after the first.
- **Landing's hidden file input lives in `Landing.svelte` (the orchestrator)
  and must stay the page's only `input[type=file][multiple]`** — e2e and
  screenshots drive it via `.first()`; Hero and the final CTA trigger it
  through the `onAdd` prop / `pick()`. The hero h1 must keep matching
  `/Receipts in/` (both test suites wait on it).
- **The landing is ONE scrolling page; the hash is only an anchor** (nav:
  `#how`, `#workbook`, `#faq`, `#contact`; scroll-spy lights the active
  link). Every hash the multi-page eras handed out still lands via
  `ANCHOR_FOR_HASH` (`#privacy`/`#account` → their FAQ `<details>`, popped
  open before scrolling; `#time`/`#features` → `#how`; `#help` → `#faq`;
  `#roadmap` → the nerd-only roadmap; `#home` → top) — keep old links
  working when sections move; nerd-gated targets fall back to a visible
  host (`VISIBLE_FALLBACK`: account→privacy, roadmap→faq) when the toggle
  is off. **`#process` belongs to the WORKSPACE**: App.svelte stamps it
  while `showWorkspace` (replaceState, no history spam), deep-links into
  the app, and `goHome()` clears it synchronously BEFORE the surface swap
  so the landing router can't read the stale hash and bounce back in. A
  Supabase auth callback (`#access_token=…` — the implicit flow; `?code=`
  would only appear under PKCE) is consumed by auth-js inside createClient
  and then CLEARED, which fires a hashchange to "" — App's listener treats
  that one transition as "re-stamp #process", not "the user left" (every
  returning sign-in on a device with receipts used to bounce to the
  landing).
  Anchor landings clear the sticky nav via `scroll-margin-top` on
  `.landing [id]` in `landing.css` (bigger value under 860px for the
  two-row nav) — without it sections start underneath the nav. Everything
  stays mounted and visible (nerd-gated pieces excepted), so the e2e's
  first-render asserts (`#contact form`, hero h1) hold. The roadmap section
  and the in-progress boosters/Drive FAQ entries are Nerd-mode-only
  (`.db-nerd-only` in landing.css / `nerd`-flagged faq entries — same gate
  as the margin notes); the contact form defaults the tuning-bundle
  checkbox ON and its button reads "Send email" with the mail-app explainer
  in a title tooltip. Nerd mode stamps `.nerd-on` on `.landing`; the
  `.db-nerd` notes and their reduced-motion end-state live in `landing.css`
  (global vocabulary, partials contribute plain markup). The WHOLE landing
  is a drop
  target: window-level drag listeners in `Landing.svelte` (guarded on the
  drag carrying Files) raise a pointer-events-none `.drop-veil` and route the
  drop through the same `addFiles` path as the pickers — the e2e pins veil,
  ingest, and clear. The Your-data page was condensed into the FAQ, and the
  old How-page extras were folded into the three steps (the time-race card
  is HowSection's sticky rail; the features trio became step body copy).
- **Landing motion:** shared keyframes live in `landing/landing.css` (global,
  `db-`prefixed) because Svelte can't share scoped keyframes across
  components; section-local keyframes stay scoped (same `db-` names). Every
  landing animation needs an explicit `prefers-reduced-motion` static
  END-state in its component — the global kill-switch in theme.css freezes
  animations at their 0% (hidden) frame.
- **The dark palette is duplicated in theme.css** (`[data-theme="dark"]` block
  + the `prefers-color-scheme` fallback) — edit both identically
  (`tests/theme.test.ts` pins the blocks stay token-identical). The
  theme-color hexes also live in `state.svelte.ts applyTheme` and index.html,
  and index.html carries a pre-paint inline script stamping `data-theme` from
  the same localStorage `"theme"` key `state.svelte.ts` uses — keep the key in
  sync (also test-pinned).
- **Small-copy ink tokens have AA-checked partners** (pinned with computed
  contrast in `tests/theme.test.ts`): `--gold-text` is the small-copy partner
  of `--gold` (chips, flag text, lane heads — `--gold` itself stays fills/
  borders/large text only), and `--cat-3-ink`/`--err-ink` are the ink partners
  for the ReviewModal markers on `--cat-3`/`--err` fills (white in light, dark
  inks in dark). The global `:focus-visible` is an OUTLINE (2px accent,
  2px offset) and forces no border-radius: when it lived in `box-shadow`,
  every later box-shadow rule (`.btn-primary`, `.card`, `.btn:hover`, the
  breathing next-action keyframes) silently cancelled it and keyboard focus
  on a card or primary button was invisible. Controls inside
  `overflow:hidden` containers (Workspace `.seg-btn`, FAQ/How `summary`, the
  landing nav tabs) set `outline: none` and draw INSET box-shadow rings
  locally because the outside ring clips. Light `--ink-faint` is `#6b665f`
  (AA on all three surfaces — the old value was 3.7–4.3:1), form-control
  borders use `--line-control` (≥3:1 on the raised surface in both themes;
  `--line-strong` was 1.5:1 and the inputs' only boundary), and coarse
  pointers get 16px fields so iOS Safari stops zooming on focus. The
  landing's footer column headings are `h3` in `--ink-soft`; the hero's
  scroll cue target (`.why`, no id) carries the same `scroll-margin-top` as
  anchored sections; How steps open on REAL mouse hover only
  (`onpointerenter` with a `pointerType === "mouse"` guard — a
  `(hover: hover)` media check can't tell a touch tap on a touchscreen
  laptop apart; Chromium's compat mouseenter + the tap's click toggle took
  two taps per step, e2e-pinned with a Pixel 7 context).
- **The Drive-folder story is marketing for planned/in-progress work** — it
  lives in the nerd-gated FAQ entries ("What about cloud sync and the AI
  assist?", anchored `#account`, and "Can it watch a Google Drive or
  OneDrive folder?") and the roadmap; keep the future tense until each
  piece ships. OneDrive SAVE is merged and config-gated (`src/onedrive/`,
  hidden without `VITE_ONEDRIVE_CLIENT_ID`); the future tense applies to
  Drive/OneDrive folder WATCHING, and "ships" means enabled on the
  production deployment. With Nerd mode off the page claims only the
  local-first story that exists today — and the #privacy FAQ names the one
  exception honestly: the AI assist, which a build made with
  `OPENROUTER_API_KEY` turns on by default (deliberate zero-click, commit
  e7f9bbd; the hero's "never leave your device" line is the owner's call).
- **`npm run e2e` is the real-OCR accuracy gate** — four image receipts (easy
  coffee, fuel with per-gallon pricing + FUEL TOTAL, split-label TOTAL, a
  skewed scan) plus a 2-page PDF run through actual Tesseract in Chromium with
  per-receipt amount assertions, then the review-modal sweep and workbook
  export are exercised. The testkit exercises the rules on synthetic text
  only; regressions in the real path show up here. CI runs it (own job in
  ci.yml) along with a production build; deploy is gated on CI passing on
  main (`workflow_run`, manual `workflow_dispatch` still allowed) and runs
  `npm test` again before building. The e2e fails on any uncaught page
  error or console error (it used to only log them). The testkit requires
  the AMOUNT right on every challenge and no challenge below 0.9 — the old
  averaged gate let one receipt ship a 100× total.
- **Digit-ENDING brand aliases ("76", "super 8") are excluded from the glyph
  pass** — its punctuation stripping would turn a price ending `.76` or
  "SUPER 8.50" into a brand hit; the exact pass (with the numeric boundary
  guard) is where they match, and a bare numeric brand must own its line or
  precede gas/gasoline/station/fuel ("76 MAIN ST", "ROOM 76" are numbers).
  Digit-BEARING aliases are also excluded from the fuzzy header sweep: its
  digit folds turn "super 8" into "superb", one deletion from the SUPER grade
  line on every independent pump receipt. `tests/vendorDb.test.ts` pins that
  "76" stays the only digit-only alias.
- The logo layer never downloads the CLIP model while the index is empty
  (`logoIndexAvailable()` gate). Tests inject a fake via `setEmbedderFactory`.
- Export modules (ExcelJS/Chart.js) are **lazy-imported** in `ExportBar` — keep
  it that way; they dominated the main chunk otherwise.
- `buildWorkbook` must keep working headless (Node tests): chart rendering
  returns null without a DOM and the workbook builds without images.
- Curated `KNOWN_VENDORS` beats the generated JSON on name conflicts AND on
  alias claims (a JSON alias a curated brand already lists under another name
  is dropped at merge — otherwise the exact pass tied and the alphabetical
  tie-break sent "fedex office" to the JSON's FedEx Office [Materials]);
  `tests/vendorDb.test.ts` pins alias→brand uniqueness and that every JSON
  category is in the taxonomy. Regenerate the JSON with
  `python3 scripts/export_vendor_db.py` (commit the result) — its source
  (`../Reimbursements/vendor_db.py`) is NOT in this checkout, so category
  fixes go in `KNOWN_VENDORS` (mirrored in the script's `NAME_OVERRIDES` and
  hand-applied to the JSON) rather than by regenerating.
- **Taxonomy: Fuel and Materials lead `CATEGORIES`, Other closes** — and the
  workbook renders Other as "Miscellaneous" (`displayCategory`). Hardware/
  building brands map to Materials (the original's `mats`). The meals category
  is named **"Meals"** (renamed from "Meals & Entertainment"); legacy stored
  values are normalized on every `repo` read (`LEGACY_CATEGORIES`). Keyword
  rule order puts Materials right after Fuel and Meals before Travel, the
  Utilities/Software keywords are bill-shaped ("electric bill", "software
  license" — bare "electric"/"cable"/"license" filed supply houses and
  contractor invoices under the phone bill), supply-house keywords carry
  singular and plural forms, and "toll"/"cab"/"fuel" are regexes that skip
  "toll free", "CAB SAUV"/"CAB HINGE" and "FUEL SURCHARGE". A known non-fuel
  brand (Costco/Walmart fuel centers) files as Fuel only when pump math
  verifies; "subway fare" is masked before the brand passes so the transit
  keyword can fire.
- **`total_mismatch` is advisory; `total_suspect` gates.** Only the dedicated
  `total_suspect` warn (and `vendor_unclear`) force `needs_review` — reconcile's
  advisories fire on ordinary tip/savings/balance receipts and must not. Tip
  awareness must stay symmetric between `applyFootingMath` and parseReceipt's
  far-above-subtotal gate (2× subtotal ceiling with a TIP line, 1.5× without).
  That no-tax gate is two-sided: a total BELOW the subtotal with no
  discount/coupon/savings line (`DISCOUNT_RE`) is a dropped leading digit
  and gates too. Also `total_suspect`: a no-tax window recovery that equals
  the subtotal (tax silently dropped), a subtotal + tax sum whose tax exceeds
  `TAX_MAX_RATIO` of the subtotal, and a refund/return total (negative sign
  on its own line, a refund/return label on it, or a "REFUND TO …" echo —
  bare "RETURN POLICY" text never flags).
- **Receipts persist pruned `ocrLines`** (text+bbox, no words) so a review
  correction can be re-located (`locateValue`), re-highlighted (ReviewModal
  `applyPatch` re-bakes the annotated copy), and logged for training.
- **Landing layout invariants:** the hero fills the first screen
  (`min-height: calc(100dvh - 4.8rem)`) so Why-DueBack sits below the fold,
  with a scroll cue that fades once `scrollY > 60`; the hero puts COPY LEFT
  and the animated strip right, with the strip's three papers and arrows
  sharing ONE width (`.hero-visual` is a fixed-width column — mixed widths
  centered against each other read as misalignment, the "right side looks
  funny" report), and there is NO hero sub-paragraph (the Why section
  carries the pitch); the primary CTA sits RIGHT of the secondary; the nav
  has NO "Open the app" (the hero's back-to-receipts button is the
  returning-user path, e2e-pinned); the page flows hero → why → How (the
  three steps with the time-race card as a sticky rail, feature-trio copy
  folded into step bodies) → Logo → Workbook → CTA → FAQ → roadmap →
  Contact; How steps open on mouse hover (`onpointerenter`, click still toggles;
  step 1 starts open so touch users see one expanded); the workbook nav
  link and step 3 say "Excel workbook" while the section label is "The
  deliverable" (one "workbook" per heading stack — the old tab/page-no/
  title/label pile said it four times); the workbook mock uses the REAL
  color scheme (semantic field colors on values, actual sheet-tab colors on
  category dots — `CATEGORY_META` colors were rescued from vendor-blue/
  date-purple/amount-green collisions); ONE `.cta-card` "Got a pile of
  receipts?" (aura-tracked via `use:aura`, hover-only) sits between
  Workbook and FAQ; the footer is the brand/Product/Project block with NO
  legal line, its Roadmap link nerd-gated; **future content is nerd-gated**
  (`nerd`-flagged FAQ entries — boosters/#account and Drive/OneDrive — plus
  the `db-nerd-only` roadmap; with Nerd mode off the site only shows what
  exists); the old Your-data privacy graphic retired when that page
  condensed into the FAQ; turning Nerd mode ON fires
  `landing/binaryBits.ts` (green binary rain, reduced-motion no-op); the
  logo-recognition mock shows the fictional Corner Bistro cup logo, not
  placeholder text. Landmarks: a skip link, the nav is a `<header>`
  (banner), hero → contact sit inside `<main id="main">`, the footer is
  outside; the Why section is `id="why"` so the hero's scroll cue lands
  below the sticky nav (the shared `.landing [id]` scroll-margin — never a
  copy of it in `.why`) and the cue honours reduced motion; `body` is
  `font-size: 100%` (rem components and inherited copy scale together
  with the browser preference); every control gets the 16px coarse-pointer
  floor, INCLUDING the contact form's fields and the board's sort select,
  whose own `font` shorthands outrank theme.css's rule; the workbook mock
  carries the REAL Summary columns (no Notes)
  and its chips/rail note name only what the sheet has; the logo section's
  sync sentence is a nerd-gated aside (present-tense sync claims stay
  behind Nerd mode until the cloud layer ships); `tests/theme.test.ts`
  pins that the landing doesn't advertise the retired CSV / hidden images
  ZIP while the report bar hides them.
- **Board views:** Workspace has a Grid/Kanban toggle + sort select
  (localStorage `board.view`/`board.sort`); kanban lanes are status groups.
  Default sort is **category, then date**. A needs-review card shows its
  first flag as a prominent warn banner (`.why` in Card.svelte). The report
  bar breathes a ring around ONE next-action button (Review flagged, else
  Generate workbook); the pulse keyframes rest at 0% so reduced-motion
  freezes to a plain button. Generating with a blank employee/job name/job
  number raises a confirm dialog first ("Generate anyway" proceeds —
  e2e-pinned). A failed receipt can be read again: "Retry reading" in the
  ReviewModal (the card is itself a button, so no nested button there) and
  "↻ Retry all" in the Failed lane head → `state.retryReceipt` re-queues
  through the same path as intake (never an approved receipt; edited
  fields stay the human's via `touchedBeforeClaim`), and `friendlyError`
  maps a text-reader load failure (worker/wasm/traineddata fetch) to copy
  that points at it. The workspace sync chip shows error/syncing/synced
  (it used to say "synced" whatever the engine's state); the error chip
  opens Settings, which prints `sync.lastError`. A queued/processing
  receipt with NO job in this browser's work-list (`state.localJobIds`,
  from the jobs store on every refresh) arrived through sync and reads
  "Reading elsewhere…" / "Being read on another device…" — it used to say
  "Reading on your device…" while nothing here was reading it.
- **Dark scan borders** (CamScanner sawtooth strips) are trimmed by
  `darkBorderInsets` (binarize.ts, Node-tested) before the edge-energy crop —
  pre-scanned uploads otherwise look "uncropped" (nothing else to trim).
  The insets clamp ONLY the edge-energy fallback: the paper-slab crop is
  used unclamped, because the slab mask already excludes near-black strips
  and its bbox only reaches into the inset band when that band holds
  paper — a long receipt on a dark car seat with its end inside the outer
  8% lost its TOTAL line (or vendor header) to the clamp. `rotateFrame`
  caps the deskew canvas at 2×`ocrMaxEdge` (a 48 MP photo rotated at full
  size was a ~200 MB canvas beside the bitmap on iOS); `cleanImage`
  releases the decoded bitmap in a `finally` on every path and returns no
  object URL (`CleanedImage.url` is gone).
- **Intake is one transaction and one queue.** `repo.addReceipt` writes the
  original blob, the row and its job together (a quota error mid-way left
  an orphaned blob or a "Queued" card with no job); `deleteReceipt` removes
  row + blobs + jobs together, then records the sync tombstone.
  `state.addFiles` snapshots the FileList synchronously (a drop's
  `dataTransfer.files` empties after the event) and serializes intakes
  behind one promise chain, counting the batch from the STORE, not the
  lagging board — two overlapping drops used to overshoot the cap.
  `pipeline/hash.ts` falls back to a pure SHA-256 (same hex) when
  `crypto.subtle` is missing — a phone on the dev server over plain
  `http://192.168…` failed every receipt at the digest.
- **Corrections never silently swap a plausible total.** Pump/footing math only
  auto-corrects decimal-slip-scale garbles (ratio ≈ ×10/×100) or values the
  receipt's own arithmetic contradicts; anything moderate keeps the printed
  total and emits a warn-severity `total_mismatch`, which — like
  `vendor_unclear` — forces `needs_review` via `extract.forcesManualReview()`.
  Tips (TIP_RE) widen footing's expectations; per-gallon price lines are
  excluded from reconcile's `allMax`. The fuzzy header sweep obeys the same
  principle: a hit below `FUZZY_HINT_RATIO` is dropped entirely (never a
  category hint), and when the brand needed real edits a generic keyword on
  the receipt beats the brand's category ("PUBLIC PARKING" is not Publix).
- **Sheet geometry has exactly two conversions, both in `export/anchor.ts`:**
  a stored column width → px is ECMA-376 §18.3.1.13
  (`trunc(((256·w + trunc(128/7))/256)·7)`, so 55 → **385** px and the default
  9.140625 → 64) — the `w·7+5` form converts Excel's *UI character count*, and
  ExcelJS writes `column.width` verbatim into `<col width>`, so using it
  overstated every column by 5 px. Row points → px **snaps to whole pixels**
  (Excel's dialog: "14.25 (19 pixels)"); `IMG_ROW_PT` is 14.25 for exactly
  that reason — an unaligned row height drifts ~1.75% over a 40-row receipt.
- **`imageRows()` is the one definition of a receipt's carrier rows.** The
  Summary's `#` hyperlink anchors, its amount references (`'Sheet'!F…`) and
  the image sheet each need the same row count; it used to live as three
  copies of `ceil(h*0.75/IMG_ROW_PT)`. Node tests can't catch a desync through
  `buildWorkbook` (no canvas → no images → always the 1-row branch), so
  `tests/workbook.test.ts` asserts the block contract on the helpers directly.
- **Image anchors are native EMU (`export/anchor.ts`), never a fractional
  `{col}`.** ExcelJS converts a fractional column with `colWidth = width ×
  10000` EMU (lib/doc/anchor.js) while a rendered column is its real px ×
  9525 — for column A at width 55 that is 550,000 vs 3,667,125 EMU, so an
  image sized as a fraction of the column rendered **6.75× too narrow** (the
  "skinny receipts" report; heights were fine because that fraction is a row
  *count*). `imageAnchor()` walks the sheet's real column widths/row heights
  and hands ExcelJS `nativeCol/nativeColOff/...`, which `CellPositionXform`
  writes through verbatim. Carrier rows must be sized BEFORE the anchor is
  computed — an unsized row measures as Excel's 15pt default.
- **Workbook images use twoCellAnchor (tl + br), never tl + ext** — iOS Quick
  Look and Apple Numbers skip oneCellAnchor images entirely (the "images don't
  render on iPhone" report). br is derived from the same px math as the
  carrier rows (col px ≈ width·7+5). Quick Look also never activates internal
  hyperlinks — that part is preview-inherent, not fixable in the file.
- **Every embedded receipt displays at `IMG_DISPLAY_W` (380px), filling
  column A** — scaled UP as well as down, so receipts read without zooming
  (a narrow portrait receipt used to render as a strip). Its `thumbnail()`
  call uses the `"width"` fit: the default long-EDGE cap gave a portrait
  receipt ~half the horizontal pixels the column displays (blurry); the
  images-ZIP path keeps the edge fit. Display height derives from the
  encode's aspect, and `imageRows` sizes the carrier band from that height —
  a very long receipt just gets more rows.
- **Contact form (Landing #contact)** opens a prefilled mailto: draft to
  contact@duanehamilton.net; mailto can't attach files, so the "attach tuning
  bundle" checkbox downloads the ZIP and the draft asks the sender to attach it.
- **Workbook columns autofit** (`autofitColumns` in workbook.ts — ExcelJS has
  none): merged band cells are skipped. Insights keeps FIXED widths — the
  two-up chart grid anchors images at column offsets 0/6, so autofitting there
  would overlap the charts; the trailing column is widened (15, not 13) so
  columns 6–11 actually contain a 558px chart. Chart text renders ~26px (titles 34px) because the
  900px canvases embed at 0.62 scale (≈ 16px / 21px on-sheet).
- **Receipts are renamed post-extraction** to `{cat}_{MM-DD-YY}_{vendor}.jpg`
  (`util/rename.ts`, the original app's convention) — the extension is ALWAYS
  `.jpg` because every stored/exported receipt image (cleaned, annotated,
  tuning bundle) is a JPEG re-encode, whatever was uploaded; the upload's
  name and extension survive in `originalFileName` — the e2e keys receipts
  by it, not `fileName`. `sanitizeFilePart` folds accents to ASCII
  (`foldToAscii`: Café → cafe, a deliberate divergence from the Python port,
  which dropped the letter) but file names stay ASCII on purpose — the print
  packet renders non-ASCII as "?" in WinAnsi Helvetica — so a non-Latin
  vendor sanitizes to "" and the receipt takes the vendor-less form. The
  workbook and print-packet file names fold the employee the same way.
- **Allowances (per diem, phone service) are report-side only**:
  `Batch.perDiem` + `Batch.phoneService` (ride the sync `payload` jsonb — no
  Supabase migration needed) → labeled Summary lines between the category
  sections and the TOTAL, which foots them. Insights KPIs stay receipt
  analytics on purpose (allowances would skew Avg/Receipt and Largest), and
  the CSV stays raw receipt rows. An allowances-only workbook (0 receipts) is
  legal. Phone service is a per-batch monthly rate (`PhoneService.rate`,
  **default** `PHONE_SERVICE_MONTHLY_USD` = 63) × user-picked "YYYY-MM" months
  (`util/phone.ts` validates; ExportBar's picker is a $-per-month field plus a
  ‹ year › pager with 12 chips — any month of any year, deliberately
  uncapped). `phoneServiceRate()` is the one place the default lives: a batch
  saved before the rate was adjustable (or one carrying junk from a synced
  payload) still reimburses at 63, while an explicit 0 stays 0.
- **ZIPs are expanded at intake too** (`addFiles` → `pipeline/unzip.ts`, lazily
  imported — `looksLikeZip` lives in `util/files.ts` so asking the question
  doesn't pull the reader into the main chunk). Entries run back through the
  same per-file path, so an archived PDF still expands per page and a nested
  archive still opens (depth-capped at `LIMITS.maxArchiveDepth`). The card
  shows the path inside the archive (`trip.zip › 2026/03/session.pdf`) —
  twelve month folders each holding "receipt.pdf" are otherwise
  indistinguishable. `__MACOSX/._name.jpg` AppleDouble stubs are the trap:
  they carry the *same extension* as the real receipt, so an extension-only
  filter queues an unreadable duplicate for every image. A ZIP is measured
  against `LIMITS.maxArchiveBytes` (300 MB), each entry against
  `maxFileBytes`, and the archive's total INFLATED output against
  `LIMITS.maxArchiveInflatedBytes` (400 MB) — the directory's declared sizes
  are forgeable, so only the streamed byte count is trusted.
- **EV charging files under Fuel, and its kWh line is not a total.** Tesla (+
  Electrify America/ChargePoint/EVgo/Blink) are `Fuel` brands, and "kwh"/
  "charging session" are Fuel keywords for logo-only charging receipts. The
  session's energy figure is *larger* than the dollar total (42.31 kWh →
  $15.23) and parses as strict money, so `findAmount` drops the kWh QUANTITY
  from `allMax` (`ENERGY_QTY_SRC` in extract.ts) — otherwise reconcile's
  "larger amount above the total" warn forced every charging receipt into
  review. Only the quantity is dropped, never the line: "38.42 kWh $12.60"
  must still donate its charge when there is no TOTAL label.
- **PDFs are expanded at intake** (`addFiles` → `pipeline/pdf.ts`): one
  receipt per page — the pipeline's `decode()` first-page path only remains
  for PDF blobs stored by older versions. A scanner PDF used to become a
  single receipt of page 1, silently dropping the rest.
- **Generate downloads the workbook + print packet PDF** (kv
  `report.printPacket`, default ON); kv `report.bundleZip` zips them into
  ONE download instead. The images-ZIP option is HIDDEN for now (card
  commented out in ExportBar, `includeZip` forced false; wiring + kv
  `report.imagesZip` remain). The CSV button is gone entirely
  (`export/csv.ts` survives only for the tuning bundle). "Preview packet"
  opens the PDF in a new tab — the window MUST open synchronously in the
  click (popup blockers), then navigate to the blob URL. The options row is
  TWO labeled fieldsets: allowances that add to the total (per diem, phone)
  vs what the download contains (insights, print packet, bundle). The packet (`export/printPdf.ts`, Node-tested) crops each
  receipt to its vendor→total strip when all three boxes are known
  (`receiptStrip`; hand-drawn boxes count) and column-flow-packs the strips
  (`layoutPrintPages`) so several fit a Letter page; each image carries its
  own `label`/file-name/amount/job caption (the job is the batch's today,
  stamped per image so a per-receipt job needs no layout change) and the
  employee header tops every page (`PrintMeta` is employee-only). The packet is ordered and numbered like
  the workbook (category sections in `CATEGORIES` order, receipts by date,
  "Fuel #2  file.jpg" captions) so paper and Summary read together — the
  same `export/order.ts` the workbook uses, per receipt inside try/catch
  with a "skipped N receipts without a readable image" toast (a missing
  or undecodable blob used to vanish silently, or sink the whole packet).
  `util/rename.ts employeeFilePart` is the ONE employee file-name rule
  (workbook, packet, archives — four regex copies had drifted).
- **ReviewModal has draw-a-box mode**: "▣ mark on image" per field
  (color-coded to the field) arms a drag on the receipt that writes the
  field's bbox with `Field.manualBox`, which `applyPatch`'s relocation must
  never move (and `patchFromForm` must carry through saves). The drawn rect
  MUST be `$state.snapshot`-ed before entering the patch — a $state proxy
  makes IndexedDB's structuredClone throw and the box silently never
  persists. Saves are SERIALIZED (`applyPatch` chains through one promise
  and diffs against the receipt as stored): a field's change event and the
  Approve click behind it fire back to back and used to log the correction
  twice and orphan an annotated blob. `patchFromForm` stamps `edited` only
  on fields whose value changed (or were already edited) — stamping every
  field dropped provenance boxes on untouched values and made every save
  read as a human touch. The form re-seeds when the SAME receipt's
  `updatedAt` moves while the form is untouched (it finished processing or
  synced while its card was open); typed edits always win. The box also autofills its field via `extract.readValueInBox`
  (stored `ocrLines` inside the box; Node-tested). The completed review
  sweep fires `ui/confetti.ts` (multi-volley canvas burst, reduced-motion
  no-op). Grid view groups by category with show/hide chips (localStorage
  `board.hiddenCats`); the chip row renders whenever a PRESENT category is
  hidden, not only when there are several — the hidden set persists across
  batches, and a single-category batch used to render a blank grid with
  nothing to click. Workspace reads/writes its `board.*` preferences through
  guarded helpers (localStorage throws in the Carrd embed). Settings re-reads
  the AI-assist config on every open (sign-in flips it on, assisted receipts
  bump `spent`) and its "Test connection" takes the same server-proxy path a
  real receipt takes. Card `aria-label`s carry the review reason, date and
  logo state; the header progress count is a `role="status"` live region.
- **The Insights sheet defaults ON in the UI, OFF at the API.** The report-bar
  toggle defaults to checked (kv `report.insights`; only an explicit false
  turns it off) and the e2e pins that. `buildWorkbook`'s own
  `WorkbookOptions.insights` still defaults false so headless/Node callers
  must opt in (`{ insights: true }`). Chart rendering is skipped entirely
  when off, but `computeInsights` still runs — the Summary's Expense Period
  comes from it.
- **Saved jobs autofill both ways** (report bar): an exact, case-insensitive
  match on a saved name fills the number and vice versa (`store/jobs.ts`);
  pairs are saved explicitly (☆ Save job) and managed in Settings. Local kv
  only — they don't sync.
- **OneDrive is popup-order-sensitive**: `connectOneDrive` opens the (blank)
  popup synchronously inside the click, then navigates it — connect BEFORE
  building the workbook (ExportBar does), or popup blockers eat it. The OAuth
  `state` is prefixed `dueback-od-` so `main.ts` can tell the popup callback
  apart from Supabase's own auth callbacks (`#access_token=…` under the
  implicit flow the client uses; the relay in
  `onedrive/popup.ts` must keep running before `mount`). Azure registration
  must use the **Single-page application** platform or the browser token
  exchange 403s; SPA refresh tokens die after 24 h, so re-prompting is normal.
- **Extraction never overwrites a human** (`pipeline.ts completionWriteMode`
  + `touchedBeforeClaim`, Node-tested): the completion write re-reads the
  receipt — deleted mid-flight skips the write and deletes this run's blobs;
  approved/`done`/any write newer than the claim's `updatedAt` lands only
  technical plumbing (cleaned/annotated keys, hash, OCR lines — plus
  un-stranding a still-"processing" status to `needs_review`, or to `done`
  when the receipt is approved). A human touch from BEFORE the claim counts
  the same way: the modal opens Queued cards, so the pre-claim read is
  checked for approved / `done` / any `edited` field (`touchedBeforeClaim`)
  — those writes are older than the claim's baseline and were invisible to
  it — and the claim does not re-stamp a `done` receipt to `processing`
  (it used to, and the un-strand branch then parked an approved receipt in
  Needs-review). The completion write is a compare-and-swap on the re-read
  row's `updatedAt` (`repo.updateReceipt(…, { updatedAt })` returns null
  on a miss): a review save that lands between the re-read and the put is
  re-read again and, at most, technical plumbing lands (third miss: the
  plumbing lands unconditionally rather than strand a "processing" row).
  The failure path obeys the same rule: `fail()` is skipped for a receipt
  approved mid-flight and CAS-guarded the same way. The paid vision assist
  is gated the same way BEFORE the call (`completionWriteMode(pre) ===
  "full"`): a receipt deleted or human-touched mid-flight would discard —
  and still bill — the assist's answer.
- **Deletes must go through `repo.deleteReceipt`/`deleteBrand`** — they record
  the kv pending-delete (with blob keys) that the sync engine tombstones
  remotely (`deleted_at` + storage cleanup); the sync engine itself removes
  local rows via raw conn so a pulled tombstone never echoes back with a newer
  timestamp. Supabase PKs are `(user_id, id)` — upserts use
  `onConflict: "user_id,id"`; live upserts set `deleted_at: null` so a
  genuinely newer edit revives a tombstone (LWW both ways).
- **A second device adopts a synced batch** — after sign-in,
  `state.maybeAdoptSyncedBatch` repoints the device-local `activeBatchId` at
  the most recently updated non-empty pulled batch, never one that already
  has receipts (`syncMerge.chooseAdoptionBatch`, Node-tested).
- **The job lock heartbeats** — `queue.ts` touches `lockedAt` every 20 s while
  a job runs and `claimNextJob`'s stale threshold (`repo.STALE_LOCK_MS`) is
  90 s — four missed beats; processing routinely exceeds a minute
  (serialized Tesseract, binarize rescue, first-use model downloads), so
  without the heartbeat completing siblings re-claimed in-flight jobs and
  double-processed (and double-billed the paid vision assist). The pool
  re-wakes itself every 30 s while jobs remain but none is claimable, so a
  reload mid-batch no longer strands the in-flight receipts at "Reading…".
  Tesseract start-up failures are surfaced through `createWorker`'s
  `errorHandler` — its own promise never settles when the language data
  or the initialize step fails (only the 'load' action rejects), which
  parked every receipt in "Reading…" with the heartbeat keeping the lock
  alive; a 5-minute backstop deadline remains (the first-use download is
  ~18 MB, so a short one spuriously failed slow links). A failed start is
  forgotten after a 30 s cooldown (each attempt leaks an idle Worker and
  the queue retries at once), so the next receipt retries instead of
  inheriting one permanently rejected promise. `queue.fill()` is a single
  runner with a re-wake flag: overlapping fills (a drop mid-drain, a
  finishing job's own re-claim) each checked the cap before their own
  claim and ran concurrency + 1 receipts. The pipeline's failure
  path deletes the cleaned/annotated blobs this run stored that the receipt
  doesn't reference (there is no blob GC). The board coalesces repo
  notifications into one read per 40 ms (`state.scheduleRefresh`) — every
  pipeline write and every one of a clear-all's deletes re-read the whole
  batch. `pullAll` announces the merged ROWS before downloading blobs (a
  fresh device stared at an empty board for minutes) and again after.
  `releaseJob` only re-puts a job that still exists. Jobs are claimed in
  `createdAt` order (upload order) — ids are random UUIDs, so key order, the
  old claim order, processed a 40-photo drop in no relation to how it was
  added. A failed receipt's card shows `friendlyError()`'s message (HEIC in
  a non-Safari browser, corrupt/password PDF, undecodable image) rather
  than the decoder's internals.
- **Every vision provider fetch carries a 90 s `AbortSignal`**
  (`visionSignal()` in `providers/shared.ts`) — a stalled model call parked
  the receipt in "processing" for good because the heartbeat kept its lock
  alive. `parseVisionJson` strips `<think>` blocks and walks balanced
  objects, so prose or a stray brace before the JSON no longer sinks it.
- **Semantic dedup needs BOTH a vendor and a date besides the amount**
  (`dedup.semanticKey`) — two unreadable receipts sharing an amount flagged
  each other, and a vendor-only key matched every same-price fill-up on a
  trip. `unzip.archiveEntryName` drops `.`/`..`/drive prefixes from
  the inner path because it is echoed into the tuning bundle's ZIP entry
  names (zip-slip for whoever extracts it), and `readZip` normalizes
  backslash separators (some Windows archivers) to "/" at the one decode
  site so the junk filter, extension check and card path see one shape.
- **The DATE color is purple (`--cat-4`), not red**, everywhere a date is
  marked: ReviewModal markers/field tint, `annotate.ts HIGHLIGHT_COLORS`,
  the workbook's `FIELD_TINTS`, and the landing's `.hl-date`/`.rv-date`
  mocks — red sat too close to the orange review accents, and errors keep
  red. Color is SEMANTIC everywhere: vendor blue / date purple / amount
  green; the workbook's per-receipt file-name band is NEUTRAL
  (`RECEIPT_BAND_FILL`), not a category pastel. `--cat-4-ink` is its AA-pinned ink partner
  (tests/theme.test.ts). ReviewModal renders each flag NEXT TO the field it
  questions (`FLAG_FIELD` map); only unmapped codes (duplicate,
  low_confidence) stay in the general list.
- **A new build never swaps under an open tab** — `vite.config.ts` registers
  the service worker with `registerType: "prompt"` (autoUpdate forced
  skipWaiting/clientsClaim, purged the old precache and 404'd the next lazy
  import); `main.ts registerSW` sets `app.updateReady` and App.svelte shows
  a persistent reload bar (disabled while `pendingJobs > 0` — a reload
  mid-job parks it until the lock goes stale). The `vite:preloadError`
  reload stays as the SW-less backstop. `aria-busy` on `#app` comes off in
  App.svelte when boot finishes, not in main.ts before mount.
- **Theme has one reactive truth** — `app.isDark` (theme, or the live OS
  scheme via a matchMedia listener under "auto"); the header toggle flips
  light/dark with `aria-pressed`, and Settings → Appearance is where "Match
  system" lives. The report bar re-seeds from a batch whose `updatedAt` is
  newer than the version it seeded from (a synced edit from another device)
  unless focus is inside the bar, and its own saves stamp `seededAt`;
  `saveMeta` skips a no-op write. A review save prunes the flags that
  questioned the fields the human just changed (`flagsAfterEdit`, removal
  only — status/approval untouched). The modal's Approve is disabled (and
  Enter/"a" ignored) while the receipt is still queued/processing, key
  auto-repeat is ignored, and Escape from an edited field blurs it first so
  the change event saves before close() clears the receipt. The tuning
  bundle caps originals at `BUNDLE_ORIGINALS_BUDGET` (200 MB; the
  annotated copy always ships, `extraction.json` marks
  `originalOmitted`), flattens archive paths into one honest entry name
  (`originalEntryName`, Node-tested) and stores images with
  `compress: false` (`ZipEntry.compress` — JPEG/PDF never shrink).
- **Forced colors and safe areas are handled centrally.** The focus ring is
  an outline (forced colors paints it; a later box-shadow can't cancel it);
  input focus and the four inset rings keep a TRANSPARENT outline, never
  `outline: none`; every pressed toggle carries `aria-pressed`, and one
  global `@media (forced-colors: active) [aria-pressed="true"]` rule
  underlines it (background-only fills vanish there). `.wrap` pads the
  notch insets, the camera FAB and the board's coarse-pointer bottom
  padding clear the home indicator (`env(safe-area-inset-*)`, the
  Toasts idiom). Heading structure: the workspace has an sr-only h1 and
  lane/category h2s (font re-pinned to the eyebrow look), Settings is h2 +
  h3 sections, the report bar's confirm is an h2 — theme.css styles bare
  h2/h3 in Lora with margins, so every UI heading re-pins its font. The
  review modal's draw buttons expose `aria-pressed` and an always-mounted
  sr-only `role="status"` announces draw mode; the zoom canvases are
  `aria-hidden`. tests/theme.test.ts pins the dark blocks' token sets
  BOTH ways, `--ink-faint` AA on all three paper tones, `--line-control`
  ≥ 3:1 and the forced-colors rule.
- **All three dialogs manage focus** (ReviewModal, Settings, ExportBar's
  blank-details confirm): container
  `tabindex="-1"` focused on open, a local Tab trap, Escape closes, focus
  restored on close;
  ReviewModal's window-level Enter shortcut ignores BUTTON/A/SUMMARY/SELECT
  targets so Enter activates the focused control instead of approving.
- **`vendor-tesseract.mjs` FAILS the build** (exit 1) when language data can't
  be vendored, unless `VITE_TESSDATA_LOCAL=0` — there is no runtime CDN
  fallback (`langPath` is picked once at build time), so the old
  warn-and-continue shipped 404ing OCR. The worker + cores are vendored
  under `vendor/tesseract/<tesseract.js version>/` (`tesseractVendorDir`),
  and `ocr.ts` builds the same path from the `__TESSERACT_VERSION__` define
  in vite.config.ts — the service worker caches `/vendor/` CacheFirst for a
  year, so an unversioned path kept serving the previous worker to a bundle
  built against the next release (test-pinned in
  `tests/vendor_tesseract.test.ts`; stale version folders are pruned). `ai-extract`'s
  The proxy also validates the MESSAGES (`policy.messagesProblem`, Node-
  tested): 1–2 system/user entries, bounded text, at most one image and
  only an inline `data:image/` URL — the server key must never fetch a
  remote URL or relay an arbitrary prompt; temperature/usage/response_format
  are bounded, not passed through; the declared content-length is checked
  before the body is buffered. The client omits its OpenRouter attribution
  headers through the proxy (`openRouterHeaders`) and a test pins that
  every proxied header is on `CORS_ALLOWED_REQUEST_HEADERS`.
  Every provider call goes through `visionFetch` (90 s deadline, a
  TimeoutError reads "<provider> timed out after 90 s"), and `ai-extract`
  caps its upstream call at 85 s so the browser gets a clean JSON 504
  before its own deadline instead of a network error.
  Anthropic pricing (`priceFor`, Node-tested) resolves dated snapshot ids
  by longest prefix and charges an UNKNOWN id at the top rate, so the
  spend cap engages instead of reading $0.00; the Gemini key rides the
  `x-goog-api-key` header, never the URL. ZIP intake inflates only as
  many entries as the batch has room for (`maxEntries` = remaining
  capacity). CI has `permissions: contents: read`, per-PR cancellation and
  job timeouts; Pages deploys are never cancelled mid-publish. The
  precache skips non-Latin font subsets and the lazy transformers chunk
  (runtime-cached together with the ONNX wasm under "logo-model");
  `LEGACY_CATEGORIES`/`normalizeCategory` live in config/categories.ts
  (Node-tested) and repo reads use them.
  `policy.ts DEFAULT_ALLOWED_MODEL` must stay in sync with
  `PROVIDERS.openrouter.defaultModel` (vision/config.ts): a signed-in user who
  picks a non-default model gets 403 from the proxy unless the deployer widens
  `AI_ALLOWED_MODELS`; the function fails closed (503) until migration 0003 is
  applied.
- `.env.example` lists every knob; all optional. Deploy secrets/vars are wired
  in `.github/workflows/deploy.yml`.
