import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrintPdf,
  printPdfFileName,
  receiptStrip,
  layoutPrintPages,
  type PrintImage,
} from "../src/export/printPdf.ts";

// The print packet is a hand-built PDF (no library): these tests pin the
// structural contract a PDF reader relies on — header/trailer, object
// counts, page layout math — using fake JPEG bytes (DCTDecode streams are
// embedded verbatim, so their content is irrelevant to structure).

function fakeImage(over: Partial<PrintImage> = {}): PrintImage {
  return {
    jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]),
    width: 800,
    height: 2000,
    name: "Fuel_06-25-26_CityGas.jpg",
    amount: "$41.03",
    ...over,
  };
}

const ascii = (bytes: Uint8Array): string =>
  // Lossy decode is fine — the assertions only look at ASCII structure.
  Buffer.from(bytes).toString("latin1");

test("a packet has PDF header, trailer, and one image XObject per receipt", () => {
  const pdf = ascii(buildPrintPdf([fakeImage(), fakeImage(), fakeImage()], {}));
  assert.ok(pdf.startsWith("%PDF-1.4"));
  assert.ok(pdf.trimEnd().endsWith("%%EOF"));
  assert.equal(pdf.match(/\/Subtype \/Image/g)?.length, 3);
  assert.ok(pdf.includes("/Filter /DCTDecode"));
});

test("two receipts per page: 3 images → 2 pages, 5 → 3", () => {
  const three = ascii(buildPrintPdf([fakeImage(), fakeImage(), fakeImage()], {}));
  assert.equal(three.match(/\/Type \/Page\b/g)?.length, 2);
  assert.ok(three.includes("/Count 2"));
  const five = ascii(buildPrintPdf(Array.from({ length: 5 }, () => fakeImage()), {}));
  assert.equal(five.match(/\/Type \/Page\b/g)?.length, 3);
});

test("the employee header labels every page; the job is per image", () => {
  const pdf = ascii(
    buildPrintPdf(
      [
        fakeImage({ job: "Q1 Coffee Run #42" }),
        fakeImage({ job: "Warehouse Refit #77" }),
        fakeImage({ job: "Q1 Coffee Run #42" }),
      ],
      { employee: "Ada Lovelace" },
    ),
  );
  const headers = pdf.match(/Receipt packet - Ada Lovelace/g);
  assert.equal(headers?.length, 2); // one per page
  assert.ok(pdf.includes("Page 1 of 2"));
  assert.ok(pdf.includes("Page 2 of 2"));
  // Each receipt carries its own job caption — a batch can span jobs.
  assert.equal(pdf.match(/Q1 Coffee Run #42/g)?.length, 2);
  assert.ok(pdf.includes("Warehouse Refit #77"));
});

test("receiptStrip needs all three boxes and spans them with padding", () => {
  const v = { x: 0.1, y: 0.05, w: 0.5, h: 0.03 };
  const d = { x: 0.1, y: 0.4, w: 0.3, h: 0.03 };
  const a = { x: 0.5, y: 0.55, w: 0.3, h: 0.03 };
  const strip = receiptStrip([v, d, a]);
  assert.ok(strip);
  assert.ok(strip!.y0 < 0.05 && strip!.y0 >= 0);
  assert.ok(strip!.y1 > 0.58 && strip!.y1 <= 1);
  // A missing box means no crop (a partial strip could cut the needed line)…
  assert.equal(receiptStrip([v, undefined, a]), null);
  // …and a strip that spans the whole receipt anyway is pointless.
  assert.equal(
    receiptStrip([{ x: 0, y: 0.01, w: 1, h: 0.05 }, d, { x: 0, y: 0.93, w: 1, h: 0.05 }]),
    null,
  );
});

test("short field strips pack several to a page", () => {
  // 800×600 strips scale to ~196pt tall — three per column, six per page.
  const strips = Array.from({ length: 6 }, () => ({ width: 800, height: 600 }));
  const placements = layoutPrintPages(strips);
  assert.equal(placements[placements.length - 1]!.page, 0, "six strips fit one page");
  // Tall full receipts still get a column each.
  const talls = Array.from({ length: 3 }, () => ({ width: 800, height: 2000 }));
  const tp = layoutPrintPages(talls);
  assert.equal(tp[tp.length - 1]!.page, 1, "three tall receipts need two pages");
});

test("captions carry the file name and amount; delimiters are escaped", () => {
  const pdf = ascii(
    buildPrintPdf([fakeImage({ name: "receipt (page 1).jpg", amount: "$7.61" })], {}),
  );
  assert.ok(pdf.includes("receipt \\(page 1\\).jpg"));
  assert.ok(pdf.includes("$7.61"));
});

test("pages are Letter-size and the media box never changes", () => {
  const pdf = ascii(buildPrintPdf([fakeImage()], {}));
  assert.ok(pdf.includes("/MediaBox [0 0 612 792]"));
});

/** Every xref entry must land exactly on its "N 0 obj". */
function assertXrefValid(pdf: string): void {
  const xrefAt = Number(pdf.match(/startxref\n(\d+)\n/)![1]);
  assert.equal(pdf.slice(xrefAt, xrefAt + 4), "xref");
  const entries = pdf.slice(xrefAt).match(/^\d{10} 00000 n /gm)!;
  entries.forEach((e, i) => {
    const off = Number(e.slice(0, 10));
    assert.match(pdf.slice(off, off + 12), new RegExp(`^${i + 1} 0 obj`), `object ${i + 1}`);
  });
}

test("xref offsets point at their objects", () => {
  assertXrefValid(ascii(buildPrintPdf([fakeImage(), fakeImage()], { employee: "A" })));
});

test("every stream /Length is its exact byte count, even with non-ASCII text and a JPEG full of delimiters", () => {
  // xref offsets come from the bytes actually pushed, so they can't catch a
  // /Length that disagrees with the stream — a reader would then mis-parse
  // every object after it.
  const jpeg = new Uint8Array([0xff, 0xd8, 0x0a, 0x0d, 0x0a, 0x65, 0x6e, 0x64, 0xff, 0xd9]);
  const pdf = ascii(
    buildPrintPdf([fakeImage({ jpeg, name: "Café_Zoë.jpg", job: "Übung #1" })], { employee: "Renée" }),
  );
  const streams = [...pdf.matchAll(/\/Length (\d+) >>\nstream\n/g)];
  assert.equal(streams.length, 2, "one content stream + one image");
  for (const m of streams) {
    const start = m.index! + m[0].length;
    const n = Number(m[1]);
    assert.equal(pdf.slice(start + n, start + n + 11), "\nendstream\n", `stream at ${m.index}`);
  }
  const img = streams[1]!;
  const imgStart = img.index! + img[0].length;
  assert.equal(pdf.slice(imgStart, imgStart + jpeg.length), ascii(jpeg), "JPEG bytes embedded verbatim");
  assertXrefValid(pdf);
});

test("an empty batch still yields one valid page", () => {
  const pdf = ascii(buildPrintPdf([], {}));
  assert.equal(pdf.match(/\/Type \/Page\b/g)?.length, 1);
  assert.ok(pdf.includes("/Count 1"));
  assert.match(pdf, /\/XObject <<\s*>>/);
  assertXrefValid(pdf);
});

test("printPdfFileName is sanitized and date-stamped", () => {
  const d = new Date(2026, 7, 26);
  assert.equal(printPdfFileName("Ada Lovelace", d), "Receipt_Packet_Ada_Lovelace_20260826.pdf");
  assert.equal(printPdfFileName(undefined, d), "Receipt_Packet_Employee_20260826.pdf");
});

test("accented names render as Latin-1 under WinAnsi instead of '?'", () => {
  const pdf = ascii(buildPrintPdf([fakeImage({ job: "Señor's job #42" })], { employee: "José García" }));
  assert.ok(pdf.includes("Receipt packet - Jos\xe9 Garc\xeda"), "header keeps é/í");
  assert.ok(pdf.includes("Se\xf1or's job #42"), "caption keeps ñ");
  // A decomposed e + combining acute collapses to the one Latin-1 byte.
  const nfd = ascii(buildPrintPdf([fakeImage()], { employee: "Jose\u0301" }));
  assert.ok(nfd.includes("Receipt packet - Jos\xe9"));
  // Past Latin-1 still degrades — but to one "?", not mojibake.
  const far = ascii(buildPrintPdf([fakeImage()], { employee: "Łukasz" }));
  assert.ok(far.includes("Receipt packet - ?ukasz"));
  assert.equal(printPdfFileName("José García", new Date(2026, 7, 26)), "Receipt_Packet_Jose_Garcia_20260826.pdf");
});

test("the section label precedes the file name in the caption and is never truncated", () => {
  const pdf = ascii(
    buildPrintPdf(
      [fakeImage({ label: "Ground Transportation #12", name: "transport_06-25-26_uber_technologies_inc.jpg" })],
      {},
    ),
  );
  assert.ok(pdf.includes("Ground Transportation #12  transport_"), "label first, then the (shortened) name");
  assert.ok(!pdf.includes("uber_technologies_inc.jpg"), "the file name gave way, not the label");
  const plain = ascii(buildPrintPdf([fakeImage({ name: "receipt (page 1).jpg" })], {}));
  assert.ok(plain.includes("receipt \\(page 1\\).jpg"));
});
