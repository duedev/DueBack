import type { BBox, OcrLine } from "../../types.ts";
import { parseAmount } from "../../util/money.ts";
import { findDate, parseDatesInLine } from "./date.ts";
import { DATE_LABEL_RE, lenientTotalLine, PAYMENT_RE } from "./labels.ts";
import { MONEY_SRC, moneyHitsFromLine } from "./money.ts";
import { findAliasOnLines, VENDOR_STOPWORD_RE } from "./vendor.ts";

// ── Post-hoc field location ──────────────────────────────────────────────────
// The digital "go back and find it": after a human corrects a field in
// review, locate the corrected value on the receipt's OCR lines so the
// highlight can be re-baked onto the image and the correction logged with
// provenance for training.

export function locateValue(
  lines: OcrLine[],
  kind: "amount" | "vendor" | "date",
  value: string | number,
): { bbox: BBox; lineText: string } | null {
  if (kind === "amount") {
    const target = Number(value);
    if (!Number.isFinite(target) || target <= 0) return null;
    let best: { bbox: BBox; lineText: string; payment: boolean } | null = null;
    for (const line of lines) {
      const payment = PAYMENT_RE.test(line.text);
      // Same lenient rule as extraction: a labeled total may be a bare
      // integer ("TOTAL 9") — the corrected value must be locatable there.
      for (const h of moneyHitsFromLine(line, lenientTotalLine(line.text))) {
        if (Math.abs(h.value - target) > 0.005) continue;
        if (!best || (best.payment && !payment)) {
          best = { bbox: h.bbox ?? line.bbox, lineText: line.text, payment };
        }
      }
    }
    return best ? { bbox: best.bbox, lineText: best.lineText } : null;
  }

  if (kind === "vendor") {
    const needle = String(value).trim().toLowerCase();
    const first = needle.split(/\s+/)[0] ?? "";
    // Full name first; then the leading word — corrections often use the
    // canonical brand form the receipt doesn't print in full. Never a
    // stopword ("The" would land on "OTHER STORE"), and word-bounded like
    // brand matching — a bare substring put "Ace" on "REPLACE" and baked
    // that box onto the image and into the training log.
    const probes = [
      needle,
      ...(first !== needle && !VENDOR_STOPWORD_RE.test(first) ? [first] : []),
    ].filter((p) => p.length >= 3);
    for (const probe of probes) {
      const hit = findAliasOnLines(lines, probe);
      if (hit) return hit;
    }
    return null;
  }

  // date: any line whose parsed dates (numeric or month-name forms, with
  // glyph repair) include the ISO value — the same machinery extraction uses.
  const iso = String(value);
  for (const line of lines) {
    for (const hit of parseDatesInLine(line, DATE_LABEL_RE.test(line.text))) {
      if (hit.iso === iso) {
        return { bbox: hit.bbox ?? line.bbox, lineText: line.text };
      }
    }
  }
  return null;
}

/** Read a field's value from the OCR lines inside a HAND-DRAWN box — the
 *  reverse of `locateValue`: the human points at the receipt, the stored
 *  geometry supplies the text. A line counts as "inside" when its vertical
 *  center falls in the box and it overlaps horizontally. Returns null when
 *  nothing readable sits there (the box still stands; only autofill skips). */
export function readValueInBox(
  lines: OcrLine[],
  kind: "amount" | "vendor" | "date",
  box: BBox,
): string | number | null {
  const inBox = lines.filter((l) => {
    const b = l.bbox;
    if (!b || b.w <= 0 || b.h <= 0) return false;
    const cy = b.y + b.h / 2;
    const overlapX = Math.min(b.x + b.w, box.x + box.w) - Math.max(b.x, box.x);
    return cy >= box.y && cy <= box.y + box.h && overlapX > 0;
  });
  if (inBox.length === 0) return null;

  if (kind === "date") {
    return findDate(inBox)?.value ?? null;
  }
  if (kind === "amount") {
    // The largest strict-money token inside the box: a drawn total box may
    // still catch a quantity fragment, and the grand total out-ranks it.
    let best: number | null = null;
    for (const l of inBox) {
      for (const m of l.text.matchAll(new RegExp(MONEY_SRC, "g"))) {
        const v = parseAmount(m[0]);
        if (v !== null && v > 0 && (best === null || v > best)) best = v;
      }
    }
    if (best === null) {
      // No strict money in the box: a labeled total may print a bare integer
      // ("TOTAL 9"), which extraction reads leniently — so does the box.
      for (const l of inBox) {
        if (!lenientTotalLine(l.text)) continue;
        for (const h of moneyHitsFromLine(l, true)) {
          if (h.value > 0 && (best === null || h.value > best)) best = h.value;
        }
      }
    }
    return best;
  }
  // Vendor: the longest line in the box (short fragments are usually noise).
  const texts = inBox.map((l) => l.text.replace(/\s{2,}/g, " ").trim()).filter(Boolean);
  if (texts.length === 0) return null;
  return texts.sort((a, b) => b.length - a.length)[0]!.slice(0, 60);
}
