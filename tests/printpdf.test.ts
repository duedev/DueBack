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
      { employee: "Ada Lovelace", jobName: "Q1 Coffee Run", jobNumber: "42" },
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

test("xref offsets point at their objects", () => {
  const bytes = buildPrintPdf([fakeImage(), fakeImage()], { employee: "A" });
  const pdf = ascii(bytes);
  const xrefAt = Number(pdf.match(/startxref\n(\d+)\n/)![1]);
  assert.equal(pdf.slice(xrefAt, xrefAt + 4), "xref");
  // Every in-use entry must land exactly on "N 0 obj".
  const entries = pdf.slice(xrefAt).match(/^\d{10} 00000 n /gm)!;
  entries.forEach((e, i) => {
    const off = Number(e.slice(0, 10));
    assert.match(pdf.slice(off, off + 12), new RegExp(`^${i + 1} 0 obj`), `object ${i + 1}`);
  });
});

test("printPdfFileName is sanitized and date-stamped", () => {
  const d = new Date(2026, 7, 26);
  assert.equal(printPdfFileName("Ada Lovelace", d), "Receipt_Packet_Ada_Lovelace_20260826.pdf");
  assert.equal(printPdfFileName(undefined, d), "Receipt_Packet_Employee_20260826.pdf");
});
