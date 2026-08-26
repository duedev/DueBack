// ZIP intake. A user's receipts often arrive as one archive — "here's the
// folder from my phone" — with the receipts buried in nested subfolders
// (Tesla's charging exports look exactly like this: a year folder, a month
// folder, one PDF/PNG per session). This module reads such an archive in the
// browser and hands back every usable entry, folder structure flattened.
//
// Counterpart to `export/zip.ts` (the writer), and dependency-free for the
// same reason: the central-directory format needed here is ~150 lines, and
// DEFLATE comes from the platform's DecompressionStream (Chrome/Safari/
// Firefox/Node 18+). No DOM is used, so this is Node-testable.

export interface ZipReadEntry {
  /** Full path as stored in the archive, e.g. "2026/03/session_12.pdf". */
  path: string;
  data: Uint8Array;
}

export interface ZipSkip {
  path: string;
  reason: string;
}

export interface ZipReadResult {
  entries: ZipReadEntry[];
  /** Entries deliberately not returned (unsupported type, too large, …). */
  skipped: ZipSkip[];
  /** True when the entry cap stopped the read before the directory ended. */
  truncated: boolean;
}

export interface ZipReadOptions {
  /** Keep only entries whose name ends with one of these (lowercased, with
   *  the dot). Omit to keep every file entry. */
  extensions?: readonly string[];
  /** Refuse a single entry larger than this many uncompressed bytes. */
  maxEntryBytes?: number;
  /** Stop after this many kept entries. */
  maxEntries?: number;
  /** Stop extracting once the kept entries total this many inflated bytes —
   *  the aggregate zip-bomb guard on top of the per-entry cap. */
  maxTotalBytes?: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * Entries a receipt app should never surface: directory markers, the junk
 * macOS puts in every archive it makes, and hidden dotfiles.
 *
 * `__MACOSX/._name.jpg` AppleDouble stubs are the sharp one — they carry the
 * *same extension* as the real receipt, so an extension-only filter would
 * queue a duplicate, unreadable "receipt" for every genuine image.
 */
export function isArchiveJunk(path: string): boolean {
  if (path.endsWith("/")) return true; // directory marker
  const segments = path.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (!base) return true;
  if (segments.some((s) => s === "__MACOSX")) return true;
  if (base.startsWith("._")) return true; // AppleDouble resource fork
  if (base.startsWith(".")) return true; // .DS_Store, .gitignore, …
  if (base.toLowerCase() === "thumbs.db") return true;
  return false;
}

function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  const m = base.toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : "";
}

/** Inflate with a hard output cap. The directory's uncompressed sizes are
 *  forgeable, so the honest count happens here, while streaming: the read is
 *  cancelled — and null returned — the moment the output passes `maxBytes`,
 *  before a lying entry (a zip bomb) can allocate its full expansion. */
async function inflateRaw(
  data: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const DS = (
    globalThis as { DecompressionStream?: typeof DecompressionStream }
  ).DecompressionStream;
  if (!DS) throw new Error("DEFLATE unsupported in this browser");
  const reader = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DS("deflate-raw"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** Locate the End Of Central Directory record, scanning back over any ZIP
 *  comment (up to the format's 64 KB maximum). */
function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

interface Directory {
  offset: number;
  count: number;
}

/** Central-directory position/size, following the ZIP64 records when the
 *  classic 32-bit fields are saturated. */
function readDirectory(view: DataView, eocd: number): Directory {
  let count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const needs64 = count === 0xffff || offset === 0xffffffff;
  if (needs64 && eocd >= 20) {
    const loc = eocd - 20;
    if (view.getUint32(loc, true) === SIG_EOCD64_LOCATOR) {
      // The locator's 64-bit offset is safely inside Number range for any
      // archive a browser can hold in memory.
      const eocd64 = Number(view.getBigUint64(loc + 8, true));
      if (
        eocd64 >= 0 &&
        eocd64 + 56 <= view.byteLength &&
        view.getUint32(eocd64, true) === SIG_EOCD64
      ) {
        count = Number(view.getBigUint64(eocd64 + 32, true));
        offset = Number(view.getBigUint64(eocd64 + 48, true));
      }
    }
  }
  return { offset, count };
}

/** ZIP64 extended-information extra field: replaces any of the 32-bit
 *  size/offset fields that were written as the 0xffffffff sentinel. */
function applyZip64Extra(
  view: DataView,
  start: number,
  length: number,
  sizes: { uncompressed: number; compressed: number; localOffset: number },
): void {
  let p = start;
  const end = start + length;
  while (p + 4 <= end) {
    const id = view.getUint16(p, true);
    const size = view.getUint16(p + 2, true);
    let q = p + 4;
    if (id === 0x0001) {
      if (sizes.uncompressed === 0xffffffff && q + 8 <= end) {
        sizes.uncompressed = Number(view.getBigUint64(q, true));
        q += 8;
      }
      if (sizes.compressed === 0xffffffff && q + 8 <= end) {
        sizes.compressed = Number(view.getBigUint64(q, true));
        q += 8;
      }
      if (sizes.localOffset === 0xffffffff && q + 8 <= end) {
        sizes.localOffset = Number(view.getBigUint64(q, true));
      }
      return;
    }
    p += 4 + size;
  }
}

/**
 * Read a ZIP archive into its usable entries.
 *
 * Reads the central directory (not a scan of local headers) so entries that
 * were streamed with a data descriptor still report correct sizes. Nested
 * folders are preserved in `path`; the caller flattens them.
 *
 * @throws if the input is not a ZIP at all — the caller decides what to say.
 */
export async function readZip(
  input: ArrayBuffer | Uint8Array,
  options: ZipReadOptions = {},
): Promise<ZipReadResult> {
  const bytes =
    input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error("not a ZIP archive (no directory found)");

  const { offset: dirOffset, count } = readDirectory(view, eocd);
  const extensions = options.extensions?.map((e) => e.toLowerCase());
  const maxEntries = options.maxEntries ?? Infinity;
  const maxEntryBytes = options.maxEntryBytes ?? Infinity;
  const maxTotalBytes = options.maxTotalBytes ?? Infinity;

  const entries: ZipReadEntry[] = [];
  const skipped: ZipSkip[] = [];
  let totalBytes = 0;
  let truncated = false;
  const decoder = new TextDecoder("utf-8");

  let p = dirOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== SIG_CENTRAL) break;
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const sizes = {
      uncompressed: view.getUint32(p + 24, true),
      compressed: view.getUint32(p + 20, true),
      localOffset: view.getUint32(p + 42, true),
    };
    const nameStart = p + 46;
    const path = decoder.decode(bytes.subarray(nameStart, nameStart + nameLen));
    applyZip64Extra(view, nameStart + nameLen, extraLen, sizes);
    p = nameStart + nameLen + extraLen + commentLen;

    if (isArchiveJunk(path)) continue;
    if (extensions && !extensions.includes(extensionOf(path))) {
      skipped.push({ path, reason: "unsupported type" });
      continue;
    }
    // The declared size is forgeable — this is only the cheap fast path; the
    // honest check is the streamed count during inflation below.
    if (sizes.uncompressed > maxEntryBytes) {
      skipped.push({ path, reason: "too large" });
      continue;
    }
    if (totalBytes >= maxTotalBytes) {
      skipped.push({ path, reason: "archive limit reached" });
      continue;
    }
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    // Bit 0 = encrypted. There is no password to ask for here.
    if (flags & 0x1) {
      skipped.push({ path, reason: "password protected" });
      continue;
    }
    if (method !== 0 && method !== 8) {
      skipped.push({ path, reason: `unsupported compression (${method})` });
      continue;
    }

    // The local header's own name/extra lengths locate the payload; the
    // central copy of `extraLen` routinely differs from the local one.
    const lh = sizes.localOffset;
    if (lh + 30 > bytes.length || view.getUint32(lh, true) !== SIG_LOCAL) {
      skipped.push({ path, reason: "corrupt entry" });
      continue;
    }
    const dataStart =
      lh + 30 + view.getUint16(lh + 26, true) + view.getUint16(lh + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + sizes.compressed);
    if (raw.length < sizes.compressed) {
      skipped.push({ path, reason: "truncated entry" });
      continue;
    }
    try {
      // The entry's real budget is whichever cap is nearer: its own, or what
      // remains of the archive's aggregate allowance.
      const budget = Math.min(maxEntryBytes, maxTotalBytes - totalBytes);
      const data = method === 8 ? await inflateRaw(raw, budget) : raw.slice();
      if (data === null || data.length > budget) {
        skipped.push({
          path,
          reason: budget < maxEntryBytes ? "archive limit reached" : "too large",
        });
        continue;
      }
      if (data.length === 0) {
        skipped.push({ path, reason: "empty file" });
        continue;
      }
      totalBytes += data.length;
      entries.push({ path, data });
    } catch {
      skipped.push({ path, reason: "unreadable entry" });
    }
  }

  return { entries, skipped, truncated };
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

/** Best-guess MIME for an archive entry — ZIP stores no content type. */
export function mimeForPath(path: string): string {
  return MIME_BY_EXT[extensionOf(path)] ?? "application/octet-stream";
}

/**
 * "trip.zip" + "2026/03/session_12.pdf" → the display name shown on the card.
 *
 * The path inside the archive is kept (minus the redundant leading folder
 * that archivers add when zipping a folder) because it is often the only
 * thing distinguishing "receipt.pdf" in twelve different month folders.
 */
export function archiveEntryName(
  archiveName: string,
  path: string,
): { fileName: string; originalFileName: string } {
  const base = path.split("/").pop() || "receipt";
  const folders = path.split("/").slice(0, -1).filter(Boolean);
  const inner = folders.length ? `${folders.join("/")}/${base}` : base;
  return {
    fileName: base,
    originalFileName: `${archiveName} › ${inner}`,
  };
}
