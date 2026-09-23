import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  duplicatesSentence,
  reportZipName,
  resolvePacketZip,
  unresolvedDuplicates,
} from "../src/export/delivery.ts";
import type { Receipt, Category, Flag } from "../src/types.ts";

// One report-bar click hands the browser ONE file (a second download from the
// same click trips Chrome's "download multiple files" prompt / Firefox's
// download-spam block). The print packet has its own button, or rides in one
// ZIP with the workbook when the user opts in.

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
/** Source with comments removed, so a pin tests shipped code/copy only. */
const code = (p: string): string =>
  read(p)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("resolvePacketZip: an explicit choice wins over the retired toggles", () => {
  assert.equal(resolvePacketZip({ packetZip: false, printPacket: true, bundleZip: true }), false);
  assert.equal(resolvePacketZip({ packetZip: true, bundleZip: false }), true);
  assert.equal(resolvePacketZip({ packetZip: true, printPacket: false }), true);
});

test("resolvePacketZip: before a choice, only the old packet+bundle pair means a ZIP", () => {
  // Fresh install, and the old default (packet on, bundle off): the workbook
  // alone — the packet is one more click on its own button.
  assert.equal(resolvePacketZip({}), false);
  assert.equal(resolvePacketZip({ printPacket: true }), false);
  assert.equal(resolvePacketZip({ printPacket: true, bundleZip: false }), false);
  // Bundle on with the packet at its default (unset) or on: that user was
  // already getting ONE archive with both — they keep it.
  assert.equal(resolvePacketZip({ bundleZip: true }), true);
  assert.equal(resolvePacketZip({ bundleZip: true, printPacket: true }), true);
  // Bundle on but packet off: their ZIP held the workbook alone.
  assert.equal(resolvePacketZip({ bundleZip: true, printPacket: false }), false);
  // Junk from an older build never reads as a yes.
  assert.equal(resolvePacketZip({ packetZip: "true", bundleZip: "yes" }), false);
  assert.equal(resolvePacketZip({ packetZip: null, bundleZip: 1 }), false);
});

test("reportZipName: employee file part + LOCAL date stamp", () => {
  const lateEvening = new Date(2026, 8, 22, 23, 30); // UTC would already be the 23rd west of GMT
  assert.equal(reportZipName("Duane Hamilton", lateEvening), "Report_Duane_Hamilton_20260922.zip");
  assert.equal(reportZipName("José Álvarez", lateEvening), "Report_Jose_Alvarez_20260922.zip");
  assert.equal(reportZipName("", lateEvening), "Report_Employee_20260922.zip");
  assert.equal(reportZipName(undefined, lateEvening), "Report_Employee_20260922.zip");
});

// ── Generate asks before shipping a possible duplicate in the TOTAL ─────────

function receipt(f: {
  id: string;
  fileName: string;
  amount: number;
  category?: Category;
  date?: string;
  flags?: Flag[];
  approved?: boolean;
  status?: Receipt["status"];
}): Receipt {
  return {
    id: f.id,
    batchId: "b1",
    fileKey: "k",
    fileName: f.fileName,
    mimeType: "image/jpeg",
    status: f.status ?? (f.approved ? "done" : "needs_review"),
    vendor: { value: "Chevron", confidence: 0.9 },
    date: { value: f.date ?? "2026-02-11", confidence: 0.9 },
    amount: { value: f.amount, confidence: 0.92 },
    tax: { value: 0, confidence: 0.8 },
    currency: "USD",
    category: { value: f.category ?? "Fuel", confidence: 0.9 },
    confidence: 0.9,
    flags: f.flags ?? [],
    methodUsed: "rules",
    cost: 0,
    approved: f.approved ?? false,
    reviewRequired: !f.approved,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

// The owner's real report: the second Chevron fill-up came back flagged as a
// semantic duplicate of the first, was never reviewed, and its $80.29 still
// footed into the TOTAL.
const dupFlag: Flag = {
  code: "duplicate",
  severity: "warn",
  message: 'Same vendor, date and amount as "fuel_02-11-26_chevron.jpg" — possible duplicate.',
};

test("unresolvedDuplicates: exportable, flagged duplicate, not yet approved", () => {
  const original = receipt({ id: "a", fileName: "fuel_02-11-26_chevron.jpg", amount: 80.29, approved: true });
  const repeat = receipt({ id: "b", fileName: "fuel_02-11-26_chevron.jpg", amount: 80.29, flags: [dupFlag] });
  const otherFlag = receipt({
    id: "c",
    fileName: "fuel_02-12-26_shell.jpg",
    amount: 41.2,
    date: "2026-02-12",
    flags: [{ code: "vendor_unclear", severity: "warn", message: "?" }],
  });
  assert.deepEqual(
    unresolvedDuplicates([original, repeat, otherFlag]).map((r) => r.id),
    ["b"],
  );
  // Approval is the human's answer to the flag — it never counts again.
  assert.deepEqual(unresolvedDuplicates([{ ...repeat, approved: true }]), []);
  // Only what the report carries: a failed or zero-amount duplicate isn't
  // in the TOTAL, so there is nothing to warn about.
  assert.deepEqual(unresolvedDuplicates([{ ...repeat, status: "failed" }]), []);
  assert.deepEqual(unresolvedDuplicates([{ ...repeat, amount: { value: 0, confidence: 0 } }]), []);
});

test("unresolvedDuplicates lists in report order (the first is the one Review opens)", () => {
  const late = receipt({ id: "z", fileName: "late.jpg", amount: 9, date: "2026-03-01", flags: [dupFlag] });
  const early = receipt({ id: "y", fileName: "early.jpg", amount: 9, date: "2026-01-01", flags: [dupFlag] });
  assert.deepEqual(unresolvedDuplicates([late, early]).map((r) => r.id), ["y", "z"]);
});

test("duplicatesSentence names each duplicate with its amount", () => {
  const one = receipt({ id: "b", fileName: "fuel_02-11-26_chevron.jpg", amount: 80.29, flags: [dupFlag] });
  assert.equal(
    duplicatesSentence([one]),
    "1 possible duplicate is still in the total: fuel_02-11-26_chevron.jpg — $80.29.",
  );
  assert.equal(duplicatesSentence([]), "");
  const many = ["a", "b", "c", "d", "e"].map((id, i) =>
    receipt({ id, fileName: `r${i + 1}.jpg`, amount: 10 + i, flags: [dupFlag] }),
  );
  assert.equal(
    duplicatesSentence(many),
    "5 possible duplicates are still in the total: r1.jpg — $10.00; r2.jpg — $11.00; r3.jpg — $12.00, and 2 more.",
  );
});

// Save to OneDrive ships the same workbook and TOTAL as Generate, so it goes
// through the same confirm. The button is hidden without
// VITE_ONEDRIVE_CLIENT_ID, so the e2e can't click it — pinned statically.
test("Save to OneDrive asks the same unresolved-duplicate / blank-details question as Generate", () => {
  const bar = code("src/ui/ExportBar.svelte");
  const body = (fn: string): string => {
    const m = new RegExp(`function ${fn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n  \\}`).exec(bar);
    assert.ok(m, `${fn} is defined`);
    return m[1]!;
  };
  // The button routes through the confirm, never straight to the upload.
  const button = /<button[^>]*onclick=\{([^}]*)\}[^>]*>\s*\{odSaving \? "Saving…" : "Save to OneDrive"\}/.exec(bar);
  assert.ok(button, "the Save to OneDrive button is found");
  assert.equal(button[1]!.trim(), "oneDriveClick");
  const click = body("oneDriveClick");
  assert.match(click, /blankFields\.length > 0 \|\| duplicates\.length > 0/);
  assert.match(click, /confirmFor = "onedrive";\s*confirmOpen = true;/);
  // Proceeding uploads synchronously inside the proceed click — no await
  // first, or OneDrive's sign-in popup opens outside the user gesture.
  const answer = body("answerConfirm");
  assert.match(answer, /confirmFor === "onedrive" \? saveToOneDrive\(\) : doGenerate\(\)/);
  assert.doesNotMatch(answer, /\bawait\b/);
  // saveToOneDrive() is called from those two places only.
  const calls = bar.match(/(?<!function )saveToOneDrive\(\)/g) ?? [];
  assert.equal(calls.length, 2, "only oneDriveClick and answerConfirm start an upload");
  assert.match(click, /void saveToOneDrive\(\)/);
  // The dialog names the action it guards; Generate keeps its wording.
  assert.match(bar, /confirmFor === "onedrive" \? "Save anyway" : "Generate anyway"/);
  assert.match(body("generate"), /confirmFor = "generate";\s*confirmOpen = true;/);
});

// ── the corrections log ships inside the tuning bundle only ─────────────────

test("the corrections log is exported only as corrections.json inside the tuning bundle", () => {
  // A behaviour pin, not a code shape: the archive keeps an entry by that
  // name however bundle.ts builds its entry list.
  assert.match(code("src/train/bundle.ts"), /["'`]corrections\.json["'`]/);
  const settings = code("src/ui/settings/ImprovementSection.svelte");
  assert.doesNotMatch(settings, /Corrections JSON|dueback_corrections|downloadCorrections/);
  // The count and Clear stay…
  assert.match(settings, /clearCorrections/);
  assert.match(settings, /correctionCount/);
  // …and the bundle is reachable on an empty board while the log has records.
  assert.match(settings, /app\.receipts\.length === 0 && correctionCount === 0/);
});

test("the landing never promises the packet downloads with the workbook", () => {
  for (const f of [
    "src/ui/Landing.svelte",
    "src/ui/landing/HowSection.svelte",
    "src/ui/landing/WorkbookSection.svelte",
  ]) {
    const copy = code(f).replace(/\s+/g, " ");
    assert.doesNotMatch(copy, /downloads? alongside|one click builds[^.]*print packet/i, f);
  }
});
