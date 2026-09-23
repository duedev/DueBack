import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrintPdf,
  printPdfFileName,
  receiptStrip,
  layoutPrintPages,
  textWidth,
  fitText,
  type PrintImage,
  type StripLine,
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

// Real OCR lines from the owner's Chevron-app e-receipt (page 4 of 37 in
// their uploaded extraction.json; boxes rounded to four places), normalized
// to the Letter page they were read on.
const CHEVRON_P4: StripLine[] = [
  { text: "Receipt — 2025-07-02", bbox: { x: 0.0662, y: 0.0265, w: 0.2129, h: 0.0115 } },
  { text: "3304 14th Street", bbox: { x: 0.0667, y: 0.0535, w: 0.1388, h: 0.0073 } },
  { text: "Riverside CA 92501", bbox: { x: 0.1632, y: 0.0673, w: 0.1567, h: 0.0073 } },
  { text: "3304 14TH Street", bbox: { x: 0.0667, y: 0.0950, w: 0.1388, h: 0.0073 } },
  { text: "Bubble Machine Car w", bbox: { x: 0.0662, y: 0.1088, w: 0.1756, h: 0.0073 } },
  { text: "00096984", bbox: { x: 0.0672, y: 0.1227, w: 0.0672, h: 0.0073 } },
  { text: "Riverside, CA", bbox: { x: 0.0662, y: 0.1365, w: 0.1139, h: 0.0088 } },
  { text: "07/02/2025 287159880", bbox: { x: 0.0672, y: 0.1496, w: 0.1731, h: 0.0088 } },
  { text: "05:20:52 PM", bbox: { x: 0.0672, y: 0.1642, w: 0.0950, h: 0.0073 } },
  { text: "XXXXXKXXXXXXX2007", bbox: { x: 0.0657, y: 0.1923, w: 0.1393, h: 0.0073 } },
  { text: "P97", bbox: { x: 0.0667, y: 0.2062, w: 0.0234, h: 0.0073 } },
  { text: "INVOICE 0000005539", bbox: { x: 0.0672, y: 0.2200, w: 0.1557, h: 0.0073 } },
  { text: "AUTH 149746", bbox: { x: 0.0652, y: 0.2338, w: 0.0960, h: 0.0073 } },
  { text: "SITE ID: chevron0009-6984", bbox: { x: 0.0667, y: 0.2615, w: 0.2174, h: 0.0073 } },
  { text: "AmericanExpress Credit", bbox: { x: 0.0652, y: 0.2754, w: 0.1930, h: 0.0096 } },
  { text: "PUMP# 6", bbox: { x: 0.0667, y: 0.3031, w: 0.0597, h: 0.0085 } },
  { text: "UNLEAD REG 1.7.:9396", bbox: { x: 0.0662, y: 0.3312, w: 0.1751, h: 0.0073 } },
  { text: "PRICE/GAL $5.999", bbox: { x: 0.0667, y: 0.3442, w: 0.1741, h: 0.0092 } },
  { text: "FUEL TOTAL $ 107.62", bbox: { x: 0.0667, y: 0.3723, w: 0.1736, h: 0.0088 } },
  { text: "TOTAL = $ 107.62", bbox: { x: 0.0930, y: 0.4138, w: 0.1473, h: 0.0088 } },
  { text: "CREDIT $ 107.62", bbox: { x: 0.0662, y: 0.4419, w: 0.1741, h: 0.0088 } },
  { text: "THANK YOU FOR BEING A REWARDS MEMBER", bbox: { x: 0.0662, y: 0.4842, w: 0.3169, h: 0.0069 } },
  { text: "Customer Copy", bbox: { x: 0.0925, y: 0.5538, w: 0.1139, h: 0.0092 } },
];
const P4_VENDOR = { x: 0.0662, y: 0.1088, w: 0.1756, h: 0.0073 };
const P4_DATE = { x: 0.1726, y: 0.0265, w: 0.1065, h: 0.0115 };
const P4_AMOUNT = { x: 0.1905, y: 0.3727, w: 0.0498, h: 0.0073 };

test("receiptStrip runs past the amount through the tender lines printed under it", () => {
  const strip = receiptStrip([P4_VENDOR, P4_DATE, P4_AMOUNT], { lines: CHEVRON_P4 })!;
  assert.ok(strip, "a strip");
  assert.ok(strip.y0 < 0.0265, `header kept (y0 ${strip.y0})`);
  // "TOTAL = $ 107.62" and "CREDIT $ 107.62" were cut off the owner's packet.
  assert.ok(strip.y1 >= 0.4419 + 0.0088, `CREDIT line kept (y1 ${strip.y1})`);
  // The walk ends at the first non-tender stretch: no footer.
  assert.ok(strip.y1 < 0.5538, `Customer Copy footer not chased (y1 ${strip.y1})`);
  // Without stored lines the bottom still gets more room than the top.
  const bare = receiptStrip([P4_VENDOR, P4_DATE, P4_AMOUNT])!;
  assert.ok(bare.y1 - (P4_AMOUNT.y + P4_AMOUNT.h) > 0.045, `fallback pad (y1 ${bare.y1})`);
});

test("the tender walk steps over unlabeled lines but stops at a real gap", () => {
  const amount = { x: 0.5, y: 0.3, w: 0.2, h: 0.01 };
  const line = (text: string, y: number): StripLine => ({ text, bbox: { x: 0.1, y, w: 0.6, h: 0.01 } });
  const lines = [
    line("FUEL SALE $82.93", 0.3),
    line("CRIND P97 $82.93", 0.317), // no tender word: steps over it
    line("MOBILE", 0.337),
    line("AmericanExpress", 0.355),
    line("CREDIT", 0.375),
    line("TOTAL SAVINGS 3.20", 0.6), // 20+ line heights on: not chased
  ];
  const strip = receiptStrip([{ x: 0.1, y: 0.05, w: 0.3, h: 0.01 }, { x: 0.1, y: 0.1, w: 0.3, h: 0.01 }, amount], { lines })!;
  assert.ok(Math.abs(strip.y1 - (0.385 + 0.045)) < 1e-9, `ends under CREDIT (y1 ${strip.y1})`);
  // SUBTOTAL/CASHIER don't read as tender lines.
  const noise = receiptStrip(
    [{ x: 0.1, y: 0.05, w: 0.3, h: 0.01 }, { x: 0.1, y: 0.1, w: 0.3, h: 0.01 }, amount],
    { lines: [line("CASHIER: DANA", 0.33), line("SUBTOTAL REWARDS", 0.35)] },
  )!;
  assert.ok(Math.abs(noise.y1 - (0.31 + 0.045)) < 1e-9, `amount bottom + pad (y1 ${noise.y1})`);
});

test("receiptStrip takes its top edge only from fields above the amount", () => {
  // The vendor found in a footer ad ("Thank you for shopping Chevron")
  // below the amount: the top comes from the date above it, and the footer
  // box only extends the bottom so the vendor it names stays on paper.
  const date = { x: 0.1, y: 0.12, w: 0.3, h: 0.02 };
  const amount = { x: 0.5, y: 0.4, w: 0.2, h: 0.02 };
  const footerVendor = { x: 0.1, y: 0.7, w: 0.4, h: 0.02 };
  const strip = receiptStrip([footerVendor, date, amount])!;
  assert.ok(Math.abs(strip.y0 - (0.12 - 0.045)) < 1e-9, `top from the date (y0 ${strip.y0})`);
  assert.ok(strip.y1 >= 0.72, `bottom reaches the footer vendor (y1 ${strip.y1})`);
  // Nothing above the amount: the strip starts at the amount itself.
  const low = receiptStrip([footerVendor, { ...date, y: 0.6 }, amount])!;
  assert.ok(Math.abs(low.y0 - (0.4 - 0.045)) < 1e-9, `top from the amount (y0 ${low.y0})`);
  // The pre-options signature still takes a bare padding number.
  assert.ok(Math.abs(receiptStrip([footerVendor, date, amount], 0.01)!.y0 - 0.11) < 1e-9);
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
  assert.ok(pdf.includes("(receipt \\(page 1\\)) Tj"), "name, escaped, without its .jpg");
  assert.ok(!pdf.includes(".jpg"), "the extension says nothing on paper");
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
  assert.ok(pdf.includes("Ground Transportation #12  transport_06-25-26_"), "label first, then the (shortened) name");
  assert.ok(!pdf.includes("technologies_inc"), "the file name gave way, not the label");
  assert.match(pdf, /\.\.\.\) Tj/, "the cut is marked");
  const plain = ascii(buildPrintPdf([fakeImage({ name: "receipt (page 1).jpg" })], {}));
  assert.ok(plain.includes("receipt \\(page 1\\)"));
});

/** The caption strings drawn at 8 pt, unescaped, in stream order. */
function captions8(pdf: string): string[] {
  return [...pdf.matchAll(/BT \/F1 8 Tf [\d.]+ [\d.]+ Td \(((?:\\.|[^\\)])*)\) Tj ET/g)].map((m) =>
    m[1]!.replace(/\\(.)/g, "$1"),
  );
}

test("caption file names give way by MEASURED width, never past the amount", () => {
  // The owner's packet cut "fuel_05-09-25_bubble_machine_car_w.jpg" to
  // "…car_w.j..." on a 46-character budget, although it fits the cell.
  const owner = captions8(
    ascii(buildPrintPdf([fakeImage({ label: "Fuel #1", name: "fuel_05-09-25_bubble_machine_car_w.jpg", amount: "$110.57" })], {})),
  );
  assert.equal(owner[0], "Fuel #1  fuel_05-09-25_bubble_machine_car_w");
  // Narrow glyphs fit past the old character budget…
  const narrow = "fuel_07-24-25_illinois_little_filling_station_iii_lil_rill";
  assert.ok(narrow.length > 46);
  const n = captions8(ascii(buildPrintPdf([fakeImage({ label: "Fuel #3", name: `${narrow}.jpg` })], {})));
  assert.equal(n[0], `Fuel #3  ${narrow}`);
  // …and wide ones are cut before they reach the right-aligned amount.
  const wide = captions8(
    ascii(buildPrintPdf([fakeImage({ label: "Materials #14", name: "materials_01-02-26_WWW_MMM_WWW_MMM_WWW_MMM.jpg", amount: "$1,234.56" })], {})),
  );
  const [cap, amt] = wide as [string, string];
  assert.ok(cap.startsWith("Materials #14  materials_01-02-26_") && cap.endsWith("..."), cap);
  const cellW = (612 - 36 * 2 - 18) / 2;
  assert.ok(textWidth(cap, 8) + textWidth(amt, 8) <= cellW, `${textWidth(cap, 8)} + ${textWidth(amt, 8)} fits ${cellW}`);
});

test("fitText and textWidth use Helvetica's AFM widths", () => {
  assert.equal(textWidth("i", 1000), 222);
  assert.equal(textWidth("W", 1000), 944);
  assert.equal(textWidth("$110.57", 8), 28.912);
  assert.equal(fitText("short", 8, 100), "short");
  const cut = fitText("WWWWWWWWWW", 10, 50);
  assert.ok(cut.endsWith("...") && textWidth(cut, 10) <= 50, cut);
  assert.equal(fitText("anything", 8, 1), "", "not even the ellipsis fits");
});
