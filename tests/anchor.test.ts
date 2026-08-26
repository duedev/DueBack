import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import {
  imageAnchor,
  anchorSizePx,
  sheetGeometry,
  colUnitsToPx,
  rowPtToPx,
  EMU_PER_PX,
} from "../src/export/anchor.ts";
import { readZip } from "../src/pipeline/unzip.ts";
import { IMG_DISPLAY_W, IMG_INSET_PX, IMG_ROW_PT } from "../src/export/workbook.ts";

// The image sheets' real geometry: column A 55 units wide, the rest 14.7,
// image carrier rows 14pt.
const IMAGE_SHEET = sheetGeometry({
  colWidthUnits: (col) => (col === 0 ? 55 : 14.7),
  rowHeightPt: () => 14,
});

const COL_A_PX = colUnitsToPx(55); // 385
const ROW_PX = rowPtToPx(14); // 19 — Excel snaps rows to whole pixels

// ── the px math ──────────────────────────────────────────────────────────────

test("an image inside one column anchors to that column's real pixels", () => {
  const { tl, br } = imageAnchor(
    { col: 0, row: 4, x: 4, y: 4, w: 254, h: 760 },
    IMAGE_SHEET,
  );
  assert.deepEqual(
    { col: tl.nativeCol, row: tl.nativeRow },
    { col: 0, row: 4 },
    "top-left stays in the origin cell",
  );
  assert.equal(tl.nativeColOff, 4 * EMU_PER_PX);
  assert.equal(br.nativeCol, 0, "4 + 254 px still fits inside a 385 px column");
  assert.equal(br.nativeColOff, 258 * EMU_PER_PX);
  const size = anchorSizePx({ tl, br }, IMAGE_SHEET);
  assert.equal(Math.round(size.w), 254);
  assert.equal(Math.round(size.h), 760);
});

test("the rendered size is the requested size, whatever the cells do", () => {
  // Every aspect ratio a receipt photo can have, round-tripped.
  for (const [w, h] of [
    [380, 507],
    [254, 760],
    [760, 240],
    [1, 1],
  ] as [number, number][]) {
    const range = imageAnchor({ col: 0, row: 2, x: 4, y: 4, w, h }, IMAGE_SHEET);
    const size = anchorSizePx(range, IMAGE_SHEET);
    assert.ok(Math.abs(size.w - w) < 1, `width ${size.w} ≈ ${w}`);
    assert.ok(Math.abs(size.h - h) < 1, `height ${size.h} ≈ ${h}`);
  }
});

test("a wide image spills into the following columns", () => {
  const { br } = imageAnchor(
    { col: 0, row: 0, x: 0, y: 0, w: COL_A_PX + 30, h: 20 },
    IMAGE_SHEET,
  );
  assert.equal(br.nativeCol, 1, "past column A → the right edge sits in B");
  assert.equal(br.nativeColOff, 30 * EMU_PER_PX);
});

test("rows are walked with their real heights", () => {
  const { br } = imageAnchor(
    { col: 0, row: 0, x: 0, y: 0, w: 10, h: ROW_PX * 3 },
    IMAGE_SHEET,
  );
  assert.equal(br.nativeRow, 3);
  assert.equal(br.nativeRowOff, 0);
});

test("unsized cells fall back to Excel's defaults", () => {
  const bare = sheetGeometry({ colWidthUnits: () => undefined, rowHeightPt: () => undefined });
  assert.equal(bare.colPx(0), 64); // 9.140625 stored units — Excel's default
  assert.equal(bare.rowPx(0), 20); // 15pt
});

test("column widths follow ECMA-376, not the characters→px form", () => {
  // The two canonical Excel data points for Calibri 11.
  assert.equal(colUnitsToPx(9.140625), 64);
  assert.equal(colUnitsToPx(10.7109375), 75);
  // The image sheet's own columns.
  assert.equal(colUnitsToPx(55), 385);
  assert.equal(colUnitsToPx(14.7), 103);
  assert.equal(colUnitsToPx(0), 0); // hidden
});

test("row heights snap to whole pixels, as Excel lays them out", () => {
  assert.equal(rowPtToPx(14), 19); // Excel's dialog: "14 (19 pixels)"
  assert.equal(rowPtToPx(15), 20);
  assert.equal(rowPtToPx(22), 29);
});

test("a hidden (zero-width) column ends the walk instead of spinning", () => {
  const collapsed = sheetGeometry({ colWidthUnits: () => 0, rowHeightPt: () => 0 });
  const { br } = imageAnchor({ col: 0, row: 0, x: 0, y: 0, w: 100, h: 100 }, collapsed);
  assert.equal(br.nativeCol, 0);
  assert.equal(br.nativeColOff, 100 * EMU_PER_PX);
});

// ── through ExcelJS, to the bytes and back ───────────────────────────────────

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function sheetWithImage(w: number, h: number): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Fuel");
  ws.getColumn(1).width = 55;
  for (let c = 2; c <= 6; c++) ws.getColumn(c).width = 14.7;
  for (let r = 1; r <= 60; r++) ws.getRow(r).height = 14;
  const id = wb.addImage({ buffer: PNG_1PX as unknown as ExcelJS.Buffer, extension: "png" });
  ws.addImage(id, {
    ...imageAnchor({ col: 0, row: 4, x: 4, y: 4, w, h }, IMAGE_SHEET),
    editAs: "oneCell",
  } as Parameters<typeof ws.addImage>[1]);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

test("ExcelJS writes the native offsets through unchanged", async () => {
  const buf = await sheetWithImage(254, 760);
  const { entries } = await readZip(buf);
  const drawing = entries.find((e) => /^xl\/drawings\/drawing\d+\.xml$/.test(e.path));
  assert.ok(drawing, "the workbook has a drawing part");
  const xml = new TextDecoder().decode(drawing.data);
  assert.match(xml, /<xdr:twoCellAnchor/, "twoCellAnchor — Quick Look skips oneCellAnchor");
  assert.equal(
    (xml.match(/<xdr:oneCellAnchor/g) ?? []).length,
    0,
    "not one oneCellAnchor — iOS Quick Look and Numbers drop those entirely",
  );
  assert.equal((xml.match(/<xdr:twoCellAnchor/g) ?? []).length, 1);
  assert.equal(
    (xml.match(/<xdr:to>/g) ?? []).length,
    1,
    "every anchor carries a bottom-right corner",
  );
  // 4 px inset and 4 + 254 px right edge, in EMU, inside column A.
  assert.match(xml, new RegExp(`<xdr:from><xdr:col>0</xdr:col><xdr:colOff>${4 * EMU_PER_PX}</xdr:colOff>`));
  assert.match(xml, new RegExp(`<xdr:to><xdr:col>0</xdr:col><xdr:colOff>${258 * EMU_PER_PX}</xdr:colOff>`));
});

test("a built workbook read back renders at the requested size", async () => {
  const buf = await sheetWithImage(254, 760);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet("Fuel")!;
  const [image] = ws.getImages();
  assert.ok(image, "the image survives the round-trip");
  const size = anchorSizePx(
    image.range as unknown as Parameters<typeof anchorSizePx>[0],
    IMAGE_SHEET,
  );
  assert.ok(Math.abs(size.w - 254) < 1, `width ${size.w} ≈ 254`);
  assert.ok(Math.abs(size.h - 760) < 1, `height ${size.h} ≈ 760`);
});

test("regression witness: the old fractional anchor squished the width", async () => {
  // What the code used to pass: a fraction of column A. ExcelJS scales that
  // by width×10000 EMU (550,000 for a 55-unit column) instead of the column's
  // real 385 px × 9525 = 3,667,125 EMU — 6.7× narrower.
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Fuel");
  ws.getColumn(1).width = 55;
  for (let r = 1; r <= 60; r++) ws.getRow(r).height = 14;
  const id = wb.addImage({ buffer: PNG_1PX as unknown as ExcelJS.Buffer, extension: "png" });
  ws.addImage(id, {
    tl: { col: 0.05, row: 4.05 },
    br: { col: 0.05 + 254 / COL_A_PX, row: 4.05 + (760 * 0.75) / 14 },
    editAs: "oneCell",
  } as Parameters<typeof ws.addImage>[1]);
  const [written] = ws.getImages();
  const size = anchorSizePx(
    written!.range as unknown as Parameters<typeof anchorSizePx>[0],
    IMAGE_SHEET,
  );
  assert.ok(size.w < 45, `old math rendered ~${Math.round(size.w)} px wide, not 254`);
  assert.ok(size.h > 700, "…while the height was about right — hence 'skinny'");
});

// ── invariants the layout quietly depends on ────────────────────────────────

test("a receipt image fits inside column A", () => {
  // With 385 px of column and a 4 px inset there is exactly 1 px to spare —
  // worth an assertion, since IMG_DISPLAY_W and the column width are set
  // hundreds of lines apart.
  assert.ok(
    IMG_INSET_PX + IMG_DISPLAY_W <= colUnitsToPx(55),
    `${IMG_INSET_PX} + ${IMG_DISPLAY_W} ≤ ${colUnitsToPx(55)}`,
  );
});

test("carrier rows are a whole number of pixels", () => {
  // A row height that isn't a multiple of 0.75pt renders taller than the
  // model thinks (Excel snaps to whole px), and a tall receipt drifts.
  for (const pt of [IMG_ROW_PT, 15]) {
    assert.equal(rowPtToPx(pt), (pt * 4) / 3, `${pt}pt is a whole pixel`);
  }
});

test("the rendered size holds up against an independent geometry model", () => {
  // Every round-trip above measures with the same sheetGeometry it built the
  // anchor from, so a wrong column formula would agree with itself. This one
  // re-derives the px from the ECMA-376 formula written out by hand.
  const byHand = {
    colPx: (c: number) => Math.trunc(((256 * (c === 0 ? 55 : 14.7) + 18) / 256) * 7),
    rowPx: () => 19,
  };
  const range = imageAnchor({ col: 0, row: 4, x: 4, y: 0, w: 380, h: 570 }, IMAGE_SHEET);
  const size = anchorSizePx(range, byHand);
  assert.equal(Math.round(size.w), 380);
  assert.equal(Math.round(size.h), 570);
});
