// Export-time image compression (§8). Originals/cleaned images stay sharp for
// OCR; only here, when building the workbook, do we shrink them to keep the
// file small. Runs on a <canvas> in the browser.

export interface Thumb {
  buffer: ArrayBuffer;
  width: number;
  height: number;
  ext: "jpeg";
}

export async function thumbnail(
  blob: Blob,
  maxEdge = 520,
  quality = 0.72,
  fit: "edge" | "width" = "edge",
): Promise<Thumb> {
  const bmp = await createImageBitmap(blob);
  // "edge" caps the long edge (downloads, previews). "width" caps the width
  // only: the workbook embeds display every receipt at a fixed column width,
  // and a portrait receipt capped by its (long) height encodes far fewer
  // horizontal pixels than the column shows — blurry at any zoom.
  const limit = fit === "width" ? bmp.width : Math.max(bmp.width, bmp.height);
  const scale = Math.min(1, maxEdge / limit);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("thumbnail encode failed"))),
      "image/jpeg",
      quality,
    ),
  );
  return { buffer: await out.arrayBuffer(), width: w, height: h, ext: "jpeg" };
}

/** Like `thumbnail`, but cropped to a vertical band of the image first —
 *  the print packet's "field strip" (vendor→total plus padding), so a long
 *  receipt prints as just the part an office actually checks. `y0`/`y1` are
 *  normalized [0..1] against the source height. */
export async function stripThumbnail(
  blob: Blob,
  y0: number,
  y1: number,
  maxEdge = 520,
  quality = 0.72,
): Promise<Thumb> {
  const bmp = await createImageBitmap(blob);
  const sy = Math.max(0, Math.round(bmp.height * y0));
  const sh = Math.max(1, Math.round(bmp.height * (y1 - y0)));
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, sh));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, sy, bmp.width, sh, 0, 0, w, h);
  bmp.close();
  const out = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("strip encode failed"))),
      "image/jpeg",
      quality,
    ),
  );
  return { buffer: await out.arrayBuffer(), width: w, height: h, ext: "jpeg" };
}
