import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrintPdf, printPdfFileName, type PrintImage } from "../src/export/printPdf.ts";

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

test("the employee/job header labels every page", () => {
  const pdf = ascii(
    buildPrintPdf([fakeImage(), fakeImage(), fakeImage()], {
      employee: "Ada Lovelace",
      jobName: "Q1 Coffee Run",
      jobNumber: "42",
    }),
  );
  const headers = pdf.match(/Receipt packet - Ada Lovelace - Q1 Coffee Run - #42/g);
  assert.equal(headers?.length, 2); // one per page
  assert.ok(pdf.includes("Page 1 of 2"));
  assert.ok(pdf.includes("Page 2 of 2"));
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
