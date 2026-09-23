import type { Receipt } from "../types.ts";
import { exportableReceipts } from "./order.ts";
import { employeeFilePart } from "../util/rename.ts";
import { formatMoney, safeAmount } from "../util/money.ts";

// What one report-bar click hands the browser: exactly ONE file.
//
// Browsers let a page start one download per user gesture. Chrome/Edge's
// download limiter lets the first through and holds any further download
// until the next click or key press behind "This site is trying to download
// multiple files" (Allow / Block — and a Block sticks, silently dropping
// every later second file); Firefox's download-spam guard blocks it the
// same way. The limiter counts interactions, not time, so a delay doesn't
// help. So Generate downloads one file — the workbook, or (opted in) one
// ZIP holding it and the print packet — and the packet has its own button:
// a fresh click is a fresh gesture. Pure and ExcelJS-free (like order.ts),
// so the report bar loads it with the main bundle.

export const PACKET_ZIP_KEY = "report.packetZip";
/** Retired toggles ("Print packet" default-on, "Bundle into one ZIP"), read
 *  only to migrate — never written or deleted. */
export const LEGACY_PRINT_PACKET_KEY = "report.printPacket";
export const LEGACY_BUNDLE_ZIP_KEY = "report.bundleZip";

/** Whether Generate zips the print packet in with the workbook. An explicit
 *  choice wins; before one exists, only someone who had BOTH retired toggles
 *  on (packet default-on + bundle) was already getting one archive with
 *  both — they keep it. Everyone else gets the workbook alone. */
export function resolvePacketZip(s: {
  packetZip?: unknown;
  printPacket?: unknown;
  bundleZip?: unknown;
}): boolean {
  if (typeof s.packetZip === "boolean") return s.packetZip;
  return s.bundleZip === true && s.printPacket !== false;
}

/** "Report_<Employee>_<yyyymmdd>.zip" — local date, like the workbook's and
 *  the packet's stamps (UTC drifted a day in the evening). */
export function reportZipName(employee: string | undefined, now = new Date()): string {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return `Report_${employeeFilePart(employee)}_${stamp}.zip`;
}

/** Receipts the report would carry while still flagged as a possible
 *  duplicate: exportable (so their amount IS in the TOTAL), carrying a
 *  "duplicate" flag, and not approved. Approval is the human's answer to
 *  the flag (the review modal clears flags on Approve), so an approved
 *  receipt never counts. Report order, so the first one listed is the
 *  first one the Summary shows. */
export function unresolvedDuplicates(receipts: readonly Receipt[]): Receipt[] {
  return exportableReceipts(receipts).filter(
    (r) => !r.approved && r.flags.some((f) => f.code === "duplicate"),
  );
}

/** The Generate confirm's line for them: "1 possible duplicate is still in
 *  the total: fuel_02-11-26_chevron.jpg — $80.29". Lists up to `max` by
 *  file name and amount, then "and N more". */
export function duplicatesSentence(dups: readonly Receipt[], max = 3): string {
  if (dups.length === 0) return "";
  const head =
    dups.length === 1
      ? "1 possible duplicate is still in the total"
      : `${dups.length} possible duplicates are still in the total`;
  const listed = dups
    .slice(0, max)
    .map((r) => `${r.fileName} — ${formatMoney(safeAmount(r.amount.value))}`);
  const more = dups.length > max ? `, and ${dups.length - max} more` : "";
  return `${head}: ${listed.join("; ")}${more}.`;
}
