import type { OcrResult, OcrLine, OcrWord } from "../../src/types.ts";

// The fixed challenge suite, ported from the original app's receipt_testkit.py.
// The Python kit rendered PNGs and ran real OCR; this port exercises the same
// nine challenges at the OCR-text level (synthetic OcrResults with realistic
// line/word geometry), so the deterministic extraction rules are gated in CI
// with no model downloads. Image-level concerns (rotation, noise, blur) are
// covered by the browser e2e instead — here their receipts still gate the
// rules on degraded *confidence*.
//
// Truth categories are this app's taxonomy (the original's fuel/mats/misc,
// mapped: fuel→Fuel, mats→Office Supplies, misc→the richer bucket).

export interface Challenge {
  id: string;
  description: string;
  truth: { vendor: string; date: string; amount: number; category: string };
  lines: string[];
  /** Simulated OCR confidence (degraded for the faint/noisy challenges). */
  confidence?: number;
}

function body(
  vendor: string,
  items: [string, number][],
  total: number,
  dateStr: string,
  opts: { totalLabel?: string; headerAddr?: boolean } = {},
): string[] {
  const { totalLabel = "TOTAL", headerAddr = true } = opts;
  const lines = [vendor];
  if (headerAddr) lines.push("123 Main Street", "Springfield, IL", "-".repeat(28));
  for (const [name, price] of items) {
    lines.push(`${name.padEnd(18)}${price.toFixed(2).padStart(8)}`);
  }
  lines.push("-".repeat(28), `${totalLabel.padEnd(18)}${total.toFixed(2).padStart(8)}`, "", `Date: ${dateStr}`);
  return lines;
}

export function challengeSuite(): Challenge[] {
  return [
    {
      id: "clean",
      description: "Baseline — crisp, well-lit, single total.",
      truth: { vendor: "Shell", date: "2026-05-01", amount: 52.4, category: "Fuel" },
      lines: body("Shell", [["Unleaded 14.2g", 52.4]], 52.4, "05/01/2026"),
    },
    {
      id: "rotated_90",
      description: "Rotated 90° (image path) — rules gate on the recovered text.",
      truth: { vendor: "Home Depot", date: "2026-05-03", amount: 128.74, category: "Office Supplies" },
      lines: body(
        "Home Depot",
        [["2x4 Lumber", 48.0], ["Screws box", 12.74], ["Paint 1gal", 68.0]],
        128.74,
        "05/03/2026",
      ),
    },
    {
      id: "faint_thermal",
      description: "Faded thermal print — low confidence text.",
      truth: { vendor: "Chevron", date: "2026-04-28", amount: 41.1, category: "Fuel" },
      lines: body("Chevron", [["Fuel", 41.1]], 41.1, "04/28/2026"),
      confidence: 52,
    },
    {
      id: "multi_total",
      description: "Subtotal + tax + grand total — must pick the grand total.",
      truth: { vendor: "Olive Garden", date: "2026-05-10", amount: 86.31, category: "Meals & Entertainment" },
      lines: [
        "Olive Garden",
        "Italian Kitchen",
        "-".repeat(28),
        `${"Entrees".padEnd(18)}${(72.0).toFixed(2).padStart(8)}`,
        `${"Drinks".padEnd(18)}${(7.0).toFixed(2).padStart(8)}`,
        "-".repeat(28),
        `${"SUBTOTAL".padEnd(18)}${(79.0).toFixed(2).padStart(8)}`,
        `${"TAX".padEnd(18)}${(7.31).toFixed(2).padStart(8)}`,
        `${"GRAND TOTAL".padEnd(18)}${(86.31).toFixed(2).padStart(8)}`,
        "",
        "Date: 05/10/2026",
      ],
    },
    {
      id: "us_date_ambiguous",
      description: "Date 03/04/2026 — must read US month/day → March 4, not April 3.",
      truth: { vendor: "Mobil", date: "2026-03-04", amount: 38.9, category: "Fuel" },
      lines: body("Mobil", [["Gasoline", 38.9]], 38.9, "03/04/2026"),
    },
    {
      id: "noisy_scan",
      description: "Speckled, blurred scan — degraded confidence.",
      truth: { vendor: "Lowe's", date: "2026-05-06", amount: 73.55, category: "Office Supplies" },
      lines: body("Lowe's", [["PVC pipe", 23.55], ["Fittings", 50.0]], 73.55, "05/06/2026"),
      confidence: 58,
    },
    {
      id: "long_itemized",
      description: "Many line items — must still find the printed total.",
      truth: { vendor: "Costco", date: "2026-05-12", amount: 214.83, category: "Office Supplies" },
      lines: body(
        "Costco Wholesale",
        [
          ["Water 40pk", 4.99],
          ["Coffee 2lb", 17.99],
          ["Paper towels", 21.99],
          ["Batteries", 15.49],
          ["Snacks", 28.5],
          ["Cleaning sup", 33.87],
          ["Office chair", 91.99],
        ],
        214.83,
        "05/12/2026",
      ),
    },
    {
      id: "missing_vendor",
      description: "No legible vendor — must NOT fabricate one (blank is correct).",
      truth: { vendor: "", date: "2026-05-08", amount: 19.25, category: "Other" },
      lines: [
        "",
        "",
        "-".repeat(28),
        `${"Item".padEnd(18)}${(19.25).toFixed(2).padStart(8)}`,
        "-".repeat(28),
        `${"TOTAL".padEnd(18)}${(19.25).toFixed(2).padStart(8)}`,
        "",
        "Date: 05/08/2026",
      ],
    },
    {
      id: "big_amount",
      description: "Large multi-thousand total.",
      truth: { vendor: "Ferguson", date: "2026-05-15", amount: 4218.0, category: "Office Supplies" },
      lines: body("Ferguson Supply", [["HVAC unit", 3998.0], ["Delivery", 220.0]], 4218.0, "05/15/2026"),
    },
  ];
}

/** Turn printed lines into an OcrResult with plausible geometry: lines stack
 *  top→bottom; words get proportional x-offsets so "rightmost amount" works. */
export function linesToOcr(lines: string[], confidence = 90): OcrResult {
  const kept = lines.map((t, i) => ({ text: t, i })).filter((l) => l.text.trim());
  const n = Math.max(1, lines.length);
  const ocrLines: OcrLine[] = kept.map(({ text, i }) => {
    const y = 0.05 + (i / n) * 0.85;
    const bbox = { x: 0.08, y, w: 0.84, h: 0.03 };
    const words: OcrWord[] = [];
    // Split on runs of 2+ spaces (columns), then single spaces.
    let cursor = 0;
    for (const token of text.trim().split(/\s+/)) {
      const at = text.indexOf(token, cursor);
      cursor = at + token.length;
      const x = 0.08 + (at / Math.max(28, text.length)) * 0.84;
      const w = (token.length / Math.max(28, text.length)) * 0.84;
      words.push({ text: token, confidence, bbox: { x, y, w, h: 0.03 } });
    }
    return { text: text.trim(), confidence, bbox, words };
  });
  return {
    text: lines.join("\n"),
    confidence,
    lines: ocrLines,
    words: ocrLines.flatMap((l) => l.words),
  };
}
