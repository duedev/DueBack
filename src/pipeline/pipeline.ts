import { repo } from "../store/repo.ts";
import { cleanImage, binarizeBlob } from "./imagePrep.ts";
import { hashBlob } from "./hash.ts";
import {
  parseReceipt,
  forcesManualReview,
  matchKnownVendor,
  type Extraction,
} from "./extract.ts";
import { findSemanticDuplicate, type DupRecord } from "./dedup.ts";
import { getOcrEngine, type OcrEngine } from "./ocr.ts";
import { runVisionAssist, shouldAssist, type VisionAssist } from "./vision/index.ts";
import { receiptFileName } from "../util/rename.ts";
import { annotateReceipt, HIGHLIGHT_COLORS } from "./annotate.ts";
import { logoIndexAvailable, cropHeaderBand, searchLogo, type LogoHit } from "./logo/index.ts";
import { fuseVendorIdentity } from "./logo/fuse.ts";
import { CONFIDENCE, OCR_RESCUE } from "../config/constants.ts";
import type { Receipt, Flag, OcrResult, ExtractionMethod, LogoMatch } from "../types.ts";

// The worker's job, end to end (§8 "Process"): clean → hash (cache/dedup) →
// OCR (skipped on a cache hit) → rules → visual logo identity → dedup → decide
// status. Free path first, everything deterministic. Each receipt records
// method_used + cost so the "this cost you $0.00" line is honest.

/** Had a human already touched this receipt BEFORE this run claimed it? The
 *  modal opens a "Queued" card too, so a receipt can be approved (done) or
 *  saved (fields `edited`, status still queued) before its job is claimed —
 *  and the claim's `updatedAt` baseline can't see either. Pure; Node-tested. */
export function touchedBeforeClaim(
  r: Pick<Receipt, "approved" | "status" | "vendor" | "date" | "amount" | "category">,
): boolean {
  return (
    r.approved ||
    r.status === "done" ||
    [r.vendor, r.date, r.amount, r.category].some((f) => f?.edited === true)
  );
}

/** What the completion write may carry, given the receipt's state NOW vs the
 *  `updatedAt` stamped when this run claimed it (status → "processing"). The
 *  modal opens receipts in any status, so a human can edit, approve or delete
 *  one mid-flight — and the machine must never overwrite the human. A touch
 *  from BEFORE the claim (`preTouched`, see `touchedBeforeClaim`) counts the
 *  same way. Pure; Node-tested. */
export function completionWriteMode(
  latest: Pick<Receipt, "approved" | "status" | "updatedAt"> | undefined,
  claimedAt: number,
  preTouched = false,
): "skip" | "technical" | "full" {
  if (!latest) return "skip"; // deleted mid-flight
  if (preTouched || latest.approved || latest.status === "done" || latest.updatedAt > claimedAt) {
    return "technical"; // human touched it — image/relocation plumbing only
  }
  return "full";
}

export async function processReceipt(
  receiptId: string,
  engine: OcrEngine = getOcrEngine(),
): Promise<void> {
  const receipt = await repo.getReceipt(receiptId);
  if (!receipt) return;

  // The claim's updatedAt is the baseline: any later write is a human's (or a
  // sync mirror's) and outranks this run's extraction. A receipt a human
  // already finished ("done" — approved from its Queued card) keeps that
  // status: re-stamping it "processing" would later un-strand it into
  // needs_review with an approved chip, and the sweep would skip it.
  const claimed = await repo.updateReceipt(receiptId, {
    ...(receipt.status !== "done" ? { status: "processing" as const } : {}),
    error: undefined,
  });
  if (!claimed) return; // deleted between the fetch and the claim

  const original = await repo.getBlob(receipt.fileKey);
  if (!original) {
    await fail(receiptId, "Original image is missing.");
    return;
  }

  // Blobs this run stores; a throw before the completion write used to
  // orphan them forever (there is no blob GC), so the failure path deletes
  // whichever the receipt doesn't reference.
  let cleanedKey: string | undefined;
  let annotatedKey: string | undefined;
  try {
    // 1. Clean (auto-rotate, grayscale, auto-crop, downscale).
    const cleaned = await cleanImage(original);
    cleanedKey = await repo.putBlob(cleaned.blob, "cleaned");

    // 2. Hash the cleaned bytes → cache key + dedup key.
    const imageHash = await hashBlob(cleaned.blob);

    // 3. Cache by image hash: reuse OCR text from an identical image (free).
    const sameHash = (await repo.findByHash(imageHash)).filter(
      (r) => r.id !== receiptId,
    );
    const cached = sameHash.find((r) => r.ocrText && r.ocrText.length > 0);

    let ocr: OcrResult;
    if (cached?.ocrText) {
      ocr = {
        text: cached.ocrText,
        confidence: cached.confidence * 100,
        // Reuse the cached geometry too — without it, a re-uploaded duplicate
        // can never locate corrections or heal its highlights.
        lines: cached.ocrLines ?? [],
        words: [],
      };
    } else {
      // Recognize the transient higher-res render; boxes are normalized to
      // its dimensions, and it shares the stored image's frame exactly.
      ocr = await engine.recognize(
        cleaned.ocrBlob,
        cleaned.ocrWidth,
        cleaned.ocrHeight,
      );
    }

    // 4. Rules extraction (free, deterministic, on-device).
    let ex: Extraction = parseReceipt(ocr);

    // 4a. Weak-read rescue: when the grayscale pass reads poorly (or the
    //     rules can't find an amount), retry on an adaptively binarized copy
    //     and keep whichever read extracts better. Binarization rescues
    //     unevenly lit thermal paper but can hurt clean scans, so it is
    //     strictly retry-only — never the first pass. Best-effort: any
    //     failure keeps the original read.
    if (
      !cached?.ocrText &&
      OCR_RESCUE.binarize &&
      (ocr.confidence < OCR_RESCUE.minConfidence || ex.amount.value <= 0)
    ) {
      try {
        const bin = await binarizeBlob(cleaned.ocrBlob);
        const ocr2 = await engine.recognize(bin.blob, bin.width, bin.height);
        const ex2 = parseReceipt(ocr2);
        // Swap only when the retry is strictly safer: it found an amount the
        // first pass missed, or BOTH passes agree on the amount (then it's a
        // pure text/vendor/date upgrade) and it scores higher. A confidently
        // WRONG binarized amount must never displace a correct weak read.
        const foundMissingAmount = ex2.amount.value > 0 && ex.amount.value <= 0;
        const amountsAgree =
          Math.abs(ex2.amount.value - ex.amount.value) < 0.005;
        if (
          foundMissingAmount ||
          (amountsAgree && ex2.confidence > ex.confidence)
        ) {
          ocr = ocr2;
          ex = ex2;
        }
      } catch {
        /* rescue is pure upside — never fail the receipt over it */
      }
    }
    let methodUsed: ExtractionMethod = "rules";
    let methodDetail: string | undefined;
    let cost = 0;
    let ocrTextOut = ocr.text;
    // Pruned per-line geometry is persisted so a later human correction can
    // be located on the image, re-highlighted, and logged for training.
    const ocrLines = ocr.lines.map((l) => ({
      text: l.text,
      confidence: l.confidence,
      bbox: l.bbox,
      words: [],
    }));

    // 4b. Visual logo identity. A confident OCR-text brand match is recorded as
    //     provenance; otherwise, when there is a logo index to match against and
    //     the vendor is blank/shaky, the header band is embedded and compared
    //     against the brand index. Best-effort — any failure keeps the rules
    //     result untouched. Skipped entirely (no model download) while the
    //     index is empty.
    let logoMatch: LogoMatch | undefined;
    try {
      // Same scoped scan the rules use — a generic alias on an address or
      // tender line must not suppress the logo layer either.
      const textMatch = matchKnownVendor(ocr.lines, ocr.text);
      let logoHit: LogoHit | null = null;
      if (
        !textMatch &&
        (!ex.vendor.value || ex.vendor.confidence < 0.9) &&
        (await logoIndexAvailable())
      ) {
        const region = await cropHeaderBand(cleaned.blob);
        logoHit = await searchLogo(region);
      }
      const fusion = fuseVendorIdentity(ex, textMatch, logoHit);
      if (fusion.vendor) {
        ex.vendor = { ...ex.vendor, ...fusion.vendor, edited: false };
      }
      if (fusion.category) {
        ex.category = { value: fusion.category.value, confidence: fusion.category.confidence };
      }
      if (fusion.flags.length) ex.flags.push(...fusion.flags);
      logoMatch = fusion.logoMatch;
    } catch {
      /* logo layer is pure upside — never fail the receipt over it */
    }

    // 4c. Optional paid accuracy dial (§5/§9): for a low-confidence receipt, and
    //     only when the user has opted in + supplied a key, get a vision-model
    //     second opinion. It returns the same Extraction shape, so everything
    //     below is identical. Any failure silently keeps the free result.
    let assist: VisionAssist | null = null;
    if (shouldAssist(ex)) {
      // Never spend a paid call on a result that could not land: a receipt
      // deleted or human-touched mid-flight completes as skip/technical
      // (below), so the assist's answer would be discarded — and billed.
      const pre = await repo.getReceipt(receiptId);
      if (completionWriteMode(pre, claimed.updatedAt, touchedBeforeClaim(receipt)) === "full") {
        assist = await runVisionAssist(cleaned.blob, ex);
      }
    }
    if (assist) {
      ex = assist.extraction;
      methodUsed = "paid";
      methodDetail = `${assist.provider} · ${assist.model}`;
      cost = assist.costUsd;
      if (assist.rawText) ocrTextOut = assist.rawText;
    }

    // 5. Duplicate detection within the same batch. First an exact image-hash
    //    match (byte-identical re-upload); failing that, a semantic match on
    //    vendor + date + amount (the same receipt photographed twice).
    const flags: Flag[] = [...ex.flags];
    let duplicateOf: string | null = null;
    const dupInBatch = sameHash.find((r) => r.batchId === receipt.batchId);
    if (dupInBatch) {
      duplicateOf = dupInBatch.fileName;
      flags.unshift({
        code: "duplicate",
        severity: "warn",
        message: `Looks identical to "${dupInBatch.fileName}".`,
      });
    } else {
      const siblings = await repo.listReceipts(receipt.batchId);
      const others: DupRecord[] = siblings
        .filter((r) => r.id !== receiptId)
        .map((r) => ({
          id: r.id,
          label: r.fileName,
          vendor: r.vendor.value,
          date: r.date.value,
          amount: r.amount.value,
        }));
      const semDup = findSemanticDuplicate(
        {
          id: receiptId,
          label: receipt.fileName,
          vendor: ex.vendor.value,
          date: ex.date.value,
          amount: ex.amount.value,
        },
        others,
      );
      if (semDup) {
        duplicateOf = semDup.label;
        flags.unshift({
          code: "duplicate",
          severity: "warn",
          message: `Same vendor, date and amount as "${semDup.label}" — possible duplicate.`,
        });
      }
    }

    const needsReview =
      forcesManualReview(flags) ||
      Boolean(duplicateOf) ||
      ex.confidence < CONFIDENCE.reviewBelow ||
      ex.amount.value <= 0;

    // Bake highlighter marks (vendor/date/amount) onto an annotated copy for
    // exports and thumbnails — the review modal keeps the clean image with
    // live overlays. Best-effort: any failure just skips the highlights.
    try {
      const annotated = await annotateReceipt(cleaned.blob, [
        ...(ex.vendor.bbox ? [{ bbox: ex.vendor.bbox, color: HIGHLIGHT_COLORS.vendor }] : []),
        ...(ex.date.bbox ? [{ bbox: ex.date.bbox, color: HIGHLIGHT_COLORS.date }] : []),
        ...(ex.amount.bbox ? [{ bbox: ex.amount.bbox, color: HIGHLIGHT_COLORS.amount }] : []),
      ]);
      if (annotated) annotatedKey = await repo.putBlob(annotated, "annotated");
    } catch {
      /* highlights are pure upside */
    }

    // Rename to the original app's {category}_{MM-DD-YY}_{vendor} convention
    // once fields are known (review edits recompute it).
    const renamed =
      ex.amount.value > 0
        ? receiptFileName({
            category: ex.category.value,
            date: ex.date.value,
            vendor: ex.vendor.value,
          })
        : receipt.fileName;

    // Re-read before the final write: a human may have edited, approved or
    // deleted this receipt while OCR ran — or before the claim, while it sat
    // queued — and extraction must not clobber that. The write itself is a
    // compare-and-swap on `updatedAt` (repo.updateReceipt's `expect`): a
    // review save that lands between this re-read and the put loses the
    // race for the machine, never for the human — re-read, and land at most
    // technical plumbing.
    let latest = await repo.getReceipt(receiptId);
    let mode = completionWriteMode(latest, claimed.updatedAt, touchedBeforeClaim(receipt));
    for (let attempt = 0; ; attempt++) {
      if (mode === "skip") {
        // Deleted mid-flight — drop this run's stored blobs (orphans otherwise).
        await repo.deleteBlob(cleanedKey).catch(() => {});
        if (annotatedKey) await repo.deleteBlob(annotatedKey).catch(() => {});
        return;
      }
      const row = latest!;
      // Image/relocation plumbing — safe to land even over a human edit (it
      // carries no vendor/date/amount/category/flags/fileName semantics).
      const technical: Partial<Receipt> = {
        cleanedKey,
        ...(annotatedKey ? { annotatedKey } : {}),
        imageHash,
        imageWidth: cleaned.width,
        imageHeight: cleaned.height,
        ocrText: ocrTextOut,
        ocrLines,
        // A mid-flight save doesn't set status, which would strand the receipt
        // in "processing" — hand it to review. An approval's "done" stays, and
        // an approved receipt is never sent back to review: it un-strands to
        // "done" (approval and "done" travel together in the modal, so this
        // branch is belt-and-braces).
        ...(row.status === "processing"
          ? row.approved
            ? { status: "done" as const }
            : { status: "needs_review" as const, reviewRequired: true }
          : {}),
      };
      const patch: Partial<Receipt> = {
        ...technical,
        fileName: renamed,
        originalFileName: receipt.originalFileName ?? receipt.fileName,
        vendor: ex.vendor,
        date: ex.date,
        amount: ex.amount,
        tax: ex.tax,
        currency: ex.currency,
        category: ex.category,
        confidence: ex.confidence,
        flags,
        logoMatch,
        methodUsed,
        methodDetail,
        cost,
        reviewRequired: needsReview,
        status: needsReview ? "needs_review" : "done",
        error: undefined,
      };
      // Third miss: human writes in consecutive milliseconds — land the
      // plumbing unconditionally rather than strand a "processing" row.
      const written =
        attempt < 2
          ? await repo.updateReceipt(receiptId, mode === "technical" ? technical : patch, {
              updatedAt: row.updatedAt,
            })
          : await repo.updateReceipt(receiptId, technical);
      if (written !== null) break;
      latest = await repo.getReceipt(receiptId);
      mode = completionWriteMode(latest, claimed.updatedAt, true); // someone wrote
    }
  } catch (err) {
    // Same human-outranks-machine rule on the failure path: never stamp
    // "failed" (and its flag overwrite) over a receipt approved mid-flight.
    const latest = await repo.getReceipt(receiptId);
    if (!latest?.approved && latest?.status !== "done") {
      await fail(receiptId, friendlyError(err, latest), latest?.updatedAt);
    }
    for (const key of [cleanedKey, annotatedKey]) {
      if (key && latest?.cleanedKey !== key && latest?.annotatedKey !== key) {
        await repo.deleteBlob(key).catch(() => {});
      }
    }
    throw err; // let the queue decide on retry
  }
}

/** Turn a decoder/engine exception into something the card can show and the
 *  user can act on. The raw message ("The source image could not be
 *  decoded.") never said that HEIC is the reason in every browser but
 *  Safari, or that a PDF is corrupt. Pure; Node-tested. */
export function friendlyError(
  err: unknown,
  r?: Pick<Receipt, "mimeType" | "fileName" | "originalFileName">,
): string {
  const raw = err instanceof Error ? err.message : String(err);
  const decodeFailure = /decod|bitmap|image/i.test(raw);
  const name = `${r?.originalFileName ?? ""} ${r?.fileName ?? ""}`.toLowerCase();
  const mime = (r?.mimeType ?? "").toLowerCase();
  if (decodeFailure && (mime.includes("heic") || mime.includes("heif") || /\.hei[cf]\b/.test(name))) {
    return "This browser can't decode HEIC photos — export the photo as JPEG (iPhone: Settings → Camera → Formats → Most Compatible) and add it again.";
  }
  // The text reader itself failed to come up (worker script, wasm core or
  // language data unreachable — an offline PWA, a network drop during the
  // one-time download): nothing is wrong with the receipt, so say so and
  // point at the retry.
  if (/failed to fetch|network ?error|importScripts|worker\.min|\.wasm|traineddata|OCR engine/i.test(raw)) {
    return "Couldn't load the text reader — check the connection, then use Retry reading.";
  }
  if (mime === "application/pdf" || /\.pdf\b/.test(name)) {
    return "This PDF couldn't be rendered — it may be corrupt or password-protected.";
  }
  if (decodeFailure) {
    return "This image couldn't be decoded — it may be corrupt or an unsupported format.";
  }
  return raw;
}

async function fail(
  receiptId: string,
  message: string,
  expectUpdatedAt?: number,
): Promise<void> {
  const body: Partial<Receipt> = {
    status: "failed",
    error: message,
    reviewRequired: true,
    flags: [{ code: "low_confidence", severity: "error", message }],
  };
  // Compare-and-swap like the completion write: a save that lands between
  // the caller's re-read and this put is a human's — re-check before
  // stamping "failed" over it.
  const written =
    expectUpdatedAt === undefined
      ? await repo.updateReceipt(receiptId, body)
      : await repo.updateReceipt(receiptId, body, { updatedAt: expectUpdatedAt });
  if (written !== null) return;
  const latest = await repo.getReceipt(receiptId);
  if (latest && !latest.approved && latest.status !== "done") {
    await repo.updateReceipt(receiptId, body);
  }
}
