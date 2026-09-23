import { FLAGS } from "../../config/constants.ts";
import type { BBox, Field, Flag, OcrLine } from "../../types.ts";
import { daysBetween, fromIso, monthFromName, toIso } from "../../util/format.ts";
import { DATE_LABEL_RE } from "./labels.ts";
import { sliceBBox } from "./text.ts";

// Dates: glyph repair, numeric/month-name/ctime forms, label ranking, and
// the future/stale/too-old flags.

interface DateHit {
  iso: string;
  ambiguous: boolean;
  bbox?: BBox;
  labeled: boolean;
}

/** Repair digit-glyph confusions INSIDE numeric-date-shaped tokens only
 *  ("l2/O2/2@23" → "12/02/2023") — month names elsewhere stay untouched.
 *  B is ambiguous (a bold 8 or a broken 0: "B2/08/2023" is February); both
 *  folds are tried and the one that yields a plausible date wins. */
function fixDateGlyphs(t: string): string {
  const digitish = "[\\dOoQIlL|pPSBGZ@©®°]";
  const re = new RegExp(
    `(?<![A-Za-z\\d])${digitish}{1,4}[-/.]${digitish}{1,2}[-/.]${digitish}{2,4}(?![A-Za-z\\d])`,
    "g",
  );
  const fold = (tok: string, bAs: string): string =>
    tok
      .replace(/[OoQpP@©®°]/g, "0")
      .replace(/[IlL|]/g, "1")
      .replace(/Z/g, "2")
      .replace(/S/g, "5")
      .replace(/G/g, "6")
      .replace(/B/g, bAs);
  const plausible = (tok: string): boolean => {
    const m = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(tok);
    if (!m) return false;
    const [, a, b] = m as unknown as [string, string, string];
    // Either y-m-d (first segment a year) or m/d/y — segments must be sane.
    if (a.length === 4) return Number(b) >= 1 && Number(b) <= 12;
    return Number(a) >= 1 && Number(a) <= 12 && Number(b) >= 1 && Number(b) <= 31;
  };
  return t.replace(re, (tok) => {
    const as8 = fold(tok, "8");
    if (!tok.includes("B") || plausible(as8)) return as8;
    const as0 = fold(tok, "0");
    return plausible(as0) ? as0 : as8;
  });
}

export function parseDatesInLine(line: OcrLine, labeled: boolean): DateHit[] {
  const out: DateHit[] = [];
  const t = fixDateGlyphs(line.text);
  const box = (m: RegExpMatchArray): BBox | undefined =>
    sliceBBox(line, m.index ?? 0, (m.index ?? 0) + m[0].length);

  // ISO yyyy-mm-dd
  for (const m of t.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) {
    pushNumeric(out, line, labeled, +m[1]!, +m[2]!, +m[3]!, "ymd", box(m));
  }
  // Numeric d/m/y or m/d/y
  for (const m of t.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/g)) {
    pushNumeric(out, line, labeled, +m[3]!, +m[1]!, +m[2]!, "mdy", box(m));
  }
  // Month name DD, YYYY — the comma may arrive with no space ("11,2024") or
  // read as a dot ("SEPTEMBER 11.2024"). The year must not be the hour of a
  // clock time: "TUE SEP 11 12:30 PM" read as 2012-09-11 (the ":" gave the
  // "12" a word boundary), hence the (?![:.]\d) lookahead on both forms.
  for (const m of t.matchAll(
    /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*[.,]\s*|\s+)(\d{2,4})\b(?![:.]\d)/g,
  )) {
    const mo = monthFromName(m[1]!);
    if (mo) addHit(out, line, labeled, +m[3]!, mo, +m[2]!, false, box(m));
  }
  // DD Month YYYY
  for (const m of t.matchAll(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?(?:\s*[.,]\s*|\s+)(\d{2,4})\b(?![:.]\d)/g,
  )) {
    const mo = monthFromName(m[2]!);
    if (mo) addHit(out, line, labeled, +m[3]!, mo, +m[1]!, false, box(m));
  }
  // ctime-style "Wed Sep 11 12:30:45 PDT 2024": the year sits after the time
  // (and an optional zone), out of reach of the forms above.
  for (const m of t.matchAll(
    /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?\s*(?:[A-Z]{2,5}\s+)?(\d{4})\b/g,
  )) {
    const mo = monthFromName(m[1]!);
    if (mo) addHit(out, line, labeled, +m[3]!, mo, +m[2]!, false, box(m));
  }
  return out;
}

function pushNumeric(
  out: DateHit[],
  line: OcrLine,
  labeled: boolean,
  year: number,
  a: number,
  b: number,
  order: "ymd" | "mdy",
  bbox?: BBox,
): void {
  let month: number, day: number, ambiguous = false;
  if (order === "ymd") {
    month = a;
    day = b;
  } else {
    // a=first field, b=second. Default US m/d; flip if impossible; ambiguous if both <=12.
    if (a > 12 && b <= 12) {
      month = b;
      day = a;
    } else if (b > 12 && a <= 12) {
      month = a;
      day = b;
    } else {
      month = a;
      day = b;
      ambiguous = a <= 12 && b <= 12 && a !== b;
    }
  }
  addHit(out, line, labeled, year, month, day, ambiguous, bbox);
}

function addHit(
  out: DateHit[],
  line: OcrLine,
  labeled: boolean,
  yearRaw: number,
  month: number,
  day: number,
  ambiguous: boolean,
  bbox?: BBox,
): void {
  let year = yearRaw;
  if (year < 100) year += 2000;
  // "2823" is a misread "2023" (0→8 is a common thermal-print confusion);
  // recover any 2xxx year whose last two digits form a plausible 20xx date.
  if (year > 2100 && year < 3000 && 2000 + (year % 100) <= 2100) {
    year = 2000 + (year % 100);
    ambiguous = true;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return;
  if (year < 2000 || year > 2100) return;
  const d = new Date(year, month - 1, day);
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return; // real date?
  const hit: DateHit = { iso: toIso(d), ambiguous, labeled };
  const b = bbox ?? line.bbox;
  if (b) hit.bbox = b;
  out.push(hit);
}

// A supplier invoice prints the payment deadline ("Due Date", Net 30) near the
// top — often ABOVE "Invoice Date" — and a first-labeled-line-wins pick shipped
// the deadline as the expense date (wrong MM-DD-YY file name, wrong Expense
// Period). Rank: a transaction-naming label first, then a bare "Date", then
// unlabeled dates, and only then a deadline/expiry/shipping label (kept as a
// last resort so a due-date-only stub still gets dated).
const DATE_STRONG_RE =
  /\b(invoice|order|transaction|sales?|receipt|purchase|service)\s*date\b/i;
const DATE_DEMOTE_RE =
  /\b(due|expir\w*|valid|ship\w*|deliver\w*|pay(?:ment)?\s*due)\s*date\b|\bdate\s+due\b/i;

function dateLabelRank(text: string): number {
  if (DATE_STRONG_RE.test(text)) return 0;
  if (DATE_DEMOTE_RE.test(text)) return 3;
  if (DATE_LABEL_RE.test(text)) return 1;
  return 2;
}

export function findDate(lines: OcrLine[]): Field<string> | null {
  let best: { hit: DateHit; rank: number } | null = null;
  for (const line of lines) {
    const rank = dateLabelRank(line.text);
    // Strict "<" keeps line order as the tie-break within a rank; a demoted
    // last-resort hit carries unlabeled confidence rather than 0.9.
    for (const hit of parseDatesInLine(line, rank <= 1)) {
      if (!best || rank < best.rank) best = { hit, rank };
    }
  }
  const chosen = best?.hit;
  if (!chosen) return null;
  const field: Field<string> = {
    value: chosen.iso,
    confidence: chosen.labeled ? 0.9 : chosen.ambiguous ? 0.65 : 0.8,
  };
  if (chosen.bbox) field.bbox = chosen.bbox;
  return field;
}

/** Plausibility flags for a receipt date (the rules read AND the AI assist's,
 *  vision/schema.ts): in the future; more than two years old — a
 *  review-forcing `date_suspect`, since an expense that old is almost always
 *  a misread year, and it replaces the informational stale flag rather than
 *  stacking on it; or merely stale. `now` is injectable for tests. */
export function dateFlags(date: Field<string> | null, now: Date = new Date()): Flag[] {
  const flags: Flag[] = [];
  if (!date) return flags;
  const d = fromIso(date.value);
  if (!d) return flags;
  if (d.getTime() > now.getTime() + 86_400_000) {
    flags.push({
      code: "future_date",
      severity: "warn",
      message: "Date is in the future.",
    });
  } else if (daysBetween(d, now) > FLAGS.suspectAfterDays) {
    flags.push({
      code: "date_suspect",
      severity: "warn",
      message: `Dated ${date.value} — more than two years old; check the year.`,
    });
  } else if (daysBetween(d, now) > FLAGS.staleAfterDays) {
    flags.push({
      code: "stale_date",
      severity: "info",
      message: `Receipt is over ${FLAGS.staleAfterDays} days old.`,
    });
  }
  return flags;
}
