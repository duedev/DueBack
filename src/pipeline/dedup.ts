import { matchVendor } from "../config/vendors.ts";
import { foldToAscii } from "../util/rename.ts";
import type { Flag } from "../types.ts";

// Duplicate detection — adapted from the original app's `_detect_duplicates`.
// Three tiers, strongest first (`duplicateFlag`):
//  1. an exact image-hash twin — a byte-identical re-upload (the pipeline
//     passes it in from its hash cache);
//  2. the same receipt captured twice (different pixels, same data), keyed on
//     vendor IDENTITY + date + amount (`semanticKey`). A non-zero amount is
//     required — without it there's nothing reliable to match on — and so
//     are BOTH a vendor and a date: two unreadable receipts that happen to
//     share an amount are not duplicates of each other;
//  3. the card slip and the invoice of ONE transaction, whose vendor
//     spellings and date reads can both differ: the same amount to the cent
//     AND a shared labeled transaction code — card approval, invoice or
//     reference number (`sharedTransactionCode`). The code is what makes
//     dropping the vendor/date requirement safe here: an issuer's approval
//     code or a merchant's invoice number doesn't recur on a different
//     purchase of the same amount.
// Every duplicate flag names its twin by id (`Flag.ref`) so review can put
// the two side by side (`findDuplicatePair`, from either side).

export interface DupRecord {
  /** Stable identity so a record never matches itself. */
  id: string;
  /** Human-friendly label for the flag message (e.g. the file name). */
  label: string;
  vendor: string;
  date: string;
  amount: number;
}

const identityMemo = new Map<string, string>();

/** Vendor identity for dedup: the canonical brand when the name carries one
 *  ("Chevron Station Inc.", "Chevron Stations Inc", "Palm Spring Chevron" →
 *  "chevron"), else the name folded — accents to ASCII, apostrophes dropped,
 *  then punctuation, `#NNN` store numbers and corporate suffixes ("PIP
 *  Printing, Inc." ≡ "pip printing", "Café Rouge" ≡ "Cafe Rouge", "Bob's" ≡
 *  "Bobs"). The app e-receipt and the paper slip of one fill-up spell the
 *  station differently, and the AI assist keeps accents OCR drops. Memoized:
 *  review re-derives pairs on every board refresh and the matcher scans
 *  ~1.5k alias patterns. */
export function vendorIdentity(vendor: string): string {
  const v = (vendor || "").trim();
  if (!v) return "";
  const hit = identityMemo.get(v);
  if (hit !== undefined) return hit;
  const brand = matchVendor(v);
  const id = brand
    ? brand.name.toLowerCase()
    : foldToAscii(v)
        .toLowerCase()
        .replace(/['’]/g, "")
        .replace(/#\s*\d+/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\b(?:the|inc|llc|ltd|co|corp|corporation|company)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim() || v.toLowerCase(); // folds to nothing (non-Latin, "The Co"): key as itself
  if (identityMemo.size >= 500) identityMemo.clear();
  identityMemo.set(v, id);
  return id;
}

/** Normalized vendor|date|amount key, or null when there's no usable amount. */
export function semanticKey(r: Pick<DupRecord, "vendor" | "date" | "amount">): string | null {
  const amount = Math.round((r.amount || 0) * 100) / 100;
  if (amount <= 0) return null;
  const vendor = vendorIdentity(r.vendor);
  const date = (r.date || "").trim();
  // Both identity fields are required: a vendor-only key ("shell", $45.20)
  // matched every same-price fill-up on a trip, and a date-only key matched
  // two different lunches — real receipts flagged as duplicates.
  if (!vendor || !date) return null;
  return `${vendor}|${date}|${amount.toFixed(2)}`;
}

/**
 * Return the first record in `others` that is a likely duplicate of `current`
 * (same vendor, date and amount), or null. `others` would typically be the
 * already-processed receipts in the same batch.
 */
export function findSemanticDuplicate(
  current: DupRecord,
  others: DupRecord[],
): DupRecord | null {
  const key = semanticKey(current);
  if (!key) return null;
  for (const o of others) {
    if (o.id === current.id) continue;
    if (semanticKey(o) === key) return o;
  }
  return null;
}

// ── Shared transaction codes (tier 3) ────────────────────────────────────────

export type CodeKind = "approval" | "invoice" | "reference";
export interface TransactionCode {
  /** Uppercased, leading zeros kept ("08683D", "0000014524"). */
  code: string;
  kind: CodeKind;
}

// A label, an optional qualifier, then the code: "AUTH 08683D", "APPR CODE:
// 05439D", "AUTH. CODE: 104740", "INVOICE 0000014524", "REF#: 12345",
// "(ref #05439D)", "INV# 88412", "TRANSACTION # 77120". INV and TRAN need a
// qualifier (bare "INV"/"TRANS" are words). A code followed by ".dd"/",dd"
// is money, not a code.
const CODE_RE =
  /\b(?:(AUTH(?:ORI[SZ]ATION)?|APPR(?:OVAL)?)|(INVOICE|INV(?=\s*(?:#|NO\b|NUM)))|(REF(?:ERENCE)?|TRANS?(?:ACTION)?(?=\s*(?:#|NO\b|NUM|ID\b))))\b[\s.#:]*(?:(?:CODE|NO|NUM(?:BER)?|ID)\b[\s.#:]*)?([A-Z0-9]{5,})(?![A-Z0-9]|[.,]\d)/gi;
// Lines that identify the PLACE, not the purchase: a site/store/terminal/
// merchant id recurs on every receipt from that station ("SITE ID:
// chevron0009-7414"), so nothing on such a line is ever read as a code.
const PLACE_ID_LINE_RE = /\b(?:SITE|STORE|TERM(?:INAL)?|TID|MID|MERCH(?:ANT)?)\b/i;

/** The labeled transaction codes on a receipt's OCR lines. A code carries a
 *  digit and at least 4 characters after its leading zeros: "REF#: 00000003"
 *  is a terminal's running counter, which collides across terminals. Pure. */
export function transactionCodes(lines: readonly { text: string }[] | undefined): TransactionCode[] {
  const out: TransactionCode[] = [];
  const seen = new Set<string>();
  for (const line of lines ?? []) {
    const text = line.text ?? "";
    if (PLACE_ID_LINE_RE.test(text)) continue;
    for (const m of text.matchAll(CODE_RE)) {
      const code = m[4]!.toUpperCase();
      if (!/\d/.test(code) || code.replace(/^0+/, "").length < 4) continue;
      const kind: CodeKind = m[1] ? "approval" : m[2] ? "invoice" : "reference";
      if (seen.has(`${kind}|${code}`)) continue;
      seen.add(`${kind}|${code}`);
      out.push({ code, kind });
    }
  }
  return out;
}

// OCR glyph confusions inside a code: the card slip and the invoice print one
// approval code in different fonts (the owner's "05439D" read as "054300").
const CODE_GLYPHS: Record<string, string> = { O: "0", Q: "0", D: "0", I: "1", L: "1", S: "5", B: "8", Z: "2" };
const foldCode = (c: string): string => c.replace(/[OQDILSBZ]/g, (ch) => CODE_GLYPHS[ch]!);

/** Levenshtein distance ≤ 1 (one substitution, insertion or deletion). */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

const KIND_RANK: Record<CodeKind, number> = { approval: 0, invoice: 1, reference: 2 };

/** The transaction code two receipts share, or null. Exact equality counts
 *  for any kind. One looser case: an APPROVAL code on one receipt against a
 *  reference/invoice number on the OTHER — the slip-and-invoice pair, where
 *  the merchant's invoice reprints the card's approval code in its own font
 *  ("ref #05439D" read as "054300") — also matches through OCR glyph
 *  confusions plus one edit (both ≥ 6 characters). Same-kind codes only
 *  ever match exactly: invoice and reference numbers are SEQUENTIAL (the
 *  next customer's is one digit away), and some issuers' approval codes run
 *  like counters ("01503R", "01520R" in the owner's batch), so two
 *  round-dollar prepaid fill-ups can sit one edit apart. An approval code wins the report (it is the
 *  card's own proof of one transaction). Pure. */
export function sharedTransactionCode(
  a: readonly TransactionCode[],
  b: readonly TransactionCode[],
): TransactionCode | null {
  let best: TransactionCode | null = null;
  const offer = (c: TransactionCode): void => {
    if (!best || KIND_RANK[c.kind] < KIND_RANK[best.kind]) best = c;
  };
  for (const x of a) {
    for (const y of b) {
      if (x.code === y.code) {
        offer({ code: x.code, kind: KIND_RANK[x.kind] <= KIND_RANK[y.kind] ? x.kind : y.kind });
        continue;
      }
      // Exactly one side an approval code (cross-kind), never two of a kind.
      const approval =
        x.kind === "approval" && y.kind !== "approval"
          ? x
          : y.kind === "approval" && x.kind !== "approval"
            ? y
            : null;
      if (
        approval &&
        x.code.length >= 6 &&
        y.code.length >= 6 &&
        withinOneEdit(foldCode(x.code), foldCode(y.code))
      ) {
        // Quote the approval side: the code as the card network printed it.
        offer({ code: approval.code, kind: "approval" });
      }
    }
  }
  return best;
}

const CODE_NOUN: Record<CodeKind, string> = {
  approval: "card approval code",
  invoice: "invoice number",
  reference: "reference number",
};

/** Same amount to the cent, and more than zero. */
function sameCents(a: number, b: number): boolean {
  const ca = Math.round((a || 0) * 100);
  return ca > 0 && ca === Math.round((b || 0) * 100);
}

// ── Pairs ────────────────────────────────────────────────────────────────────

/** What pairing needs of a receipt. A structural subset of Receipt, so board
 *  rows pass as-is and tests build plain objects. */
export interface DupCandidate {
  id: string;
  fileName: string;
  originalFileName?: string;
  imageHash?: string;
  vendor: { value: string };
  date: { value: string };
  amount: { value: number };
  flags: readonly Pick<Flag, "code" | "message" | "ref">[];
  ocrLines?: readonly { text: string }[];
}
type Sibling = Pick<
  DupCandidate,
  "id" | "fileName" | "originalFileName" | "vendor" | "date" | "amount" | "ocrLines"
>;

/** The name a flag quotes: the upload's own name. The renamed fileName
 *  COLLIDES between twins (both copies become fuel_02-11-26_chevron.jpg), so
 *  quoting it read "same as <my own name>" on the flagged card. */
const shownName = (r: Pick<DupCandidate, "fileName" | "originalFileName">): string =>
  r.originalFileName ?? r.fileName;

function toDupRecord(r: Sibling): DupRecord {
  return {
    id: r.id,
    label: shownName(r),
    vendor: r.vendor.value,
    date: r.date.value,
    amount: r.amount.value,
  };
}

/** What two receipts share that makes them read as one purchase, strongest
 *  tier first (the order `duplicateFlag` tries them in). */
type DupTie = { tier: "hash" } | { tier: "semantic" } | { tier: "code"; shared: TransactionCode };

/** The tie between two receipts as they are NOW, or null when they share
 *  none (an edit since, or a pair linked only through a copy that was
 *  deleted). Pure. */
function pairTie(a: Omit<DupCandidate, "flags">, b: Omit<DupCandidate, "flags">): DupTie | null {
  if (a.imageHash && a.imageHash === b.imageHash) return { tier: "hash" };
  const key = semanticKey(toDupRecord(a));
  if (key && key === semanticKey(toDupRecord(b))) return { tier: "semantic" };
  if (sameCents(a.amount.value, b.amount.value)) {
    const shared = sharedTransactionCode(transactionCodes(a.ocrLines), transactionCodes(b.ocrLines));
    if (shared) return { tier: "code", shared };
  }
  return null;
}

/** A duplicate flag's message, quoting the twin's name. One wording per
 *  tier, shared by the pipeline's flag and review's re-pointed one. */
function duplicateMessage(tie: DupTie | null, name: string): string {
  if (!tie) return `Possible duplicate of "${name}" — both matched a copy that was deleted.`;
  if (tie.tier === "hash") return `Looks identical to "${name}".`;
  if (tie.tier === "semantic") return `Same vendor, date and amount as "${name}" — possible duplicate.`;
  return `Same amount and ${CODE_NOUN[tie.shared.kind]} (${tie.shared.code}) as "${name}" — possible duplicate.`;
}

/** The `duplicate` flag for a freshly read receipt, or null. An exact image-
 *  hash twin in the batch (a byte-identical re-upload) wins; failing that, a
 *  sibling with the same vendor identity, date and amount; failing that, one
 *  with the same amount and a shared transaction code (`read.lines` against
 *  each sibling's stored `ocrLines`). The flag names the twin by id (`ref`)
 *  so review can put both side by side. `siblings` may include the receipt
 *  itself — it never matches itself. Pure. */
export function duplicateFlag(
  read: {
    id: string;
    vendor: string;
    date: string;
    amount: number;
    lines?: readonly { text: string }[];
  },
  hashTwin: Pick<DupCandidate, "id" | "fileName" | "originalFileName"> | undefined,
  siblings: readonly Sibling[],
): Flag | null {
  if (hashTwin) {
    return {
      code: "duplicate",
      severity: "warn",
      message: duplicateMessage({ tier: "hash" }, shownName(hashTwin)),
      ref: hashTwin.id,
    };
  }
  const others = siblings.filter((s) => s.id !== read.id);
  const semantic = findSemanticDuplicate({ ...read, label: "" }, others.map(toDupRecord));
  if (semantic) {
    return {
      code: "duplicate",
      severity: "warn",
      message: duplicateMessage({ tier: "semantic" }, semantic.label),
      ref: semantic.id,
    };
  }
  const mine = transactionCodes(read.lines);
  if (mine.length === 0) return null;
  for (const s of others) {
    if (!sameCents(read.amount, s.amount.value)) continue;
    const shared = sharedTransactionCode(mine, transactionCodes(s.ocrLines));
    if (shared) {
      return {
        code: "duplicate",
        severity: "warn",
        message: duplicateMessage({ tier: "code", shared }, shownName(s)),
        ref: s.id,
      };
    }
  }
  return null;
}

const QUOTED_NAME_RE = /"([^"]+)"/;

/** The sibling a stored `duplicate` flag on `holder` points at, or null.
 *  - A `ref` resolves to that receipt only: a deleted twin resolves to null,
 *    never to a stand-in.
 *  - Flags stored before `ref` quoted the twin's file name as it was then,
 *    and names collide even between NON-duplicates (one batch holds two
 *    fuel_03-02-26_chevron_station_inc.jpg: $83.44 and $94.14). In order: a
 *    same-imageHash sibling; a sibling carrying the quoted name (fileName or
 *    originalFileName) that also matches on vendor/date/amount; any fresh
 *    vendor/date/amount match; the quoted name alone only when exactly one
 *    sibling carries it. Never the holder — renamed twins share its name.
 *  Pure. */
export function resolveDuplicateFlag<T extends DupCandidate>(
  holder: DupCandidate,
  flag: Pick<Flag, "message" | "ref">,
  all: readonly T[],
): T | null {
  const others = all.filter((o) => o.id !== holder.id);
  if (flag.ref) return others.find((o) => o.id === flag.ref) ?? null;
  if (holder.imageHash) {
    const twin = others.find((o) => o.imageHash === holder.imageHash);
    if (twin) return twin;
  }
  const quoted = QUOTED_NAME_RE.exec(flag.message)?.[1];
  const named = quoted
    ? others.filter((o) => o.fileName === quoted || o.originalFileName === quoted)
    : [];
  const key = semanticKey(toDupRecord(holder));
  if (key) {
    const hit =
      named.find((o) => semanticKey(toDupRecord(o)) === key) ??
      others.find((o) => semanticKey(toDupRecord(o)) === key);
    if (hit) return hit;
  }
  return named.length === 1 ? named[0]! : null;
}

export interface DuplicatePair<T> {
  peer: T;
  /** Who carries the flag: the open receipt, or its twin. */
  heldBy: "self" | "peer";
}

/** Every suspected-duplicate pair `self` belongs to, from EITHER side, one
 *  entry per twin: first its own duplicate flags' twins, then siblings whose
 *  duplicate flag resolves to `self`. The pipeline flags only the copy read
 *  second, and review must still compare from the first. Pure. */
export function duplicatePairs<T extends DupCandidate>(
  self: DupCandidate,
  all: readonly T[],
): DuplicatePair<T>[] {
  const out: DuplicatePair<T>[] = [];
  const seen = new Set<string>();
  for (const f of self.flags) {
    if (f.code !== "duplicate") continue;
    const peer = resolveDuplicateFlag(self, f, all);
    if (peer && !seen.has(peer.id)) {
      seen.add(peer.id);
      out.push({ peer, heldBy: "self" });
    }
  }
  for (const o of all) {
    if (o.id === self.id || seen.has(o.id)) continue;
    const pointsHere = o.flags.some(
      (f) => f.code === "duplicate" && resolveDuplicateFlag(o, f, all)?.id === self.id,
    );
    if (pointsHere) {
      seen.add(o.id);
      out.push({ peer: o, heldBy: "peer" });
    }
  }
  return out;
}

/** The first suspected-duplicate pair `self` belongs to, or null. */
export function findDuplicatePair<T extends DupCandidate>(
  self: DupCandidate,
  all: readonly T[],
): DuplicatePair<T> | null {
  return duplicatePairs(self, all)[0] ?? null;
}

/** Why two receipts read as duplicates, in one sentence for the compare bar
 *  — recomputed from the pair as it is NOW (an edit since may have changed
 *  the reason). Pure. */
export function duplicateReason(a: DupCandidate, b: DupCandidate): string {
  const tie = pairTie(a, b);
  if (!tie) return "Flagged as a possible duplicate when it was read.";
  if (tie.tier === "hash") return "The two images are identical.";
  if (tie.tier === "semantic") return "Same vendor, date and amount.";
  return `Same amount and ${CODE_NOUN[tie.shared.kind]} (${tie.shared.code}).`;
}

/** `holder`'s flags minus its duplicate warnings about `otherId` (by ref, or
 *  whatever a flag stored before ref resolves to) and minus any that resolve
 *  to nothing at all — a twin that is gone. `otherId` null drops only the
 *  unresolvable ones. Other flags pass through untouched: review only ever
 *  REMOVES a warning here. Pure. */
export function flagsWithoutDuplicate<F extends Pick<Flag, "code" | "message" | "ref">>(
  holder: Omit<DupCandidate, "flags"> & { flags: readonly F[] },
  otherId: string | null,
  all: readonly DupCandidate[],
): F[] {
  return holder.flags.filter((f) => {
    if (f.code !== "duplicate") return true;
    const target = resolveDuplicateFlag(holder, f, all);
    return target !== null && target.id !== otherId;
  });
}

// ── Deleting one copy of three or more ──────────────────────────────────────
// Review's delete used to settle only the first pair: with A, B and C all
// copies of one purchase (B and C each flagged against A), deleting A cleared
// B's warning and left C's ref pointing at nothing — C read "no longer on
// this board" with a Dismiss, while its real twin B sat beside it in the
// TOTAL. The copies left behind are still copies of each other, so their
// warnings about the deleted one are RE-POINTED, never dropped.

/** `holder`'s flags with every duplicate warning about `fromId` (by ref, or
 *  whatever a flag stored before `ref` resolves to in `all` — pass the list
 *  as it stood BEFORE `fromId` was deleted, or a legacy flag has nothing
 *  left to resolve to) re-pointed at `keeper`: `ref` becomes the keeper's
 *  id and the message is rebuilt from the holder–keeper pair as it is now,
 *  quoting the keeper's upload name. Never adds a warning and never drops a
 *  live one: a re-pointed warning that would repeat one the holder already
 *  carries about the keeper folds into it (one pair, one warning). The
 *  keeper itself (and the deleted copy) pass through untouched — a receipt
 *  is never its own duplicate. Untouched flags keep their identity. Pure. */
export function retargetDuplicateFlags<F extends Pick<Flag, "code" | "message" | "ref">>(
  holder: Omit<DupCandidate, "flags"> & { flags: readonly F[] },
  fromId: string,
  keeper: Omit<DupCandidate, "flags">,
  all: readonly DupCandidate[],
): F[] {
  if (holder.id === keeper.id || holder.id === fromId) return [...holder.flags];
  const about = (f: F): string | undefined =>
    f.code === "duplicate" ? resolveDuplicateFlag(holder, f, all)?.id : undefined;
  let keeperWarned = holder.flags.some((f) => about(f) === keeper.id);
  const out: F[] = [];
  for (const f of holder.flags) {
    if (about(f) !== fromId) {
      out.push(f);
      continue;
    }
    if (keeperWarned) continue; // already flagged against the keeper
    keeperWarned = true;
    out.push({ ...f, ref: keeper.id, message: duplicateMessage(pairTie(holder, keeper), shownName(keeper)) });
  }
  return out;
}

export interface DuplicateDeletePlan<T> {
  /** The copy the others now point at. Its own warning about the deleted
   *  copy is settled (review's `flagsWithoutDuplicate`) — unless `onward`. */
  keeper: T;
  /** When the deleted copy was itself flagged as a copy of ANOTHER
   *  survivor, the keeper's warning moves there instead of being settled:
   *  the keeper and that survivor are still two copies of one purchase. */
  onward: T | null;
  /** The other survivors: each re-points its warnings about the deleted
   *  copy at the keeper (`retargetDuplicateFlags`). */
  others: T[];
}

/** How the copies paired with `x` settle when `x` is deleted, computed from
 *  the list as it stands BEFORE the delete. `keeper` is the copy the human
 *  chose to keep (review's "Delete it" keeps the open receipt); without one,
 *  the OLDEST survivor by createdAt anchors the rest (the copy read first).
 *  Null when `x` is paired with nothing and no keeper was named. Pure. */
export function planDuplicateDelete<T extends DupCandidate & { createdAt?: number }>(
  x: DupCandidate,
  before: readonly T[],
  keeper?: T,
): DuplicateDeletePlan<T> | null {
  const pairs = duplicatePairs(x, before);
  const survivors = pairs.map((p) => p.peer);
  const anchor =
    keeper ??
    survivors.reduce<T | null>(
      (best, s) => (!best || (s.createdAt ?? Infinity) < (best.createdAt ?? Infinity) ? s : best),
      null,
    );
  if (!anchor) return null;
  const onward = pairs.find((p) => p.heldBy === "self" && p.peer.id !== anchor.id)?.peer ?? null;
  return { keeper: anchor, onward, others: survivors.filter((s) => s.id !== anchor.id) };
}
