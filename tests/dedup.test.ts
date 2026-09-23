import { test } from "node:test";
import assert from "node:assert/strict";
import { semanticKey, findSemanticDuplicate, type DupRecord } from "../src/pipeline/dedup.ts";

function rec(p: Partial<DupRecord>): DupRecord {
  return { id: "x", label: "r.jpg", vendor: "Shell", date: "2026-05-01", amount: 45.2, ...p };
}

test("semanticKey normalizes vendor/date/amount and ignores zero amounts", () => {
  assert.equal(
    semanticKey({ vendor: " Shell ", date: "2026-05-01", amount: 45.2 }),
    "shell|2026-05-01|45.20",
  );
  // No usable amount → no key (can't dedup on it).
  assert.equal(semanticKey({ vendor: "Shell", date: "2026-05-01", amount: 0 }), null);
});

test("finds a same vendor+date+amount duplicate even with a different photo", () => {
  const current = rec({ id: "b", label: "back.jpg" });
  const others = [
    rec({ id: "a", label: "front.jpg" }), // same vendor/date/amount
    rec({ id: "c", label: "other.jpg", vendor: "Chevron", amount: 30 }),
  ];
  const dup = findSemanticDuplicate(current, others);
  assert.equal(dup?.label, "front.jpg");
});

test("does not match itself or genuinely different receipts", () => {
  const current = rec({ id: "a", label: "self.jpg" });
  assert.equal(findSemanticDuplicate(current, [current]), null);
  assert.equal(
    findSemanticDuplicate(current, [rec({ id: "z", amount: 99.99 })]),
    null,
  );
});

// ── Audit round (2026-09) ─────────────────────────────────────────────────────
import { semanticKey as semKey } from "../src/pipeline/dedup.ts";

test("a receipt missing its vendor or its date never keys as a duplicate", () => {
  assert.equal(semKey({ vendor: "", date: "", amount: 12 }), null);
  // Vendor-only matched every same-price fill-up on a trip; date-only
  // matched two different lunches. Both fields, or no key at all.
  assert.equal(semKey({ vendor: "Shop", date: "", amount: 12 }), null);
  assert.equal(semKey({ vendor: "", date: "2026-03-14", amount: 12 }), null);
  assert.equal(semKey({ vendor: "Shop", date: "2026-03-14", amount: 12 }), "shop|2026-03-14|12.00");
});

// ── Duplicate pairs: identity, codes, links (2026-09) ───────────────────────
import {
  vendorIdentity,
  duplicateFlag,
  resolveDuplicateFlag,
  findDuplicatePair,
  duplicatePairs,
  duplicateReason,
  flagsWithoutDuplicate,
  retargetDuplicateFlags,
  planDuplicateDelete,
  transactionCodes,
  sharedTransactionCode,
  type DupCandidate,
} from "../src/pipeline/dedup.ts";
import {
  appFeb11,
  scanFeb11,
  appMar02,
  scanMar02,
  scanMar02Other,
  printInvoice,
  printSlip,
  siteAug07,
  siteApr09,
  type OwnerReceipt,
} from "./fixtures/ownerDuplicates.ts";

/** A duplicateFlag `read` from a stored receipt (the pipeline passes the
 *  fresh extraction and its OCR lines). */
const readOf = (r: OwnerReceipt, over: Partial<{ vendor: string; date: string; amount: number }> = {}) => ({
  id: r.id,
  vendor: r.vendor.value,
  date: r.date.value,
  amount: r.amount.value,
  lines: r.ocrLines,
  ...over,
});

function cand(p: Partial<DupCandidate> & { id: string }): DupCandidate {
  return {
    fileName: `${p.id}.jpg`,
    vendor: { value: "Shell" },
    date: { value: "2026-05-01" },
    amount: { value: 45.2 },
    flags: [],
    ...p,
  };
}

test("vendorIdentity keys the merchant, not its spelling", () => {
  for (const v of ["Chevron", "Chevron Station Inc.", "Chevron Stations Inc", "Palm Spring Chevron", " CHEVRON "]) {
    assert.equal(vendorIdentity(v), "chevron", v);
  }
  const same = (a: string, b: string) => assert.equal(vendorIdentity(a), vendorIdentity(b), `${a} ≡ ${b}`);
  same("Costco Wholesale", "Costco");
  same("Home Depot", "The Home Depot");
  same("PIP Printing, Inc.", "pip printing");
  same("Joe's Diner #12", "JOE'S DINER");
  // The AI assist keeps the accent OCR drops, and drops the apostrophe OCR keeps.
  same("Café Rouge", "Cafe Rouge");
  same("Bob's", "Bobs");
  assert.equal(vendorIdentity("PIP Printing, Inc."), "pip printing");
  assert.notEqual(vendorIdentity("Shell"), vendorIdentity("Chevron"));
  assert.equal(vendorIdentity(""), "");
  assert.equal(vendorIdentity("   "), "");
});

test("the owner's missed 03-02 pair keys alike: the app says Chevron, the slip Chevron Station Inc.", () => {
  const app = semanticKey({ vendor: appMar02.vendor.value, date: "2026-03-02", amount: 83.44 });
  assert.ok(app);
  assert.equal(semanticKey({ vendor: scanMar02.vendor.value, date: "2026-03-02", amount: 83.44 }), app);
  // Both identity fields are still required, and brands still differ.
  assert.equal(semanticKey({ vendor: "Chevron", date: "", amount: 83.44 }), null);
  assert.notEqual(
    semanticKey({ vendor: "Shell", date: "2026-03-02", amount: 83.44 }),
    semanticKey({ vendor: "Chevron", date: "2026-03-02", amount: 83.44 }),
  );
});

test("duplicateFlag: a hash twin names the twin by id and quotes its upload name", () => {
  const twin = { id: "a", fileName: "fuel_02-11-26_chevron.jpg", originalFileName: "app.pdf (page 27 of 37)" };
  assert.deepEqual(duplicateFlag(readOf(scanFeb11), twin, []), {
    code: "duplicate",
    severity: "warn",
    message: 'Looks identical to "app.pdf (page 27 of 37)".',
    ref: "a",
  });
  // A twin stored before originalFileName existed quotes its fileName.
  assert.equal(
    duplicateFlag(readOf(scanFeb11), { id: "a", fileName: "fuel_02-11-26_chevron.jpg" }, [])?.message,
    'Looks identical to "fuel_02-11-26_chevron.jpg".',
  );
});

test("duplicateFlag: the real 03-02 pair is caught on vendor identity + date + amount", () => {
  const flag = duplicateFlag(readOf(scanMar02), undefined, [appMar02, scanMar02, scanMar02Other]);
  assert.deepEqual(flag, {
    code: "duplicate",
    severity: "warn",
    // The upload's name: both copies are RENAMED fuel_03-02-26_chevron…jpg.
    message: `Same vendor, date and amount as "${appMar02.originalFileName}" — possible duplicate.`,
    ref: appMar02.id,
  });
  // Never itself (the batch listing includes the receipt being read)…
  assert.equal(duplicateFlag(readOf(appMar02), undefined, [appMar02]), null);
  // …and a different brand on the same day and amount is not a twin.
  assert.equal(
    duplicateFlag({ id: "x", vendor: "Shell", date: "2026-03-02", amount: 83.44 }, undefined, [appMar02]),
    null,
  );
});

test("transactionCodes reads labeled codes off the owner's real lines — never a site id", () => {
  assert.deepEqual(transactionCodes(appFeb11.ocrLines), [
    { code: "0000014524", kind: "invoice" },
    { code: "08683D", kind: "approval" },
  ]);
  // The scan's invoice lost its last digit; its approval code survived.
  assert.deepEqual(transactionCodes(scanFeb11.ocrLines), [
    { code: "000001452", kind: "invoice" },
    { code: "08683D", kind: "approval" },
  ]);
  // "REF#: 00000003" is the terminal's running counter, not a transaction code.
  assert.deepEqual(transactionCodes(printSlip.ocrLines), [{ code: "05439D", kind: "approval" }]);
  assert.deepEqual(transactionCodes(printInvoice.ocrLines), [{ code: "054300", kind: "reference" }]);
  for (const r of [siteAug07, siteApr09]) {
    assert.ok(!transactionCodes(r.ocrLines).some((c) => /CHEVRON/.test(c.code)), r.originalFileName);
  }
  const codes = (t: string) => transactionCodes([{ text: t }]).map((c) => c.code);
  assert.deepEqual(codes("AUTH. CODE: 104740"), ["104740"]);
  assert.deepEqual(codes("Authorization # 7Q2K91"), ["7Q2K91"]);
  assert.deepEqual(codes("INV# 88412"), ["88412"]);
  assert.deepEqual(codes("TRANSACTION # 77120"), ["77120"]);
  assert.deepEqual(codes("Transaction Date 02/11/2026"), []);
  assert.deepEqual(codes("INVOICE TOTAL 123.45"), []);
  assert.deepEqual(codes("REF 12345.67"), []); // money, not a code
  assert.deepEqual(codes("REFUND 123456"), []);
  assert.deepEqual(codes("APPROVED 123456"), []);
  // A place id recurs on every receipt from that station: the whole line is out.
  assert.deepEqual(codes("MERCHANT ID: 4450012 REF# 0098812"), []);
  assert.deepEqual(codes("STORE 0784 TERM 12 TRAN# 55120"), []);
});

test("tier 3: the owner's print-shop slip and its invoice pair on amount + approval code", () => {
  // Vendors ("PIP PRINTING RIVERSIDE" / "PrintMyStuff") and dates (2025-12-12 /
  // 2012-12-12, an AI misread) BOTH differ — the vendor/date tier can't see it.
  assert.notEqual(vendorIdentity(printSlip.vendor.value), vendorIdentity(printInvoice.vendor.value));
  const flag = duplicateFlag(readOf(printSlip), undefined, [printInvoice, printSlip]);
  assert.deepEqual(flag, {
    code: "duplicate",
    severity: "warn",
    message: `Same amount and card approval code (05439D) as "${printInvoice.originalFileName}" — possible duplicate.`,
    ref: printInvoice.id,
  });
  // Read in the other order, the invoice's misread "054300" still quotes the
  // approval code as the card slip printed it.
  const back = duplicateFlag(readOf(printInvoice), undefined, [printSlip]);
  assert.equal(back?.ref, printSlip.id);
  assert.match(back?.message ?? "", /card approval code \(05439D\)/);
  // No code tier without the amount to the cent.
  assert.equal(duplicateFlag(readOf(printSlip, { amount: 28.05 }), undefined, [printInvoice]), null);
});

test("tier 3: the real fuel pairs share their AUTH code even when vendor and date read differently", () => {
  assert.deepEqual(
    sharedTransactionCode(transactionCodes(scanFeb11.ocrLines), transactionCodes(appFeb11.ocrLines)),
    { code: "08683D", kind: "approval" },
  );
  // The garbled header the scan's rules read, and no date: only the code ties them.
  const flag = duplicateFlag(readOf(scanFeb11, { vendor: "C & Wor ysg", date: "" }), undefined, [appFeb11]);
  assert.equal(flag?.ref, appFeb11.id);
  assert.equal(
    flag?.message,
    `Same amount and card approval code (08683D) as "${appFeb11.originalFileName}" — possible duplicate.`,
  );
  // 03-02: invoice AND auth shared — the approval code is the one reported.
  assert.deepEqual(
    sharedTransactionCode(transactionCodes(scanMar02.ocrLines), transactionCodes(appMar02.ocrLines)),
    { code: "104740", kind: "approval" },
  );
  assert.equal(duplicateFlag(readOf(scanMar02, { date: "2026-08-02" }), undefined, [appMar02])?.ref, appMar02.id);
});

test("tier 3 negatives: a different AUTH, a shared site id, sequential numbers", () => {
  // Same station, same day, $94.14 vs $83.44 and a different AUTH.
  assert.equal(
    sharedTransactionCode(transactionCodes(scanMar02Other.ocrLines), transactionCodes(appMar02.ocrLines)),
    null,
  );
  assert.equal(duplicateFlag(readOf(scanMar02Other), undefined, [appMar02, scanMar02]), null);
  assert.equal(
    duplicateFlag(readOf(scanMar02Other, { amount: 83.44, date: "" }), undefined, [appMar02, scanMar02]),
    null,
  );
  // Two fill-ups at one station share only its SITE ID — even at one amount.
  assert.equal(duplicateFlag(readOf(siteApr09, { amount: 82.06 }), undefined, [siteAug07]), null);
  const merchantLine = { text: "MERCHANT ID: 4450012 REF# 0098812" };
  const withLine = (r: OwnerReceipt, text: { text: string }) => ({ ...r, ocrLines: [...r.ocrLines, text] });
  assert.equal(
    duplicateFlag(
      { ...readOf(siteApr09, { amount: 82.06 }), lines: withLine(siteApr09, merchantLine).ocrLines },
      undefined,
      [withLine(siteAug07, merchantLine)],
    ),
    null,
  );
  // Control: the same REF on a line of its own IS a shared code.
  const refLine = { text: "REF# 0098812" };
  assert.equal(
    duplicateFlag(
      { ...readOf(siteApr09, { amount: 82.06 }), lines: withLine(siteApr09, refLine).ocrLines },
      undefined,
      [withLine(siteAug07, refLine)],
    )?.ref,
    siteAug07.id,
  );
  // Same-kind neighbours never fuzzy-match: invoice numbers are sequential and
  // some issuers' approval codes are counters.
  const c = (code: string, kind: "approval" | "invoice" | "reference") => [{ code, kind }];
  assert.equal(sharedTransactionCode(c("0000014524", "invoice"), c("0000014525", "invoice")), null);
  assert.equal(sharedTransactionCode(c("01503R", "approval"), c("01508R", "approval")), null);
  assert.equal(sharedTransactionCode(c("054301", "reference"), c("054300", "reference")), null);
  // Cross-kind (approval vs the invoice's "ref"), one glyph + one edit apart: a misread.
  assert.deepEqual(sharedTransactionCode(c("05439D", "approval"), c("054300", "reference")), {
    code: "05439D",
    kind: "approval",
  });
  // …but not two edits after folding.
  assert.equal(sharedTransactionCode(c("05439D", "approval"), c("054311", "reference")), null);
});

test("resolveDuplicateFlag: a ref points at one receipt, never a stand-in", () => {
  const a = cand({ id: "a" });
  const b = cand({ id: "b" });
  const holder = cand({ id: "h" });
  const flag = { message: 'Same vendor, date and amount as "a.jpg" — possible duplicate.', ref: "a" };
  assert.equal(resolveDuplicateFlag(holder, flag, [holder, a, b])?.id, "a");
  // The twin was deleted: b still matches on vendor/date/amount, but the flag
  // was about a — it resolves to nothing.
  assert.equal(resolveDuplicateFlag(holder, flag, [holder, b]), null);
});

test("resolveDuplicateFlag: legacy flags (no ref) resolve without ever landing on the holder", () => {
  // The owner's flagged scan quotes "fuel_02-11-26_chevron.jpg" — its OWN
  // renamed name as well as its twin's.
  const legacy = scanFeb11.flags[0]!;
  assert.equal(legacy.code, "duplicate");
  assert.equal(scanFeb11.fileName, appFeb11.fileName);
  const batch = [scanFeb11, appFeb11, appMar02, scanMar02];
  assert.equal(resolveDuplicateFlag(scanFeb11, legacy, batch)?.id, appFeb11.id);

  // "Looks identical" → the same-imageHash sibling first.
  const h1 = cand({ id: "h1", imageHash: "abc", fileName: "x.jpg" });
  const h2 = cand({ id: "h2", imageHash: "abc", fileName: "y.jpg", vendor: { value: "Other" } });
  assert.equal(resolveDuplicateFlag(h1, { message: 'Looks identical to "gone.jpg".' }, [h1, h2])?.id, "h2");

  // The quoted name no longer exists (the twin was renamed by an edit): a
  // fresh vendor/date/amount match.
  const s1 = cand({ id: "s1" });
  const s2 = cand({ id: "s2", fileName: "renamed.jpg" });
  assert.equal(resolveDuplicateFlag(s1, { message: 'Same vendor, date and amount as "old.jpg" — possible duplicate.' }, [s1, s2])?.id, "s2");

  // Names collide between NON-duplicates: the owner's batch holds two
  // fuel_03-02-26_chevron_station_inc.jpg ($94.14 and $83.44). The one that
  // also matches on vendor/date/amount wins, whatever the list order.
  assert.equal(scanMar02.fileName, scanMar02Other.fileName);
  const quoted = { message: `Same vendor, date and amount as "${scanMar02.fileName}" — possible duplicate.` };
  assert.equal(resolveDuplicateFlag(appMar02, quoted, [scanMar02Other, appMar02, scanMar02])?.id, scanMar02.id);

  // The quoted name may be an upload name (originalFileName).
  const o1 = cand({ id: "o1", amount: { value: 12 } });
  const o2 = cand({ id: "o2", originalFileName: "IMG_0042.HEIC", amount: { value: 99 } });
  assert.equal(resolveDuplicateFlag(o1, { message: 'Looks identical to "IMG_0042.HEIC".' }, [o1, o2])?.id, "o2");
  // A name alone decides only when exactly one sibling carries it.
  const o3 = cand({ id: "o3", originalFileName: "IMG_0042.HEIC", amount: { value: 77 } });
  assert.equal(resolveDuplicateFlag(o1, { message: 'Looks identical to "IMG_0042.HEIC".' }, [o1, o2, o3]), null);
});

test("findDuplicatePair: both copies see the pair; bystanders see nothing", () => {
  const batch = [appFeb11, scanFeb11, appMar02, scanMar02Other, printInvoice, printSlip];
  // The flagged copy (legacy flag, no ref) holds it…
  const fromScan = findDuplicatePair(scanFeb11, batch);
  assert.equal(fromScan?.peer.id, appFeb11.id);
  assert.equal(fromScan?.heldBy, "self");
  // …and the copy read FIRST, which carries no flag, still finds its twin.
  const fromApp = findDuplicatePair(appFeb11, batch);
  assert.equal(fromApp?.peer.id, scanFeb11.id);
  assert.equal(fromApp?.heldBy, "peer");
  // Not part of any pair.
  assert.equal(findDuplicatePair(appMar02, batch), null);
  assert.equal(findDuplicatePair(printSlip, batch), null);
  // A batch with no duplicate flags pairs nobody.
  const clean = batch.map((r) => ({ ...r, flags: r.flags.filter((f) => f.code !== "duplicate") }));
  for (const r of clean) assert.equal(findDuplicatePair(r, clean), null, r.originalFileName);
});

test("duplicatePairs lists every twin once — a third copy is not lost", () => {
  const a = cand({ id: "a" });
  const b = cand({ id: "b", flags: [{ code: "duplicate", message: "x", ref: "a" }] });
  const c = cand({ id: "c", flags: [{ code: "duplicate", message: "x", ref: "a" }] });
  const pairs = duplicatePairs(a, [a, b, c]);
  assert.deepEqual(pairs.map((p) => [p.peer.id, p.heldBy]), [["b", "peer"], ["c", "peer"]]);
  // A mutual pair (both hold a flag) is one entry.
  const m1 = cand({ id: "m1", flags: [{ code: "duplicate", message: "x", ref: "m2" }] });
  const m2 = cand({ id: "m2", flags: [{ code: "duplicate", message: "x", ref: "m1" }] });
  assert.deepEqual(duplicatePairs(m1, [m1, m2]).map((p) => [p.peer.id, p.heldBy]), [["m2", "self"]]);
});

test("duplicateReason explains the pair as it stands now", () => {
  assert.equal(
    duplicateReason(cand({ id: "a", imageHash: "h" }), cand({ id: "b", imageHash: "h" })),
    "The two images are identical.",
  );
  assert.equal(duplicateReason(scanMar02, appMar02), "Same vendor, date and amount.");
  assert.equal(duplicateReason(printSlip, printInvoice), "Same amount and card approval code (05439D).");
  assert.equal(
    duplicateReason(cand({ id: "a" }), cand({ id: "b", amount: { value: 1 } })),
    "Flagged as a possible duplicate when it was read.",
  );
});

test("flagsWithoutDuplicate removes only the warning about that twin (and dead ones)", () => {
  const stale = { code: "stale_date" as const, severity: "info" as const, message: "old" };
  const aboutB = { code: "duplicate" as const, severity: "warn" as const, message: "x", ref: "b" };
  const aboutC = { code: "duplicate" as const, severity: "warn" as const, message: "y", ref: "c" };
  const aboutGone = { code: "duplicate" as const, severity: "warn" as const, message: "z", ref: "gone" };
  const holder = { ...cand({ id: "a" }), flags: [aboutB, stale, aboutC, aboutGone] };
  const all = [holder, cand({ id: "b" }), cand({ id: "c" })];
  assert.deepEqual(flagsWithoutDuplicate(holder, "b", all), [stale, aboutC]);
  // null: only the ones whose twin is gone.
  assert.deepEqual(flagsWithoutDuplicate(holder, null, all), [aboutB, stale, aboutC]);
  // A legacy flag (no ref) resolving to the twin goes too.
  const legacy = scanFeb11.flags[0]!;
  assert.deepEqual(
    flagsWithoutDuplicate(scanFeb11, appFeb11.id, [scanFeb11, appFeb11]).map((f) => f.code),
    ["stale_date"],
  );
  assert.ok(flagsWithoutDuplicate(scanFeb11, "someone-else", [scanFeb11, appFeb11]).includes(legacy));
});

// ── Deleting one copy of three ───────────────────────────────────────────────

const dupFlag = (ref: string | undefined, message: string) => ({
  code: "duplicate" as const,
  severity: "warn" as const,
  message,
  ...(ref ? { ref } : {}),
});

test("three copies: deleting the original re-points the third copy at the survivor", () => {
  // A is the original; B and C were each flagged against A (the pipeline's
  // semantic tier returns the FIRST match in createdAt order).
  const a = { ...cand({ id: "a", originalFileName: "IMG_A.jpg" }), createdAt: 1 };
  const stale = { code: "stale_date" as const, severity: "info" as const, message: "old" };
  const b = {
    ...cand({ id: "b", originalFileName: "IMG_B.jpg" }),
    createdAt: 2,
    flags: [dupFlag("a", 'Same vendor, date and amount as "IMG_A.jpg" — possible duplicate.')],
  };
  const c = {
    ...cand({ id: "c", originalFileName: "IMG_C.jpg" }),
    createdAt: 3,
    flags: [stale, dupFlag("a", 'Same vendor, date and amount as "IMG_A.jpg" — possible duplicate.')],
  };
  const before = [a, b, c];

  // Review deletes A: the oldest survivor (B) anchors the rest.
  const plan = planDuplicateDelete(a, before);
  assert.equal(plan?.keeper.id, "b");
  assert.equal(plan?.onward, null);
  assert.deepEqual(plan?.others.map((o) => o.id), ["c"]);

  const cFlags = retargetDuplicateFlags(c, "a", b, before);
  assert.equal(cFlags.length, 2, "nothing added, nothing dropped");
  assert.equal(cFlags[0], stale, "an unrelated flag passes through as-is");
  assert.deepEqual(cFlags[1], dupFlag("b", 'Same vendor, date and amount as "IMG_B.jpg" — possible duplicate.'));
  // The keeper is never its own duplicate; the deleted copy is left alone.
  assert.deepEqual(retargetDuplicateFlags(b, "a", b, before), b.flags);
  assert.deepEqual(retargetDuplicateFlags(a, "a", b, before), []);

  // After the delete: B settles its warning about A, C's now names B, and
  // the pair is still a pair from both sides — not "no longer on this board".
  const bAfter = { ...b, flags: flagsWithoutDuplicate(b, "a", before) };
  const cAfter = { ...c, flags: cFlags };
  const after = [bAfter, cAfter];
  assert.deepEqual(duplicatePairs(cAfter, after).map((p) => [p.peer.id, p.heldBy]), [["b", "self"]]);
  assert.deepEqual(duplicatePairs(bAfter, after).map((p) => [p.peer.id, p.heldBy]), [["c", "peer"]]);
  // What the old code left behind: C's ref resolves to nothing.
  assert.equal(resolveDuplicateFlag(c, c.flags[1]!, after), null);
});

test("retargetDuplicateFlags: a legacy flag (no ref) resolves through the PRE-delete list", () => {
  // Stored before `ref` existed: the flag only quotes A's name. A and C are
  // byte-identical (same imageHash); B is the same purchase photographed
  // again, with a slightly different total read — no tier ties C to B.
  const a = cand({ id: "a", originalFileName: "IMG_A.jpg", imageHash: "h1" });
  const b = cand({ id: "b", originalFileName: "IMG_B.jpg", imageHash: "h2", amount: { value: 45.21 } });
  const c = {
    ...cand({ id: "c", originalFileName: "IMG_C.jpg", imageHash: "h1" }),
    flags: [dupFlag(undefined, 'Looks identical to "IMG_A.jpg".')],
  };
  const before = [a, b, c];
  const flags = retargetDuplicateFlags(c, "a", b, before);
  assert.deepEqual(flags, [
    dupFlag("b", 'Possible duplicate of "IMG_B.jpg" — both matched a copy that was deleted.'),
  ]);
  // Resolved against the list AFTER the delete, the legacy flag points at
  // nothing — there is no longer anything to tell it was about A.
  assert.equal(resolveDuplicateFlag(c, c.flags[0]!, [b, c]), null);
  assert.deepEqual(retargetDuplicateFlags(c, "a", b, [b, c]), c.flags);
  // A legacy flag about someone ELSE is not touched.
  const other = cand({ id: "o", originalFileName: "IMG_O.jpg", imageHash: "h9" });
  const d = { ...cand({ id: "d", imageHash: "h9" }), flags: [dupFlag(undefined, 'Looks identical to "IMG_O.jpg".')] };
  assert.equal(retargetDuplicateFlags(d, "a", b, [a, b, other, d])[0], d.flags[0]);
});

test("hash-tier chain: C was flagged against B, B against A — deleting B links C to A", () => {
  // Byte-identical copies: the hash cache hands back whichever twin it finds
  // first, so the flags can chain (C → B → A).
  const a = { ...cand({ id: "a", originalFileName: "IMG_A.jpg", imageHash: "h" }), createdAt: 1 };
  const b = {
    ...cand({ id: "b", originalFileName: "IMG_B.jpg", imageHash: "h" }),
    createdAt: 2,
    flags: [dupFlag("a", 'Looks identical to "IMG_A.jpg".')],
  };
  const c = {
    ...cand({ id: "c", originalFileName: "IMG_C.jpg", imageHash: "h" }),
    createdAt: 3,
    flags: [dupFlag("b", 'Looks identical to "IMG_B.jpg".')],
  };
  const before = [a, b, c];

  // Delete B from its own review ("Delete this one"): A, the oldest, keeps.
  const plan = planDuplicateDelete(b, before);
  assert.equal(plan?.keeper.id, "a");
  assert.equal(plan?.onward, null);
  assert.deepEqual(plan?.others.map((o) => o.id), ["c"]);
  assert.deepEqual(retargetDuplicateFlags(c, "b", a, before), [dupFlag("a", 'Looks identical to "IMG_A.jpg".')]);

  // Delete B from C's review ("Delete it" on the twin): C is the keeper the
  // human chose, and B was itself a copy of A — C's warning moves ONWARD to
  // A instead of being settled, so A and C are not both left unflagged.
  const fromC = planDuplicateDelete(b, before, c);
  assert.equal(fromC?.keeper.id, "c");
  assert.equal(fromC?.onward?.id, "a");
  assert.deepEqual(fromC?.others.map((o) => o.id), ["a"]);
  assert.deepEqual(retargetDuplicateFlags(c, "b", a, before), [dupFlag("a", 'Looks identical to "IMG_A.jpg".')]);
  // A holds no warning about B: re-pointing it is a no-op.
  assert.deepEqual(retargetDuplicateFlags(a, "b", c, before), []);
});

test("retargetDuplicateFlags folds into an existing warning about the keeper", () => {
  const a = cand({ id: "a" });
  const b = cand({ id: "b", originalFileName: "IMG_B.jpg" });
  const aboutB = dupFlag("b", 'Same vendor, date and amount as "IMG_B.jpg" — possible duplicate.');
  const c = { ...cand({ id: "c" }), flags: [aboutB, dupFlag("a", 'Same vendor, date and amount as "a.jpg" — possible duplicate.')] };
  // One pair, one warning — two identical messages would also collide as
  // keys in review's flag list.
  assert.deepEqual(retargetDuplicateFlags(c, "a", b, [a, b, c]), [aboutB]);
  // Nothing to plan for a receipt paired with nobody.
  assert.equal(planDuplicateDelete(cand({ id: "lone", amount: { value: 3 } }), [a, b]), null);
});

// ── Kept apart ("Keep both") ────────────────────────────────────────────────
// Clearing the warnings left no trace, so the next read or "Re-check this
// batch" paired the couple again. The verdict is stored on both rows
// (Receipt.notDuplicateOf) and dedup honours it on every tier.

import { keptApart } from "../src/pipeline/dedup.ts";

test("keptApart reads the verdict from either side", () => {
  assert.equal(keptApart({ id: "a", notDuplicateOf: ["b"] }, { id: "b" }), true);
  assert.equal(keptApart({ id: "a" }, { id: "b", notDuplicateOf: ["a"] }), true);
  assert.equal(keptApart({ id: "a", notDuplicateOf: ["c"] }, { id: "b" }), false);
  assert.equal(keptApart({ id: "a" }, { id: "b" }), false);
});

test("duplicateFlag never re-pairs a kept-apart couple — on any tier", () => {
  // Tier 1: a byte-identical twin the human kept apart is no twin.
  assert.equal(
    duplicateFlag({ ...readOf(scanFeb11), notDuplicateOf: [appFeb11.id] }, { id: appFeb11.id, fileName: "x.jpg" }, []),
    null,
  );
  // Tier 2: the real 03-02 pair, kept apart from either side.
  assert.equal(duplicateFlag({ ...readOf(scanMar02), notDuplicateOf: [appMar02.id] }, undefined, [appMar02]), null);
  assert.equal(
    duplicateFlag(readOf(scanMar02), undefined, [{ ...appMar02, notDuplicateOf: [scanMar02.id] }]),
    null,
  );
  // Tier 3: the PIP slip + invoice sharing an approval code.
  assert.ok(duplicateFlag(readOf(printSlip), undefined, [printInvoice]), "paired before the verdict");
  assert.equal(duplicateFlag({ ...readOf(printSlip), notDuplicateOf: [printInvoice.id] }, undefined, [printInvoice]), null);
  // A verdict about ONE twin doesn't hide another.
  const other = { ...appMar02, id: "another-copy" };
  assert.equal(
    duplicateFlag({ ...readOf(scanMar02), notDuplicateOf: [appMar02.id] }, undefined, [appMar02, other])?.ref,
    "another-copy",
  );
});
