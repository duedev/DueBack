import { repo } from "../store/repo.ts";
import { cleanImage, binarizeBlob } from "./imagePrep.ts";
import { hashBlob } from "./hash.ts";
import { parseReceipt, type Extraction } from "./extract.ts";
import { findSemanticDuplicate, type DupRecord } from "./dedup.ts";
import { getOcrEngine, type OcrEngine } from "./ocr.ts";
import { runVisionAssist } from "./vision/index.ts";
import { matchVendor } from "../config/vendors.ts";
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

export async function processReceipt(
  receiptId: string,
  engine: OcrEngine = getOcrEngine(),
): Promise<void> {
  const receipt = await repo.getReceipt(receiptId);
  if (!receipt) return;

  await repo.updateReceipt(receiptId, { status: "processing", error: undefined });

  const original = await repo.getBlob(receipt.fileKey);
  if (!original) {
    await fail(receiptId, "Original image is missing.");
    return;
  }

  try {
    // 1. Clean (auto-rotate, grayscale, auto-crop, downscale).
    const cleaned = await cleanImage(original);
    URL.revokeObjectURL(cleaned.url); // we persist the blob, not this URL
    const cleanedKey = await repo.putBlob(cleaned.blob, "cleaned");

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
        lines: [],
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
    let ex: Extraction = parseReceipt(ocr, { currencyDefault: receipt.currency });

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
        const ex2 = parseReceipt(ocr2, { currencyDefault: receipt.currency });
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

    // 4b. Visual logo identity. A confident OCR-text brand match is recorded as
    //     provenance; otherwise, when there is a logo index to match against and
    //     the vendor is blank/shaky, the header band is embedded and compared
    //     against the brand index. Best-effort — any failure keeps the rules
    //     result untouched. Skipped entirely (no model download) while the
    //     index is empty.
    let logoMatch: LogoMatch | undefined;
    try {
      const textMatch = matchVendor(ocr.text);
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
    const assist = await runVisionAssist(cleaned.blob, ex, {
      currencyDefault: receipt.currency,
    });
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

    const hasError = flags.some((f) => f.severity === "error");
    const needsReview =
      hasError ||
      Boolean(duplicateOf) ||
      ex.confidence < CONFIDENCE.reviewBelow ||
      ex.amount.value <= 0;

    // Bake highlighter marks (vendor/date/amount) onto an annotated copy for
    // exports and thumbnails — the review modal keeps the clean image with
    // live overlays. Best-effort: any failure just skips the highlights.
    let annotatedKey: string | undefined;
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
            fileName: receipt.originalFileName ?? receipt.fileName,
          })
        : receipt.fileName;

    const patch: Partial<Receipt> = {
      fileName: renamed,
      originalFileName: receipt.originalFileName ?? receipt.fileName,
      cleanedKey,
      ...(annotatedKey ? { annotatedKey } : {}),
      imageHash,
      imageWidth: cleaned.width,
      imageHeight: cleaned.height,
      vendor: ex.vendor,
      date: ex.date,
      amount: ex.amount,
      tax: ex.tax,
      currency: ex.currency,
      category: ex.category,
      confidence: ex.confidence,
      flags,
      ocrText: ocrTextOut,
      logoMatch,
      methodUsed,
      methodDetail,
      cost,
      reviewRequired: needsReview,
      status: needsReview ? "needs_review" : "done",
      error: undefined,
    };
    await repo.updateReceipt(receiptId, patch);
  } catch (err) {
    await fail(receiptId, err instanceof Error ? err.message : String(err));
    throw err; // let the queue decide on retry
  }
}

async function fail(receiptId: string, message: string): Promise<void> {
  await repo.updateReceipt(receiptId, {
    status: "failed",
    error: message,
    reviewRequired: true,
    flags: [{ code: "low_confidence", severity: "error", message }],
  });
}
