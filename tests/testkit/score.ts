// score_extraction, ported verbatim from the original receipt_testkit.py:
// vendor .30 (containment; a blank truth rewards NOT fabricating), amount .40
// (±0.01), date .20 (exact ISO), category .10 (exact, case-insensitive).

export interface Truth {
  vendor: string;
  date: string;
  amount: number;
  category: string;
}

export interface Got {
  vendor: string;
  date: string;
  amount: number;
  category: string;
}

export interface Score {
  fields: { vendor: boolean; amount: boolean; date: boolean; category: boolean };
  score: number;
}

const normVendor = (s: string): string => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function vendorMatch(truth: string, got: string): boolean {
  const t = normVendor(truth);
  const g = normVendor(got);
  if (t === "") return g === ""; // blank truth: correct only if left blank
  if (g === "") return false;
  return t.includes(g) || g.includes(t); // generous containment
}

const WEIGHTS = { vendor: 0.3, amount: 0.4, date: 0.2, category: 0.1 } as const;

export function scoreExtraction(truth: Truth, got: Got): Score {
  const fields = {
    vendor: vendorMatch(truth.vendor, got.vendor),
    amount: Math.abs(truth.amount - got.amount) <= 0.01,
    date: (truth.date || "") === (got.date || ""),
    category: (truth.category || "").toLowerCase() === (got.category || "").toLowerCase(),
  };
  let score = 0;
  for (const [k, ok] of Object.entries(fields)) {
    if (ok) score += WEIGHTS[k as keyof typeof WEIGHTS];
  }
  return { fields, score: Math.round(score * 1e4) / 1e4 };
}

export interface BenchmarkRow {
  id: string;
  description: string;
  truth: Truth;
  got: Got;
  fields: Score["fields"];
  score: number;
}

export function formatScorecard(rows: BenchmarkRow[]): string {
  const mark = (b: boolean): string => (b ? " ✓" : " ·");
  const out = [
    "Receipt extraction benchmark (rules tier)",
    "=".repeat(64),
    `${"receipt".padEnd(20)}${"V".padStart(3)}${"A".padStart(3)}${"D".padStart(3)}${"C".padStart(3)}${"score".padStart(8)}`,
  ];
  for (const r of rows) {
    out.push(
      `${r.id.padEnd(20)}${mark(r.fields.vendor).padStart(3)}${mark(r.fields.amount).padStart(3)}` +
        `${mark(r.fields.date).padStart(3)}${mark(r.fields.category).padStart(3)}${r.score.toFixed(2).padStart(8)}`,
    );
  }
  const overall = rows.reduce((s, r) => s + r.score, 0) / Math.max(1, rows.length);
  out.push("-".repeat(64), `OVERALL: ${(overall * 100).toFixed(1)}%  (${rows.length} receipts)`);
  return out.join("\n");
}
