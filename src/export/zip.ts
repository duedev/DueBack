// Minimal ZIP writer for the "download all receipt images" export. Entries
// are DEFLATE-compressed via the platform CompressionStream (Chrome/Safari/
// Firefox/Node 18+); when unavailable they're stored uncompressed — still a
// valid archive. No dependency: the format needed here is ~100 lines.

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = (CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream })
    .CompressionStream;
  if (!CS) return null;
  try {
    const stream = new Blob([data as BlobPart])
      .stream()
      .pipeThrough(new CS("deflate-raw"));
    const out = await new Response(stream).arrayBuffer();
    return new Uint8Array(out);
  } catch {
    return null;
  }
}

function dosDateTime(d: Date): { date: number; time: number } {
  return {
    date:
      (((d.getFullYear() - 1980) & 0x7f) << 9) |
      ((d.getMonth() + 1) << 5) |
      d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

/** Build a ZIP archive from the given entries. */
export async function buildZip(entries: ZipEntry[]): Promise<Blob> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const { date, time } = dosDateTime(new Date());

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const deflated = await deflateRaw(entry.data);
    // Only take the deflated form when it actually shrinks (JPEGs often don't).
    const useDeflate = deflated !== null && deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, payload.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true); // made by
    cen.setUint16(6, 20, true); // needed
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, method, true);
    cen.setUint16(12, time, true);
    cen.setUint16(14, date, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, payload.length, true);
    cen.setUint32(24, entry.data.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true); // local header offset

    parts.push(new Uint8Array(local.buffer), nameBytes, payload);
    central.push(new Uint8Array(cen.buffer), nameBytes);
    offset += 30 + nameBytes.length + payload.length;
  }

  const centralSize = central.reduce((s, p) => s + p.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);

  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)] as BlobPart[], {
    type: "application/zip",
  });
}
