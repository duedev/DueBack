// End-to-end smoke test against the real production build, driven through a
// headless Chromium. Proves the browser-only paths the unit tests can't:
// the landing hero, IndexedDB storage, canvas image-prep, on-device Tesseract
// OCR, the board/review UI, and xlsx export. Run with: node tests/e2e.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { deflateRawSync, crc32 } from "node:zlib";
import sharp from "sharp";
import ExcelJS from "exceljs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5179;
const BASE = `http://localhost:${PORT}/`;

const log = (...a) => console.log("•", ...a);
let failures = 0;
// Uncaught exceptions and console errors used to be logged and ignored; a
// run that threw inside the pipeline could still print "all checks passed".
let pageErrors = 0;
function check(cond, msg) {
  if (cond) log("PASS:", msg);
  else {
    failures++;
    console.error("FAIL:", msg);
  }
}

async function launchBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    "/opt/pw-browsers/chromium",
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      await access(p);
      return chromium.launch({ executablePath: p, args: ["--no-sandbox"] });
    } catch {
      /* try next */
    }
  }
  return chromium.launch({ args: ["--no-sandbox"] });
}

async function waitForServer(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("preview server did not start");
}

async function makeReceiptPng() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="820">
    <rect width="640" height="820" fill="#ffffff"/>
    <g font-family="monospace" font-size="30" fill="#000000">
      <text x="60" y="80" font-size="38" font-weight="bold">BLUE BOTTLE COFFEE</text>
      <text x="60" y="130">123 Main Street</text>
      <text x="60" y="175">Date: 03/14/2026</text>
      <text x="60" y="260">Latte               4.50</text>
      <text x="60" y="305">Croissant           3.75</text>
      <text x="60" y="370">Subtotal            8.25</text>
      <text x="60" y="415">Sales Tax           0.74</text>
      <text x="60" y="475" font-size="34" font-weight="bold">TOTAL               8.99</text>
      <text x="60" y="560">Thank you!</text>
    </g>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// A realistic fuel receipt: 3-decimal gallons + per-gallon price (which a
// permissive money parser once read as $11,204) and a FUEL TOTAL line above
// the combined TOTAL (which first-total-wins once picked instead).
async function makeGasReceiptPng() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="620">
    <rect width="560" height="620" fill="#ffffff"/>
    <g font-family="monospace" font-size="24" fill="#000000">
      <text x="40" y="70" font-size="32" font-weight="bold">SHELL</text>
      <text x="40" y="115">1234 W MAIN ST</text>
      <text x="40" y="155">06/12/2026 14:03</text>
      <text x="40" y="200">PUMP 04 UNLEADED</text>
      <text x="40" y="250">GALLONS</text><text x="520" y="250" text-anchor="end">11.204</text>
      <text x="40" y="290">PRICE/GAL</text><text x="520" y="290" text-anchor="end">$3.499</text>
      <text x="40" y="340">FUEL TOTAL</text><text x="520" y="340" text-anchor="end">$30.00</text>
      <text x="40" y="380">CAR WASH</text><text x="520" y="380" text-anchor="end">$9.20</text>
      <text x="40" y="430" font-weight="bold">TOTAL</text><text x="520" y="430" text-anchor="end" font-weight="bold">$39.20</text>
      <text x="40" y="480">CREDIT</text><text x="520" y="480" text-anchor="end">$39.20</text>
      <text x="40" y="540">THANK YOU</text>
    </g>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// A tilted phone photo: the whole receipt rotated ~3.5° — Tesseract's line
// finder degrades quickly past ~1–2° of skew, so this gates the deskew pass.
async function makeSkewedReceiptPng() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="520">
    <rect width="560" height="520" fill="#ffffff"/>
    <g font-family="monospace" font-size="24" fill="#000000">
      <text x="40" y="70" font-size="32" font-weight="bold">ACME HARDWARE</text>
      <text x="40" y="115">450 OAK STREET</text>
      <text x="40" y="160">Date: 04/22/2026</text>
      <text x="40" y="215">Hammer</text><text x="520" y="215" text-anchor="end">24.99</text>
      <text x="40" y="255">Nails 5lb</text><text x="520" y="255" text-anchor="end">18.75</text>
      <text x="40" y="295">Tape measure</text><text x="520" y="295" text-anchor="end">12.49</text>
      <text x="40" y="345">Subtotal</text><text x="520" y="345" text-anchor="end">56.23</text>
      <text x="40" y="385">Tax</text><text x="520" y="385" text-anchor="end">4.89</text>
      <text x="40" y="435" font-weight="bold">TOTAL</text><text x="520" y="435" text-anchor="end" font-weight="bold">$61.12</text>
    </g>
  </svg>`;
  return sharp(Buffer.from(svg))
    .rotate(3.5, { background: "#ffffff" })
    .png()
    .toBuffer();
}

// A receipt whose TOTAL label sits on its own line with the value below it and
// a date line after — the layout that once turned "2026" into the total.
async function makeSplitTotalReceiptPng() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="560">
    <rect width="560" height="560" fill="#ffffff"/>
    <g font-family="monospace" font-size="24" fill="#000000">
      <text x="40" y="70" font-size="32" font-weight="bold">JOES DINER</text>
      <text x="40" y="115">88 ELM AVE</text>
      <text x="40" y="170">Burger</text><text x="520" y="170" text-anchor="end">12.50</text>
      <text x="40" y="210">Salad</text><text x="520" y="210" text-anchor="end">9.75</text>
      <text x="40" y="260">Subtotal</text><text x="520" y="260" text-anchor="end">22.25</text>
      <text x="40" y="300">Tax</text><text x="520" y="300" text-anchor="end">1.86</text>
      <text x="40" y="360" font-size="30" font-weight="bold">TOTAL</text>
      <text x="40" y="405" font-size="30" font-weight="bold">$24.11</text>
      <text x="40" y="470">Date: 05/10/2026</text>
      <text x="40" y="510">Check #0442  Server 12</text>
    </g>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// A hand-built two-page PDF (Helvetica text, correct xref) — the scanner-PDF
// case: every page is its own receipt, and processing only page 1 silently
// dropped the rest. pdf.js renders it; Tesseract reads the rendered pages.
function makeTwoPagePdf() {
  const esc = (s) => s.replace(/[\\()]/g, (c) => "\\" + c);
  const content = (lines) => {
    const ops = ["BT", "/F1 28 Tf", "72 708 Td"];
    lines.forEach((line, i) => {
      if (i > 0) ops.push("0 -44 Td");
      ops.push(`(${esc(line)}) Tj`);
    });
    ops.push("ET");
    return ops.join("\n");
  };
  const page1 = content([
    "TARGET",
    "123 RETAIL ROW",
    "Date: 05/02/2026",
    "Mop            12.00",
    "Bucket          3.00",
    "Subtotal       15.00",
    "Tax             0.75",
    "TOTAL         $15.75",
  ]);
  const page2 = content([
    "STARBUCKS",
    "456 COFFEE WAY",
    "Date: 05/03/2026",
    "Latte           4.25",
    "TOTAL          $4.25",
  ]);
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    `<< /Length ${page1.length} >>\nstream\n${page1}\nendstream`,
    `<< /Length ${page2.length} >>\nstream\n${page2}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

// A Tesla Supercharging receipt: the kWh quantity (42.31) is far LARGER than
// the dollar total, and parses as money — the case that used to flag every
// charging receipt for review.
async function makeTeslaReceiptPng() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="600">
    <rect width="560" height="600" fill="#ffffff"/>
    <g font-family="monospace" font-size="24" fill="#000000">
      <text x="40" y="70" font-size="32" font-weight="bold">TESLA</text>
      <text x="40" y="115">SUPERCHARGER BARSTOW CA</text>
      <text x="40" y="160">Date: 06/20/2026</text>
      <text x="40" y="215">SESSION 4B2C</text>
      <text x="40" y="265">ENERGY</text><text x="520" y="265" text-anchor="end">42.31 kWh</text>
      <text x="40" y="310">RATE</text><text x="520" y="310" text-anchor="end">$0.36/kWh</text>
      <text x="40" y="360">IDLE FEE</text><text x="520" y="360" text-anchor="end">$0.00</text>
      <text x="40" y="420" font-weight="bold">TOTAL</text><text x="520" y="420" text-anchor="end" font-weight="bold">$15.23</text>
      <text x="40" y="490">THANK YOU FOR CHARGING</text>
    </g>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// A real ZIP (local headers + central directory), so the intake path is
// exercised against bytes an archiver would actually produce — including the
// __MACOSX/AppleDouble junk macOS adds, which shares the .png extension of
// the receipt beside it.
function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const deflated = deflateRawSync(e.data);
    const useDeflate = deflated.length < e.data.length;
    const payload = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    parts.push(local, name, payload);
    central.push(cen, name);
    offset += 30 + name.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

// Natural size of an embedded image — the aspect ratio the sheet is supposed
// to render. Receipt thumbnails are JPEG; Insights charts are PNG.
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; // PNG IHDR
  }
  return jpegSize(buf);
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

// The px a drawing anchor actually covers, walking the sheet's real column
// widths and row heights — the geometry Excel renders (src/export/anchor.ts).
function anchorPx(ws, range) {
  // ECMA-376 §18.3.1.13 — the stored width already carries the cell padding.
  const colPx = (c) => {
    const w = (ws.columns ?? [])[c]?.width ?? 9.140625;
    return w > 0 ? Math.trunc(((256 * w + 18) / 256) * 7) : 0;
  };
  const rowPx = (r) => ((ws.findRow(r + 1)?.height ?? 15) * 4) / 3;
  const span = (from, fromOff, to, toOff, size) => {
    let px = (toOff - fromOff) / 9525;
    for (let i = from; i < to; i++) px += size(i);
    return px;
  };
  return {
    w: span(range.tl.nativeCol, range.tl.nativeColOff, range.br.nativeCol, range.br.nativeColOff, colPx),
    h: span(range.tl.nativeRow, range.tl.nativeRowOff, range.br.nativeRow, range.br.nativeRowOff, rowPx),
  };
}

async function main() {
  log("starting preview server…");
  // Run vite's bin directly (not through npx): killing the npx wrapper left
  // the preview server orphaned on the port, and the next run then tested
  // whatever stale build was still bound there.
  const server = spawn(
    process.execPath,
    [
      join(root, "node_modules", "vite", "bin", "vite.js"),
      "preview",
      "--port",
      String(PORT),
      "--strictPort",
    ],
    { cwd: root, stdio: "ignore" },
  );
  let browser;
  try {
    await waitForServer(BASE);
    log("server up");

    browser = await launchBrowser();
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") {
        pageErrors++;
        console.error("  [page error]", m.text());
      }
    });
    page.on("pageerror", (e) => {
      pageErrors++;
      console.error("  [uncaught]", e.message);
    });
    page.on("dialog", (d) => d.accept()); // auto-accept confirms

    await page.goto(BASE, { waitUntil: "load" });

    // 1. Landing hero renders.
    await page.getByRole("heading", { name: /Receipts in/ }).waitFor({ timeout: 15000 });
    check(true, "landing hero rendered");
    check(
      (await page.locator("#contact form").count()) === 1,
      "contact form present on the landing page",
    );

    // 2. Add three synthetic receipts in ONE multi-select — this also gates
    //    the picker FileList regression (clearing input.value used to drop
    //    every file after the first). The gas and split-total receipts gate
    //    the real-OCR amount rules the unit tests can only simulate.
    log("uploading 4 synthetic receipts, running on-device OCR…");
    await page
      .locator('input[type=file][multiple]')
      .first()
      .setInputFiles([
        { name: "coffee.png", mimeType: "image/png", buffer: await makeReceiptPng() },
        { name: "gas.png", mimeType: "image/png", buffer: await makeGasReceiptPng() },
        { name: "diner.png", mimeType: "image/png", buffer: await makeSplitTotalReceiptPng() },
        { name: "skewed.png", mimeType: "image/png", buffer: await makeSkewedReceiptPng() },
      ]);

    // 3. Workspace board appears with the processing cards.
    await page.getByText("Drop receipts here").waitFor({ timeout: 10000 });
    check(true, "workspace rendered after adding files");

    // 4. Wait until every receipt row has finished processing.
    const readRows = () =>
      page.evaluate(async () => {
        const open = indexedDB.open("reimbursements-f5");
        const db = await new Promise((res, rej) => {
          open.onsuccess = () => res(open.result);
          open.onerror = () => rej(open.error);
        });
        const tx = db.transaction("receipts", "readonly");
        const all = await new Promise((res) => {
          const req = tx.objectStore("receipts").getAll();
          req.onsuccess = () => res(req.result);
        });
        db.close();
        return all.map((r) => ({
          file: r.originalFileName ?? r.fileName,
          renamed: r.fileName,
          vendor: r.vendor.value,
          amount: r.amount.value,
          cat: r.category.value,
          cost: r.cost,
          method: r.methodUsed,
          status: r.status,
          flags: (r.flags || []).map((f) => f.message).join(" | "),
        }));
      });
    let rows = [];
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      rows = await readRows();
      if (
        rows.length === 4 &&
        rows.every((r) => ["done", "needs_review", "failed"].includes(r.status))
      )
        break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    for (const r of rows) log(`extracted → ${r.file}: vendor="${r.vendor}" amount=${r.amount} [${r.status}]`);

    check(rows.length === 4, `multi-select stored all 4 receipts (got ${rows.length})`);
    const byFile = (n) => rows.find((r) => r.file === n) ?? {};

    const coffee = byFile("coffee.png");
    check(coffee.amount === 8.99, `coffee: OCR+rules read the total (got ${coffee.amount})`);
    check(/BLUE|BOTTLE|COFFEE/i.test(coffee.vendor || ""), `coffee: vendor (got ${coffee.vendor})`);
    check(coffee.cat === "Meals", `coffee: categorized (got ${coffee.cat})`);
    check(coffee.cost === 0 && coffee.method === "rules", "coffee: recorded as free (rules, $0)");

    const gas = byFile("gas.png");
    check(gas.amount === 39.2, `gas: combined TOTAL beats FUEL TOTAL (got ${gas.amount})`);
    check(!/11,?204|3,?499/.test(gas.flags || ""), `gas: gallons/unit price not read as dollars (flags: ${gas.flags || "none"})`);
    check(gas.cat === "Fuel", `gas: categorized (got ${gas.cat})`);

    const diner = byFile("diner.png");
    check(diner.amount === 24.11, `diner: label-only TOTAL takes the value below, not the date (got ${diner.amount})`);

    const skewed = byFile("skewed.png");
    check(skewed.amount === 61.12, `skewed: deskew recovers a 3.5° tilted receipt (got ${skewed.amount})`);
    check(/ACME|HARDWARE/i.test(skewed.vendor || ""), `skewed: vendor (got ${skewed.vendor})`);

    // Files adopt the original app's {category}_{MM-DD-YY}_{vendor} convention.
    check(
      /^fuel_06-12-26_shell\.jpg$/.test(gas.renamed || ""),
      `gas: renamed to the naming convention (got ${gas.renamed})`,
    );

    // 6. Review modal: open the first card and approve through the sweep.
    await page.locator(".rc").first().click();
    await page.getByRole("dialog", { name: /Review receipt/ }).waitFor({ timeout: 10000 });
    check(true, "review modal opened");
    const dialog = page.getByRole("dialog", { name: /Review receipt/ });

    // Editing the amount must persist. (Svelte binds a number input to a
    // NUMBER; parseAmount threw on it and the edit was silently discarded.)
    const beforeEdit = await page.locator("#rv-amount").inputValue();
    await page.locator("#rv-amount").fill("123.45");
    await page.locator("#rv-amount").dispatchEvent("change");
    await page.waitForTimeout(400);
    const afterEdit = (await readRows()).map((r) => r.amount);
    check(
      afterEdit.includes(123.45),
      `review edit persists the amount (amounts: ${afterEdit.join(", ")})`,
    );
    // Restore the true value so the workbook totals below stay canonical.
    await page.locator("#rv-amount").fill(beforeEdit);
    await page.locator("#rv-amount").dispatchEvent("change");
    await page.waitForTimeout(400);

    for (let i = 0; i < 5 && (await dialog.isVisible()); i++) {
      await page.getByRole("button", { name: /Approve/ }).click();
      await page.waitForTimeout(500);
    }
    check(!(await dialog.isVisible()), "approve & next sweep closes when done");

    // 7. Generate the spreadsheet and validate the downloaded workbook.
    await page.locator("#xb-emp").fill("Ada Lovelace");
    await page.locator("#xb-job").fill("Q1 Coffee Run");
    // Insights is on by default — the dashboard assertions below gate that.
    check(
      await page.locator(".opt", { hasText: "Insights sheet" }).locator("input").isChecked(),
      "Insights toggle defaults to on",
    );

    const dlDir = await mkdtemp(join(tmpdir(), "reimb-"));
    // Job number was left blank on purpose: generating must first raise the
    // blank-details prompt, and "Generate anyway" proceeds.
    await page.getByRole("button", { name: /Generate workbook/ }).click();
    const blankDialog = page.getByRole("dialog", { name: "Missing report details" });
    await blankDialog.waitFor({ timeout: 5000 });
    check(true, "blank job number raises the missing-details prompt");
    // Generating yields TWO files: the workbook and (default-on) the print
    // packet PDF. Collect both before validating either.
    const downloads = [];
    const onDownload = (d) => downloads.push(d);
    page.on("download", onDownload);
    await page.getByRole("button", { name: "Generate anyway" }).click();
    for (let i = 0; i < 240 && downloads.length < 2; i++) {
      await page.waitForTimeout(500);
    }
    page.off("download", onDownload);
    const download = downloads.find((d) => d.suggestedFilename().endsWith(".xlsx"));
    const packetDl = downloads.find((d) => d.suggestedFilename().endsWith(".pdf"));
    check(!!download, "generate downloads the workbook");
    check(
      !!packetDl && /^Receipt_Packet_Ada_Lovelace_\d{8}\.pdf$/.test(packetDl.suggestedFilename()),
      `print packet PDF downloads alongside (got ${packetDl?.suggestedFilename()})`,
    );
    if (packetDl) {
      const pdfPath = join(dlDir, packetDl.suggestedFilename());
      await packetDl.saveAs(pdfPath);
      const pdfRaw = (await readFile(pdfPath)).toString("latin1");
      check(
        pdfRaw.startsWith("%PDF-1.4") && /\/Subtype \/Image/.test(pdfRaw),
        "print packet is a real PDF with embedded receipt images",
      );
      check(
        pdfRaw.includes("Receipt packet - Ada Lovelace"),
        "print packet header carries the employee",
      );
    }
    const xlsxPath = join(dlDir, download.suggestedFilename());
    await download.saveAs(xlsxPath);
    log("downloaded", download.suggestedFilename());

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xlsxPath);
    const names = wb.worksheets.map((w) => w.name);
    check(names.includes("Summary"), "workbook has Summary sheet");
    check(names.includes("Insights"), "workbook has Insights sheet");
    check(
      names.includes("Meals") && names.includes("Fuel"),
      `workbook has the category sheets (sheets: ${names.join(", ")})`,
    );
    check(
      !names.includes("All Receipts") && names[names.length - 1] === "Insights",
      "summary+receipts merged; Insights is the rightmost tab",
    );
    // The Summary "#" cells hyperlink to each receipt's image-sheet anchor.
    const summarySheet = wb.getWorksheet("Summary");
    let linkCount = 0;
    summarySheet.eachRow((row) => {
      const v = row.getCell(1).value;
      // HYPERLINK("#'Sheet'!A4", n) formulas (numeric result) — a hyperlink
      // -typed cell would be "1" stored as text.
      if (v && typeof v === "object" && (v.hyperlink || /^HYPERLINK\("#'/.test(v.formula ?? ""))) linkCount++;
    });
    check(linkCount === 4, `summary links every receipt to its image (got ${linkCount})`);

    // 7a-bis. Receipt images must render at their true aspect ratio. An
    // anchor expressed as a FRACTION of a column was rescaled by ExcelJS's
    // width×10000 model and came out ~6.75× too narrow — the "skinny
    // receipts" bug — while the height stayed right, so only a width/aspect
    // assertion catches it.
    const media = wb.model?.media ?? [];
    let imagesChecked = 0;
    for (const sheetName of ["Fuel", "Materials", "Meals", "Miscellaneous", "Insights"]) {
      const ws = wb.getWorksheet(sheetName);
      if (!ws) continue;
      for (const image of ws.getImages()) {
        const entry = media[Number(image.imageId)] ?? media[0];
        const natural = entry?.buffer ? imageSize(entry.buffer) : null;
        const drawn = anchorPx(ws, image.range);
        if (!natural) continue;
        imagesChecked++;
        const wantAspect = natural.w / natural.h;
        const gotAspect = drawn.w / drawn.h;
        check(
          Math.abs(gotAspect - wantAspect) / wantAspect < 0.04,
          `${sheetName}: image keeps its aspect ratio (drawn ${Math.round(drawn.w)}×${Math.round(drawn.h)}px, natural ${natural.w}×${natural.h})`,
        );
        check(
          drawn.w > 150,
          `${sheetName}: image is a readable width, not a sliver (${Math.round(drawn.w)}px)`,
        );
      }
    }
    check(
      imagesChecked >= 8,
      `every embedded image was measured — receipts and charts (got ${imagesChecked})`,
    );


    // 7c. Multi-page PDF: every page becomes its own receipt — the scanner
    // workflow (processing only page 1 silently dropped the rest).
    log("uploading a 2-page PDF…");
    await page
      .locator('input[type=file][multiple]')
      .first()
      .setInputFiles([
        { name: "stack.pdf", mimeType: "application/pdf", buffer: makeTwoPagePdf() },
      ]);
    let pdfRows = [];
    const pdfDeadline = Date.now() + 180000;
    while (Date.now() < pdfDeadline) {
      pdfRows = (await readRows()).filter((r) => /^stack\.pdf \(page /.test(r.file));
      if (
        pdfRows.length === 2 &&
        pdfRows.every((r) => ["done", "needs_review", "failed"].includes(r.status))
      )
        break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    for (const r of pdfRows) log(`extracted → ${r.file}: vendor="${r.vendor}" amount=${r.amount} [${r.status}]`);
    check(pdfRows.length === 2, `2-page PDF expanded into 2 receipts (got ${pdfRows.length})`);
    const pdfP1 = pdfRows.find((r) => r.file.includes("(page 1 of 2)")) ?? {};
    const pdfP2 = pdfRows.find((r) => r.file.includes("(page 2 of 2)")) ?? {};
    check(pdfP1.amount === 15.75, `PDF page 1: total read (got ${pdfP1.amount})`);
    check(/TARGET/i.test(pdfP1.vendor || ""), `PDF page 1: vendor (got ${pdfP1.vendor})`);
    check(pdfP2.amount === 4.25, `PDF page 2: total read (got ${pdfP2.amount})`);
    check(/STARBUCKS/i.test(pdfP2.vendor || ""), `PDF page 2: vendor (got ${pdfP2.vendor})`);

    // 7d. ZIP intake: an archive of nested folders (the "here's the folder of
    // Tesla charging receipts" case) becomes one receipt per usable file, and
    // the archiver junk beside them must not become receipts of its own.
    log("uploading a ZIP of nested folders…");
    const teslaPng = await makeTeslaReceiptPng();
    const zipUpload = makeZip([
      { name: "Charging/2026/03/", data: Buffer.alloc(0) },
      { name: "Charging/2026/03/session_01.png", data: teslaPng },
      { name: "__MACOSX/Charging/2026/03/._session_01.png", data: Buffer.from("applejunk") },
      { name: "Charging/.DS_Store", data: Buffer.from("junk") },
      { name: "Charging/notes.txt", data: Buffer.from("not a receipt") },
    ]);
    await page
      .locator("input[type=file][multiple]")
      .first()
      .setInputFiles([
        { name: "tesla_receipts.zip", mimeType: "application/zip", buffer: zipUpload },
      ]);
    let zipRows = [];
    const zipDeadline = Date.now() + 180000;
    while (Date.now() < zipDeadline) {
      zipRows = (await readRows()).filter((r) => /^tesla_receipts\.zip/.test(r.file));
      if (
        zipRows.length >= 1 &&
        zipRows.every((r) => ["done", "needs_review", "failed"].includes(r.status))
      )
        break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    for (const r of zipRows) log(`extracted → ${r.file}: vendor="${r.vendor}" amount=${r.amount} [${r.status}]`);
    check(
      zipRows.length === 1,
      `ZIP expanded to the one real receipt inside it, junk skipped (got ${zipRows.length})`,
    );
    const tesla = zipRows[0] ?? {};
    check(
      tesla.file === "tesla_receipts.zip › Charging/2026/03/session_01.png",
      `ZIP entry keeps its path inside the archive (got ${tesla.file})`,
    );
    check(/TESLA/i.test(tesla.vendor || ""), `Tesla: vendor recognized (got ${tesla.vendor})`);
    check(tesla.cat === "Fuel", `Tesla: charging files under Fuel (got ${tesla.cat})`);
    check(tesla.amount === 15.23, `Tesla: total read, not the 42.31 kWh (got ${tesla.amount})`);
    check(
      !/larger amount/i.test(tesla.flags || ""),
      `Tesla: kWh quantity doesn't flag the total (got "${tesla.flags}")`,
    );

    // 8. Header brand navigates home; the hero offers the way back.
    await page.locator("header.ws-head .brand").click();
    await page.getByRole("heading", { name: /Receipts in/ }).waitFor({ timeout: 10000 });
    check(true, "brand click returns to the landing page");
    await page.getByRole("button", { name: /Back to your receipts \(7\)/ }).click();
    await page.getByText("Drop receipts here").waitFor({ timeout: 10000 });
    check(true, "landing offers the way back to the workspace");

    // 8b. Phone width: neither surface may overflow the viewport sideways —
    // an overflowing row used to let touch swipes pan the whole page, and
    // under the root overflow-x clip it would instead strand controls
    // off-screen. Measured with the clip disabled so the check catches the
    // underlying overflow, not the backstop masking it.
    const contentWidth = () =>
      page.evaluate(() => {
        document.documentElement.style.setProperty("overflow-x", "visible", "important");
        document.body.style.setProperty("overflow-x", "visible", "important");
        const w = document.scrollingElement.scrollWidth;
        document.documentElement.style.removeProperty("overflow-x");
        document.body.style.removeProperty("overflow-x");
        return w;
      });
    await page.setViewportSize({ width: 390, height: 844 });
    const wsW = await contentWidth();
    check(wsW <= 390, `workspace fits a 390px phone with receipts on the board (scrollWidth ${wsW})`);
    await page.getByRole("button", { name: "Settings" }).click();
    const settingsDialog = page.getByRole("dialog", { name: "Settings" });
    await settingsDialog.waitFor({ timeout: 5000 });
    check(true, "Settings is reachable at phone width");
    await page.keyboard.press("Escape");
    await settingsDialog.waitFor({ state: "hidden", timeout: 5000 });
    await page.locator("header.ws-head .brand").click();
    await page.getByRole("heading", { name: /Receipts in/ }).waitFor({ timeout: 10000 });
    const landW = await contentWidth();
    check(landW <= 390, `landing fits a 390px phone (scrollWidth ${landW})`);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole("button", { name: /Back to your receipts \(7\)/ }).click();
    await page.getByText("Drop receipts here").waitFor({ timeout: 10000 });

    // 9. Delete all receipts — immediate, no confirm dialog.
    await page.getByRole("button", { name: /Delete all/ }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".rc").length === 0,
      { timeout: 15000 },
    );
    const left = (await readRows()).length;
    check(left === 0, `delete-all clears the board and the store (left ${left})`);

    // 10. Page-wide drag & drop on the landing: a file drag raises the veil,
    // and dropping anywhere ingests (the window listeners in Landing.svelte).
    await page.goto(BASE, { waitUntil: "load" });
    await page.getByRole("heading", { name: /Receipts in/ }).waitFor({ timeout: 15000 });
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "peek.png", { type: "image/png" }));
      window.dispatchEvent(
        new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    });
    await page.waitForSelector(".drop-veil", { timeout: 5000 });
    check(true, "file drag over the landing raises the drop veil");
    const dropPng = await makeReceiptPng();
    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
      window.dispatchEvent(
        new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    }, dropPng.toString("base64"));
    await page.waitForSelector(".rc", { timeout: 15000 });
    check(true, "dropping a receipt anywhere on the landing ingests it");
    check(
      (await page.locator(".drop-veil").count()) === 0,
      "the drop veil clears after the drop",
    );

    check(pageErrors === 0, `no uncaught or console errors during the run (got ${pageErrors})`);
  } finally {
    if (browser) await browser.close();
    server.kill("SIGKILL");
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll end-to-end checks passed ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
