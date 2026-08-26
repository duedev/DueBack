// Where an embedded image actually lands on a sheet.
//
// OOXML anchors a drawing by *cell plus offset*: `<xdr:from>` and `<xdr:to>`
// each carry a column/row index and an EMU offset into that cell. ExcelJS
// will accept a fractional `{col, row}` instead and convert it for you — but
// its Anchor model scales the fraction by `width × 10000` EMU per column
// (lib/doc/anchor.js), while a rendered column is `(width·7 + 5) px × 9525`
// EMU. For column A at width 55 that is 550,000 vs 3,714,750 EMU: an image
// sized as a fraction of the column came out **6.75× too narrow** — the
// "skinny receipts" report. Rows escaped it because the fraction there is a
// row *count*, so only the last partial row was off.
//
// So the geometry is computed here, in real pixels, and handed to ExcelJS as
// native EMU offsets, which its CellPositionXform writes through verbatim.
// Pure math (no ExcelJS, no DOM) so it is Node-tested.

/** English Metric Units per pixel at 96 dpi — the OOXML drawing unit. */
export const EMU_PER_PX = 9525;
/** EMU per point (72 pt/in). Equals EMU_PER_PX × 4/3, so px and pt agree. */
export const EMU_PER_PT = 12700;

/** Max digit width of the normal font (Calibri 11 at 96 dpi), in px — the
 *  unit Excel measures column widths in. */
const MAX_DIGIT_WIDTH = 7;

/** Excel's default column width and row height. 9.140625 stored units is the
 *  64 px column Excel shows as "8.43 characters": the stored value already
 *  carries the 5 px of cell padding, folded in as 5/MDW. */
export const DEFAULT_COL_UNITS = 9.140625;
export const DEFAULT_ROW_PT = 15;

/**
 * Stored column-width units → px, per ECMA-376 §18.3.1.13:
 *   `px = Truncate(((256·width + Truncate(128/MDW)) / 256) · MDW)`
 *
 * ExcelJS writes `column.width` straight into `<col width="…">`, so the
 * number this repo sets IS the stored value — padding included. Adding the
 * 5 px again (the *characters*→px form of the formula) overstated every
 * column by 5 px. Width 0 is a hidden column: no pixels.
 */
export function colUnitsToPx(units: number): number {
  if (!(units > 0)) return 0;
  return Math.trunc(
    ((256 * units + Math.trunc(128 / MAX_DIGIT_WIDTH)) / 256) * MAX_DIGIT_WIDTH,
  );
}

/** Row height in points → px at 96 dpi, snapped to whole pixels the way Excel
 *  lays rows out (its row dialog shows 14pt as "19 pixels", not 18.67). The
 *  anchor walk has to agree with the grid it is measuring, or an image
 *  spanning 41 carrier rows drifts ~2% in height. */
export function rowPtToPx(pt: number): number {
  return Math.round((pt * 4) / 3);
}

/** One corner of a drawing anchor, in the shape ExcelJS writes unchanged. */
export interface NativeAnchor {
  nativeCol: number;
  nativeColOff: number;
  nativeRow: number;
  nativeRowOff: number;
}

/** A sheet's rendered cell sizes, in px, addressed 0-based. */
export interface SheetGeometry {
  colPx: (col: number) => number;
  rowPx: (row: number) => number;
}

/** Where an image sits: an origin cell, a px offset into it, and a px size. */
export interface ImagePlacement {
  /** 0-based origin column/row. */
  col: number;
  row: number;
  /** px inset from that cell's top-left corner. */
  x: number;
  y: number;
  /** Rendered size in px. */
  w: number;
  h: number;
}

/** Sizes that fall back to Excel's defaults for cells with none set. */
export function sheetGeometry(src: {
  colWidthUnits: (col: number) => number | undefined;
  rowHeightPt: (row: number) => number | undefined;
}): SheetGeometry {
  return {
    colPx: (col) => colUnitsToPx(src.colWidthUnits(col) ?? DEFAULT_COL_UNITS),
    rowPx: (row) => rowPtToPx(src.rowHeightPt(row) ?? DEFAULT_ROW_PT),
  };
}

// A drawing that ran off the end of a sheet would walk forever; Excel's own
// grid stops at 16,384 columns / 1,048,576 rows, and no receipt image is
// anywhere near either.
const MAX_WALK = 16384;

/** Advance `distancePx` from the start of cell `start`, returning the cell the
 *  edge lands in and what is left over inside it. A zero/negative cell size
 *  (a hidden column) ends the walk rather than spinning. */
function walkCells(
  start: number,
  distancePx: number,
  sizePx: (index: number) => number,
): { index: number; offsetPx: number } {
  let index = Math.max(0, Math.trunc(start));
  let remaining = Math.max(0, distancePx);
  for (let step = 0; step < MAX_WALK; step++) {
    const size = sizePx(index);
    // The epsilon keeps an edge that lands exactly on a boundary (a whole
    // number of carrier rows) on the boundary, instead of a hair inside the
    // previous cell — same rendering, tidier anchors.
    if (!(size > 0) || remaining + 1e-6 < size) break;
    remaining -= size;
    index++;
  }
  return { index, offsetPx: Math.max(0, remaining) };
}

const emu = (px: number): number => Math.max(0, Math.round(px * EMU_PER_PX));

/**
 * The two corners of a twoCellAnchor for an image of `w × h` px.
 *
 * twoCellAnchor is required, not preferred: iOS Quick Look and Apple Numbers
 * skip oneCellAnchor (tl + ext) images entirely. Both corners are derived
 * from the same px math, so Excel renders the image at exactly `w × h`.
 */
export function imageAnchor(
  p: ImagePlacement,
  geom: SheetGeometry,
): { tl: NativeAnchor; br: NativeAnchor } {
  const left = walkCells(p.col, p.x, geom.colPx);
  const top = walkCells(p.row, p.y, geom.rowPx);
  // The bottom-right corner walks from the SAME origin cell, so the columns
  // and rows it crosses are measured once, consistently.
  const right = walkCells(p.col, p.x + Math.max(0, p.w), geom.colPx);
  const bottom = walkCells(p.row, p.y + Math.max(0, p.h), geom.rowPx);
  return {
    tl: {
      nativeCol: left.index,
      nativeColOff: emu(left.offsetPx),
      nativeRow: top.index,
      nativeRowOff: emu(top.offsetPx),
    },
    br: {
      nativeCol: right.index,
      nativeColOff: emu(right.offsetPx),
      nativeRow: bottom.index,
      nativeRowOff: emu(bottom.offsetPx),
    },
  };
}

/** Rendered px size of an anchor pair — the inverse of `imageAnchor`, for
 *  tests and for reading a built workbook back. */
export function anchorSizePx(
  range: { tl: NativeAnchor; br: NativeAnchor },
  geom: SheetGeometry,
): { w: number; h: number } {
  const span = (
    from: number,
    fromOff: number,
    to: number,
    toOff: number,
    size: (i: number) => number,
  ): number => {
    let px = toOff / EMU_PER_PX - fromOff / EMU_PER_PX;
    for (let i = from; i < to; i++) px += size(i);
    return px;
  };
  return {
    w: span(
      range.tl.nativeCol,
      range.tl.nativeColOff,
      range.br.nativeCol,
      range.br.nativeColOff,
      geom.colPx,
    ),
    h: span(
      range.tl.nativeRow,
      range.tl.nativeRowOff,
      range.br.nativeRow,
      range.br.nativeRowOff,
      geom.rowPx,
    ),
  };
}
