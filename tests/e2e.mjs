// End-to-end smoke test against the real production build, driven through a
// headless Chromium. Proves the browser-only paths the unit tests can't:
// the landing hero, IndexedDB storage, canvas image-prep, on-device Tesseract
// OCR, the board/review UI, and xlsx export. Run with: node tests/e2e.mjs
import { chromium, devices } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { deflateRawSync, inflateRawSync, crc32 } from "node:zlib";
import sharp from "sharp";
import ExcelJS from "exceljs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// E2E_PORT lets parallel checkouts (git worktrees) run the gate side by side.
const PORT = Number(process.env.E2E_PORT) || 5179;
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

// A downloaded ZIP's entries, read from its central directory (stored or
// deflated) — enough to inspect the tuning bundle.
function readZipEntries(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out.push({ name, data: method === 8 ? inflateRawSync(raw) : raw });
    p += 46 + nameLen + extra + comment;
  }
  return out;
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
          dims: [r.imageWidth, r.imageHeight],
          abox: r.amount.bbox ?? null,
        }));
      });
    // The device-local work-list (store/repo.ts jobs): the pause's contract
    // is that a paused job is unlocked with no attempt used.
    const readJobs = () =>
      page.evaluate(async () => {
        const open = indexedDB.open("reimbursements-f5");
        const db = await new Promise((res, rej) => {
          open.onsuccess = () => res(open.result);
          open.onerror = () => rej(open.error);
        });
        const tx = db.transaction("jobs", "readonly");
        const all = await new Promise((res) => {
          const req = tx.objectStore("jobs").getAll();
          req.onsuccess = () => res(req.result);
        });
        db.close();
        return all.map((j) => ({ receiptId: j.receiptId, attempts: j.attempts, lockedAt: j.lockedAt }));
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
    // One click, one download: a second file from the same click trips the
    // browser's "download multiple files" prompt, so the packet has its own
    // button and zipping it in with the workbook is opt-in (default off).
    const packetZipOpt = page
      .locator(".opt", { hasText: "Include the print packet (one ZIP)" })
      .locator("input");
    check(!(await packetZipOpt.isChecked()), "the print-packet ZIP option defaults to off");
    // Job number was left blank on purpose: generating must first raise the
    // blank-details prompt, and "Generate anyway" proceeds.
    await page.getByRole("button", { name: /Generate workbook/ }).click();
    const blankDialog = page.getByRole("dialog", { name: "Missing report details" });
    await blankDialog.waitFor({ timeout: 5000 });
    check(true, "blank job number raises the missing-details prompt");
    const downloads = [];
    const onDownload = (d) => downloads.push(d);
    page.on("download", onDownload);
    const dlNames = () => downloads.map((d) => d.suggestedFilename()).join(", ") || "none";
    // Wait for the click's first download, then linger: a second file from
    // the same click would land within the grace period.
    const settleDownloads = async () => {
      for (let i = 0; i < 240 && downloads.length < 1; i++) await page.waitForTimeout(500);
      await page.waitForTimeout(2500);
    };
    await page.getByRole("button", { name: "Generate anyway" }).click();
    await settleDownloads();
    const download = downloads.find((d) => d.suggestedFilename().endsWith(".xlsx"));
    check(
      downloads.length === 1 && !!download,
      `Generate downloads exactly one file, the workbook (got ${dlNames()})`,
    );

    // Download packet: its own click, so its own (single) download.
    downloads.length = 0;
    await page.getByRole("button", { name: "Download packet" }).click();
    await settleDownloads();
    const packetDl = downloads[0];
    check(
      downloads.length === 1 &&
        /^Receipt_Packet_Ada_Lovelace_\d{8}\.pdf$/.test(packetDl?.suggestedFilename() ?? ""),
      `Download packet downloads exactly the print packet PDF (got ${dlNames()})`,
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

    // Opted in, Generate hands over ONE ZIP holding both files.
    downloads.length = 0;
    await packetZipOpt.check();
    await page.getByRole("button", { name: /Generate workbook/ }).click();
    await blankDialog.waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "Generate anyway" }).click();
    await settleDownloads();
    const zipDl = downloads[0];
    check(
      downloads.length === 1 &&
        /^Report_Ada_Lovelace_\d{8}\.zip$/.test(zipDl?.suggestedFilename() ?? ""),
      `the ZIP option downloads exactly one archive (got ${dlNames()})`,
    );
    if (zipDl) {
      const zipPath = join(dlDir, zipDl.suggestedFilename());
      await zipDl.saveAs(zipPath);
      const zipRaw = await readFile(zipPath);
      check(
        zipRaw.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) &&
          zipRaw.includes(Buffer.from(download?.suggestedFilename() ?? "\0")) &&
          /Receipt_Packet_Ada_Lovelace_\d{8}\.pdf/.test(zipRaw.toString("latin1")),
        "the archive holds the workbook and the print packet",
      );
    }
    await packetZipOpt.uncheck();
    page.off("download", onDownload);

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
    // The Summary "#" cells hyperlink to each receipt's image-sheet block.
    const summarySheet = wb.getWorksheet("Summary");
    let linkCount = 0;
    let blockLinks = 0;
    summarySheet.eachRow((row) => {
      const v = row.getCell(1).value;
      // HYPERLINK("#'Sheet'!A3:F21", n) formulas (numeric result) — a
      // hyperlink-typed cell would be "1" stored as text.
      if (v && typeof v === "object" && (v.hyperlink || /^HYPERLINK\("#'/.test(v.formula ?? ""))) linkCount++;
      // The target is a RANGE from the receipt's own header band that fits
      // a laptop window (LINK_VIEW_PX = 360): Excel scrolls a range that
      // fits fully into view, where a single cell reached going down sat on
      // the bottom edge with the image off-screen. Real images, real row
      // heights — the only end-to-end run of the image-branch block math.
      const m = /^HYPERLINK\("#'([^']+)'!A(\d+):F(\d+)",(\d+)\)$/.exec(v?.formula ?? "");
      if (!m) return;
      const [, sheet, top, end, n] = m.map((x, i) => (i >= 2 ? Number(x) : x));
      const ws = wb.getWorksheet(sheet);
      const amt = /^'([^']+)'!F(\d+)$/.exec(row.getCell(6).value?.formula ?? "");
      if (!ws || !amt || amt[1] !== sheet) return;
      const data = Number(amt[2]);
      const px = (a, b) => {
        let t = 0;
        for (let r = a; r <= b; r++) t += Math.round(((ws.findRow(r)?.height ?? 15) * 4) / 3);
        return t;
      };
      const band = String(ws.getCell(top, 1).value ?? "");
      if (
        band.startsWith(`Receipt ${n} `) &&
        end <= data &&
        px(top, end) <= 360 &&
        // The whole block through its data row when it fits; capped inside
        // the image otherwise.
        (end === data) === (px(top, data) <= 360)
      ) {
        blockLinks++;
      } else {
        log(`bad link ${v.formula} (band "${band}", amount row ${data}, ${px(top, end)}px)`);
      }
    });
    check(linkCount === 4, `summary links every receipt to its image (got ${linkCount})`);
    check(
      blockLinks === 4,
      `every link selects its receipt's block from the header band, fitting the window (got ${blockLinks})`,
    );

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

    // 7b. A possible duplicate still in the TOTAL makes Generate ask first
    // (a flagged $80.29 repeat once shipped unreviewed in a real report).
    // Re-uploading the coffee receipt is a byte-identical duplicate: the OCR
    // cache answers it, and dedup flags it.
    log("re-uploading the coffee receipt as a duplicate…");
    await page
      .locator("input[type=file][multiple]")
      .first()
      .setInputFiles([{ name: "coffee-again.png", mimeType: "image/png", buffer: await makeReceiptPng() }]);
    let dupRow = {};
    const dupDeadline = Date.now() + 120000;
    while (Date.now() < dupDeadline) {
      dupRow = (await readRows()).find((r) => r.file === "coffee-again.png") ?? {};
      if (["done", "needs_review", "failed"].includes(dupRow.status)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Byte-identical → "Looks identical to …"; should the cleaned re-encode
    // ever differ, the semantic match (vendor + date + amount) flags it.
    const dupMsg = /Looks identical|possible duplicate/;
    check(
      dupRow.status === "needs_review" && dupMsg.test(dupRow.flags || ""),
      `a re-uploaded receipt is flagged as a duplicate (got ${dupRow.status}: ${dupRow.flags})`,
    );
    // Every report detail filled, so the duplicate alone raises the prompt.
    await page.locator("#xb-num").fill("24-117");
    await page.locator("#xb-num").dispatchEvent("change");
    await page.getByRole("button", { name: /Generate workbook/ }).click();
    const dupDialog = page.getByRole("dialog", { name: "Possible duplicates in this report" });
    await dupDialog.waitFor({ timeout: 5000 });
    check(
      /1 possible duplicate is still in the total: .+ — \$8\.99/.test(await dupDialog.innerText()),
      "Generate names the unresolved duplicate and its amount",
    );
    await dupDialog.getByRole("button", { name: "Review duplicate" }).click();
    const reviewDialog = page.getByRole("dialog", { name: /Review receipt/ });
    await reviewDialog.waitFor({ timeout: 5000 });
    // The review opens straight into the side-by-side compare (the warning
    // lives in the compare panel there, not in the flag list).
    const twinPanel = reviewDialog.getByRole("region", { name: /Possible duplicate/ });
    await twinPanel.waitFor({ timeout: 5000 }).catch(() => {});
    check(
      (await dupDialog.count()) === 0 && (await twinPanel.count()) === 1,
      "Review duplicate closes the prompt and opens the flagged receipt beside its twin",
    );
    // Resolve it the way a human would: delete the repeat. The modal then
    // moves on to a neighbour — close it only once the delete has landed
    // (an Escape mid-delete would be undone by that hand-off).
    await reviewDialog.getByRole("button", { name: "Delete", exact: true }).click();
    let afterDup = [];
    for (let i = 0; i < 40; i++) {
      afterDup = await readRows();
      if (afterDup.length === 4) break;
      await page.waitForTimeout(250);
    }
    check(afterDup.length === 4, `the duplicate is deleted (rows ${afterDup.length})`);
    await page.waitForTimeout(300);
    if (await reviewDialog.isVisible()) await page.keyboard.press("Escape");
    await reviewDialog.waitFor({ state: "hidden", timeout: 5000 });


    // Phone-width measure (7c, 8b): neither surface may overflow the
    // viewport sideways — an overflowing row used to let touch swipes pan
    // the whole page, and under the root overflow-x clip it would instead
    // strand controls off-screen. Measured with the clip disabled so the
    // check catches the underlying overflow, not the backstop masking it.
    const contentWidth = () =>
      page.evaluate(() => {
        document.documentElement.style.setProperty("overflow-x", "visible", "important");
        document.body.style.setProperty("overflow-x", "visible", "important");
        const w = document.scrollingElement.scrollWidth;
        document.documentElement.style.removeProperty("overflow-x");
        document.body.style.removeProperty("overflow-x");
        return w;
      });

    // 7c. Multi-page PDF: every page becomes its own receipt — the scanner
    // workflow (processing only page 1 silently dropped the rest).
    log("uploading a 2-page PDF…");
    await page
      .locator('input[type=file][multiple]')
      .first()
      .setInputFiles([
        { name: "stack.pdf", mimeType: "application/pdf", buffer: makeTwoPagePdf() },
      ]);

    // 7c-i. Pause mid-read: catch a page while it is being read, pause, and
    // the read in flight must unwind to "queued" — never "failed" — with its
    // job unlocked and no attempt used; nothing moves while paused; resume
    // then reads both pages to the same amounts the checks below expect.
    const isPdfRow = (r) => /^stack\.pdf \(page /.test(r.file);
    const settledStatus = (s) => ["done", "needs_review", "failed"].includes(s);
    let inFlight = null;
    {
      const end = Date.now() + 60000;
      while (Date.now() < end) {
        const seen = (await readRows()).filter(isPdfRow);
        inFlight = seen.find((r) => r.status === "processing") ?? null;
        if (inFlight) break;
        if (seen.length === 2 && seen.every((r) => settledStatus(r.status))) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const pauseBtn = page.getByRole("button", { name: "Pause reading" });
    await pauseBtn.click({ timeout: 10000 });
    check((await pauseBtn.getAttribute("aria-pressed")) === "true", "the pause toggle reports pressed");
    await page
      .locator(".ws-head [role=status]")
      .getByText("Paused", { exact: true })
      .waitFor({ timeout: 20000 });
    check(true, "the header says Paused once the reads in flight unwind");
    if (inFlight) {
      let paused = [];
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        paused = (await readRows()).filter(isPdfRow);
        if (paused.length === 2 && paused.every((r) => r.status !== "processing")) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      for (const r of paused) log(`paused → ${r.file} [${r.status}]`);
      check(
        paused.length === 2 && paused.every((r) => r.status !== "failed" && r.status !== "processing"),
        "pausing unwinds in-flight reads to queued, never failed",
      );
      const unwound = paused.filter((r) => r.status === "queued");
      check(unwound.length >= 1, `a read caught mid-flight went back to queued (${unwound.length} queued)`);
      let jobs = [];
      const jobsEnd = Date.now() + 5000;
      while (Date.now() < jobsEnd) {
        jobs = await readJobs();
        if (jobs.every((j) => j.lockedAt === null)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      check(
        jobs.length === unwound.length && jobs.every((j) => j.lockedAt === null && j.attempts === 0),
        `paused jobs are unclaimed with no attempt used (${JSON.stringify(jobs)})`,
      );
      await page.waitForTimeout(3000);
      const still = (await readRows()).filter(isPdfRow);
      check(
        still.filter((r) => r.status === "queued").length === unwound.length,
        "nothing is read while paused",
      );
      check(
        (await page.locator(".rc").filter({ hasText: "Paused — resume reading" }).count()) === unwound.length,
        "a paused receipt's card says so instead of \"Reading on your device…\"",
      );
    } else {
      log("both PDF pages finished before one was seen mid-read — skipping the unwind checks");
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const pausedW = await contentWidth();
    check(pausedW <= 390, `workspace header fits 390px with the pause control and Paused chip (scrollWidth ${pausedW})`);
    await page.setViewportSize({ width: 1280, height: 720 });
    await pauseBtn.click();
    check((await pauseBtn.getAttribute("aria-pressed")) === "false", "resume: the toggle is released");

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

    // 7c-bis. A digital PDF page is stored cropped to its print (the ink
    // crop), not as the whole blank Letter sheet — the Chevron-app
    // e-receipts exported as full 8.5×11 images. A whole page renders at
    // 2010×2600 and stores at 1237×1600; each fixture's print covers under
    // half the page's height, so its crop stores smaller (the aspect is no
    // test: page 1's crop happens to land near Letter's). And the TOTAL —
    // the last printed line, at the column's right edge — ends in the
    // bottom quarter and right 30% of the stored frame; on the uncropped
    // page it sat mid-sheet (~0.5 across, 0.33–0.5 down).
    for (const [label, r] of [["page 1", pdfP1], ["page 2", pdfP2]]) {
      const [w, h] = r.dims ?? [];
      const b = r.abox;
      check(
        w > 0 && h > 0 && Math.max(w, h) < 1400,
        `PDF ${label}: stored cropped to the print, not the Letter page (got ${w}×${h})`,
      );
      check(
        !!b && b.y + b.h > 0.75 && b.x + b.w > 0.7,
        `PDF ${label}: the total sits at the crop's bottom-right edge (got ${b ? `x2 ${(b.x + b.w).toFixed(2)}, y2 ${(b.y + b.h).toFixed(2)}` : "no box"})`,
      );
    }

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

    // 7e runs in its own block: 7b declares the same helper names.
    {
      // 7e. A suspected duplicate reviews side by side. Re-upload coffee.png
      // under another name: the read flags it and names its twin by id
      // (Flag.ref), review shows both, Keep both clears the warning on BOTH
      // rows, and deleting the copy leaves the board as step 8 expects.
      // (A local reader, not readRows: it needs ids and the flags themselves.)
      const readDupRows = () =>
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
            id: r.id,
            file: r.originalFileName ?? r.fileName,
            status: r.status,
            dups: (r.flags || [])
              .filter((f) => f.code === "duplicate")
              .map((f) => ({ message: f.message, ref: f.ref ?? null })),
            apart: r.notDuplicateOf ?? [],
          }));
        });
      log("re-uploading coffee.png as a duplicate…");
      await page
        .locator("input[type=file][multiple]")
        .first()
        .setInputFiles([
          { name: "coffee-again.png", mimeType: "image/png", buffer: await makeReceiptPng() },
        ]);
      let dupRows = [];
      const dupDeadline = Date.now() + 180000;
      while (Date.now() < dupDeadline) {
        dupRows = await readDupRows();
        const again = dupRows.find((r) => r.file === "coffee-again.png");
        if (again && ["done", "needs_review", "failed"].includes(again.status)) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      const coffeeRow = dupRows.find((r) => r.file === "coffee.png") ?? {};
      const againRow = dupRows.find((r) => r.file === "coffee-again.png") ?? {};
      const againFlag = againRow.dups?.[0] ?? {};
      log(`duplicate → ${againRow.file}: [${againRow.status}] ${againFlag.message ?? "no duplicate flag"}`);
      check(againRow.status === "needs_review", `re-uploaded copy is held for review (got ${againRow.status})`);
      check(
        !!coffeeRow.id && againFlag.ref === coffeeRow.id,
        `duplicate flag names its twin by id (ref ${againFlag.ref}, twin ${coffeeRow.id})`,
      );
      check(
        /"coffee\.png"/.test(againFlag.message ?? ""),
        `duplicate flag quotes the twin's upload name (got "${againFlag.message}")`,
      );
      await page.locator(".rc", { hasText: /Looks identical|possible duplicate/ }).first().click();
      const dupDialog = page.getByRole("dialog", { name: /Review receipt/ });
      await dupDialog.waitFor({ timeout: 10000 });
      const peerRegion = page.getByRole("region", { name: /Possible duplicate/ });
      await peerRegion.waitFor({ timeout: 10000 });
      await peerRegion.locator("img").waitFor({ timeout: 10000 });
      check(
        ((await peerRegion.textContent()) ?? "").includes("coffee.png"),
        "review shows the twin side by side, named by its upload",
      );
      check((await peerRegion.locator("img").count()) === 1, "the twin panel shows the twin's image");
      // Zoom at phone width, where the compare stacks: each zoomed column
      // used to collapse to 0 px (a scroll container in an `auto` grid row
      // with no free space) and take its own Zoom toggle out of reach.
      await page.setViewportSize({ width: 390, height: 844 });
      for (const [name, column] of [
        ["Zoom this receipt", dupDialog.locator(".m-image")],
        ["Zoom the possible duplicate", peerRegion],
      ]) {
        const zoom = page.getByRole("button", { name });
        await zoom.click();
        const zoomedH = (await column.boundingBox())?.height ?? 0;
        check(zoomedH > 100 && zoomedH <= 844 * 0.7 + 1, `${name}: the zoomed column keeps its height (${zoomedH}px)`);
        const unzoomed = await zoom
          .click({ timeout: 5000 })
          .then(() => true)
          .catch(() => false);
        check(
          unzoomed && (await zoom.getAttribute("aria-pressed")) === "false",
          `${name}: Zoom stays reachable and zooms back out`,
        );
      }
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.getByRole("button", { name: "Keep both" }).click();
      await peerRegion.waitFor({ state: "detached", timeout: 10000 });
      const keptRows = await readDupRows();
      check(
        keptRows.length === 8 && keptRows.every((r) => r.dups.length === 0),
        "Keep both clears the duplicate warning on both copies",
      );
      // …and remembers the verdict so no later read or re-check pairs them
      // again — on the row that held the warning; the original, which held
      // none, isn't rewritten (rows sync whole, last writer wins).
      const keptA = keptRows.find((r) => r.file === "coffee.png");
      const keptB = keptRows.find((r) => r.file === "coffee-again.png");
      check(
        !!keptA && !!keptB && keptB.apart.includes(keptA.id) && keptA.apart.length === 0,
        "Keep both records the verdict on the copy that held the warning, and leaves the original alone",
      );
      check(
        await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')),
        "focus stays inside the review dialog after Keep both",
      );
      // Delete the copy (the footer Delete), then close: back to 7 receipts.
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".rc").length === 7, { timeout: 15000 });
      await page.keyboard.press("Escape");
      await dupDialog.waitFor({ state: "hidden", timeout: 5000 });
      const afterDup = await readDupRows();
      check(
        afterDup.length === 7 && !afterDup.some((r) => r.file === "coffee-again.png"),
        `deleting the copy leaves the original (${afterDup.length} receipts)`,
      );
    }

    // 7f. The tuning bundle is COMPACT by default (for sharing: no
    // originals, each highlighted copy re-encoded at ≤ 1100 px through the
    // real canvas path) and full on request (every original verbatim).
    {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const tuneDialog = page.getByRole("dialog", { name: "Settings" });
      await tuneDialog.waitFor({ timeout: 5000 });
      const compactOpt = tuneDialog.getByLabel("Compact (smaller, for sharing)");
      check(await compactOpt.isChecked(), "the tuning bundle defaults to compact");
      const grabBundle = async () => {
        const [dl] = await Promise.all([
          page.waitForEvent("download", { timeout: 60000 }),
          tuneDialog.getByRole("button", { name: "Download tuning bundle" }).click(),
        ]);
        const path = join(dlDir, dl.suggestedFilename());
        await dl.saveAs(path);
        const buf = await readFile(path);
        return { name: dl.suggestedFilename(), size: buf.length, entries: readZipEntries(buf) };
      };
      const small = await grabBundle();
      const smallImgs = small.entries.filter((e) => e.name.startsWith("images/"));
      const edges = smallImgs.map((e) => {
        const d = jpegSize(e.data);
        return d ? Math.max(d.w, d.h) : Infinity;
      });
      const rows = JSON.parse(small.entries.find((e) => e.name === "extraction.json")?.data.toString("utf8") ?? "[]");
      check(
        /^dueback_tuning_compact_\d{8}\.zip$/.test(small.name) &&
          ["corrections.json", "extraction.json", "report.csv"].every((n) => small.entries.some((e) => e.name === n)) &&
          smallImgs.length === 7 &&
          smallImgs.every((e) => e.name.startsWith("images/annotated/")) &&
          edges.every((px) => px <= 1100) &&
          rows.length === 7 &&
          rows.every((r) => r.originalOmitted === true),
        `compact bundle: data files + ${smallImgs.length} highlighted images ≤ 1100 px, no originals, every row marked (${small.name}, edges ${edges.join("/")})`,
      );
      await compactOpt.uncheck();
      const full = await grabBundle();
      check(
        /^dueback_tuning_\d{8}\.zip$/.test(full.name) &&
          full.entries.some((e) => e.name.startsWith("images/original/")) &&
          full.size > small.size,
        `full bundle carries the originals and is the bigger one (${full.size} vs ${small.size} bytes)`,
      );
      await compactOpt.check();
      await page.keyboard.press("Escape");
      await tuneDialog.waitFor({ state: "hidden", timeout: 5000 });
    }

    // 7g runs in its own block too.
    {
      // 7g. Settings → "Re-check this batch" heals rows stored before two
      // read-time fixes, from STORED data only (pipeline/recheck.ts). Seed,
      // straight into IndexedDB and with no job (nothing reads them):
      //  (a) a legacy AI read — a copy of the coffee receipt as the assist
      //      stored it before provenance: methodUsed "paid", no `assist`, no
      //      boxes, no annotated copy, the model's JSON in ocrText;
      //  (b) a missed pair — a copy of the gas receipt whose vendor reads
      //      "Shell Oil #42" (same brand identity, date and amount as the
      //      original "Shell"; the old dedup compared spellings).
      // The re-check boxes (a) on the lines that print its values and bakes
      // its annotated copy — values and ocrText untouched — and flags both
      // later copies against their originals; a second run finds nothing.
      // Both seeds are then deleted from review so step 8's count holds.
      const seeded = await page.evaluate(async () => {
        const open = indexedDB.open("reimbursements-f5");
        const db = await new Promise((res, rej) => {
          open.onsuccess = () => res(open.result);
          open.onerror = () => rej(open.error);
        });
        const req = (r) =>
          new Promise((res, rej) => {
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
        const tx = db.transaction(["receipts", "blobs"], "readwrite");
        const receipts = tx.objectStore("receipts");
        const blobs = tx.objectStore("blobs");
        const all = await req(receipts.getAll());
        const byUpload = (n) => all.find((r) => (r.originalFileName ?? r.fileName) === n);
        const coffee = byUpload("coffee.png");
        const gas = byUpload("gas.png");
        // Each seed owns copies of its blobs: deleting it must not take the
        // original's images with it.
        const copyBlob = async (key, tag) => {
          if (!key) return undefined;
          const rec = await req(blobs.get(key));
          if (!rec) return undefined;
          const copy = `blob_e2e_${tag}_${rec.kind}`;
          await req(blobs.put({ ...rec, key: copy }));
          return copy;
        };
        const bare = (f) => ({ value: f.value, confidence: f.confidence });
        const now = Date.now();
        const answer = JSON.stringify({
          vendor: coffee.vendor.value,
          date: coffee.date.value,
          amount: coffee.amount.value,
          tax: coffee.tax.value,
          category: coffee.category.value,
        });
        const legacy = {
          ...coffee,
          id: "rcpt_e2e-legacy-ai",
          fileKey: await copyBlob(coffee.fileKey, "legacy"),
          cleanedKey: await copyBlob(coffee.cleanedKey, "legacy"),
          fileName: "meals_03-14-26_legacy_ai_seed.jpg",
          originalFileName: "legacy-ai-seed.png",
          imageHash: "e2e-seed-legacy-ai",
          vendor: bare(coffee.vendor),
          date: bare(coffee.date),
          amount: bare(coffee.amount),
          methodUsed: "paid",
          methodDetail: "Self-hosted · test-model",
          ocrText: answer,
          flags: [],
          status: "done",
          approved: false,
          reviewRequired: false,
          createdAt: now,
          updatedAt: now,
        };
        delete legacy.annotatedKey;
        delete legacy.assist;
        const pair = {
          ...gas,
          id: "rcpt_e2e-missed-pair",
          fileKey: await copyBlob(gas.fileKey, "pair"),
          cleanedKey: await copyBlob(gas.cleanedKey, "pair"),
          annotatedKey: await copyBlob(gas.annotatedKey, "pair"),
          fileName: "fuel_06-12-26_shell_oil_42.jpg",
          originalFileName: "missed-pair-seed.png",
          imageHash: "e2e-seed-missed-pair",
          vendor: { ...gas.vendor, value: "Shell Oil #42" },
          flags: [],
          status: "done",
          approved: false,
          reviewRequired: false,
          createdAt: now + 1,
          updatedAt: now + 1,
        };
        await req(receipts.put(legacy));
        await req(receipts.put(pair));
        await new Promise((res, rej) => {
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
        });
        db.close();
        return {
          legacyId: legacy.id,
          pairId: pair.id,
          coffeeId: coffee.id,
          gasId: gas.id,
          gasVendor: gas.vendor.value,
          answer,
          values: [legacy.vendor.value, legacy.date.value, legacy.amount.value],
          coffeeBoxes: [coffee.vendor.bbox ?? null, coffee.date.bbox ?? null, coffee.amount.bbox ?? null],
          blobKeys: [legacy.fileKey, legacy.cleanedKey, pair.fileKey, pair.cleanedKey, pair.annotatedKey].filter(Boolean),
        };
      });
      log(`seeded a legacy AI read and a "Shell Oil #42" copy of "${seeded.gasVendor}"`);

      /** The seeded rows (and their original twins) as stored, with the
       *  annotated blob each one points at. */
      const readSeeded = () =>
        page.evaluate(async (ids) => {
          const open = indexedDB.open("reimbursements-f5");
          const db = await new Promise((res, rej) => {
            open.onsuccess = () => res(open.result);
            open.onerror = () => rej(open.error);
          });
          const req = (r) =>
            new Promise((res, rej) => {
              r.onsuccess = () => res(r.result);
              r.onerror = () => rej(r.error);
            });
          const tx = db.transaction(["receipts", "blobs"], "readonly");
          const out = {};
          for (const id of ids) {
            const r = await req(tx.objectStore("receipts").get(id));
            if (!r) {
              out[id] = null;
              continue;
            }
            const ann = r.annotatedKey ? await req(tx.objectStore("blobs").get(r.annotatedKey)) : null;
            out[id] = {
              status: r.status,
              methodUsed: r.methodUsed,
              ocrText: r.ocrText,
              values: [r.vendor.value, r.date.value, r.amount.value],
              boxes: [r.vendor.bbox ?? null, r.date.bbox ?? null, r.amount.bbox ?? null],
              annotatedKey: r.annotatedKey ?? null,
              annotated: ann ? { kind: ann.kind, size: ann.blob.size } : null,
              dups: (r.flags || [])
                .filter((f) => f.code === "duplicate")
                .map((f) => ({ ref: f.ref ?? null, message: f.message })),
            };
          }
          db.close();
          return out;
        }, [seeded.legacyId, seeded.pairId, seeded.coffeeId, seeded.gasId]);

      await page.getByRole("button", { name: "Settings" }).click();
      const settings = page.getByRole("dialog", { name: "Settings" });
      await settings.waitFor({ timeout: 5000 });
      const recheck = settings.getByRole("button", { name: "Re-check this batch" });
      await recheck.click({ timeout: 10000 });
      await page
        .getByText("Added outlines to 1 older AI read and flagged 2 possible duplicates.", { exact: true })
        .waitFor({ timeout: 20000 });
      check(true, "Re-check reports what it healed (1 set of outlines, 2 duplicate flags)");

      const healed = await readSeeded();
      const legacy = healed[seeded.legacyId] ?? {};
      const pair = healed[seeded.pairId] ?? {};
      const [vBox, dBox, aBox] = legacy.boxes ?? [];
      check(!!vBox && !!dBox && !!aBox, `legacy AI read: vendor/date/amount outlined (got ${JSON.stringify(legacy.boxes)})`);
      // Same stored lines as the coffee read → each box sits on the line the
      // rules read that value from.
      const sameLine = (a, b) => !!a && !!b && a.y < b.y + b.h && b.y < a.y + a.h;
      check(
        [vBox, dBox, aBox].every((b, i) => sameLine(b, seeded.coffeeBoxes[i])),
        "legacy AI read: each outline sits on the line that prints its value",
      );
      check(
        !!legacy.annotatedKey && legacy.annotated?.kind === "annotated" && legacy.annotated.size > 0,
        `legacy AI read: the annotated copy is baked and stored (${legacy.annotatedKey})`,
      );
      check(
        legacy.ocrText === seeded.answer &&
          legacy.methodUsed === "paid" &&
          JSON.stringify(legacy.values) === JSON.stringify(seeded.values),
        "legacy AI read: values, method and ocrText untouched (no OCR, no AI call)",
      );
      check(
        legacy.dups?.length === 1 && legacy.dups[0].ref === seeded.coffeeId && legacy.status === "needs_review",
        `legacy AI read: flagged as the coffee receipt's copy and sent to review (${JSON.stringify(legacy.dups)} [${legacy.status}])`,
      );
      check(
        pair.dups?.length === 1 && pair.dups[0].ref === seeded.gasId && pair.status === "needs_review",
        `missed pair: "Shell Oil #42" flagged against "${seeded.gasVendor}" by id, sent to review (${JSON.stringify(pair.dups)} [${pair.status}])`,
      );
      check(
        healed[seeded.coffeeId]?.dups.length === 0 && healed[seeded.gasId]?.dups.length === 0,
        "the originals gain no flag — only the copy read second holds it",
      );

      await recheck.click({ timeout: 10000 });
      await page.getByText("Nothing to fix — this batch is up to date.", { exact: true }).waitFor({ timeout: 20000 });
      check(true, "a second re-check finds nothing to fix");
      await page.keyboard.press("Escape");
      await settings.waitFor({ state: "hidden", timeout: 5000 });

      // Delete both seeds from review (row + blobs): back to 7 receipts.
      await page.waitForFunction(() => document.querySelectorAll(".rc").length === 9, { timeout: 15000 });
      const review = page.getByRole("dialog", { name: /Review receipt/ });
      for (const name of ["fuel_06-12-26_shell_oil_42.jpg", "meals_03-14-26_legacy_ai_seed.jpg"]) {
        await page.locator(".rc", { hasText: name }).click();
        await review.waitFor({ timeout: 10000 });
        await review.getByRole("button", { name: "Delete", exact: true }).click();
        await page.waitForFunction(
          (n) => ![...document.querySelectorAll(".rc .fname")].some((el) => el.textContent === n),
          name,
          { timeout: 15000 },
        );
        await page.keyboard.press("Escape");
        await review.waitFor({ state: "hidden", timeout: 5000 });
      }
      await page.waitForFunction(() => document.querySelectorAll(".rc").length === 7, { timeout: 15000 });
      const gone = await readSeeded();
      const leftBlobs = await page.evaluate(async (keys) => {
        const open = indexedDB.open("reimbursements-f5");
        const db = await new Promise((res, rej) => {
          open.onsuccess = () => res(open.result);
          open.onerror = () => rej(open.error);
        });
        const tx = db.transaction("blobs", "readonly");
        const found = [];
        for (const k of keys) {
          const rec = await new Promise((res) => {
            const r = tx.objectStore("blobs").get(k);
            r.onsuccess = () => res(r.result);
          });
          if (rec) found.push(k);
        }
        db.close();
        return found;
      }, [...seeded.blobKeys, legacy.annotatedKey].filter(Boolean));
      check(
        gone[seeded.legacyId] === null && gone[seeded.pairId] === null && leftBlobs.length === 0,
        `the seeds are deleted with their images (left blobs: ${leftBlobs.join(", ") || "none"})`,
      );
    }

    // 8. Header brand navigates home; the hero offers the way back.
    await page.locator("header.ws-head .brand").click();
    await page.getByRole("heading", { name: /Receipts in/ }).waitFor({ timeout: 10000 });
    check(true, "brand click returns to the landing page");
    await page.getByRole("button", { name: /Back to your receipts \(7\)/ }).click();
    await page.getByText("Drop receipts here").waitFor({ timeout: 10000 });
    check(true, "landing offers the way back to the workspace");

    // 8b. Phone width: neither surface may overflow the viewport sideways
    // (contentWidth, above 7c).
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
    // Settings from the landing: the nav's gear opens the same App-level
    // dialog, without touching the hash or leaving the landing.
    const gear = page.getByRole("button", { name: "Settings", exact: true });
    await gear.click();
    await settingsDialog.waitFor({ timeout: 5000 });
    check(true, "Settings opens from the landing nav at phone width");
    check(
      (await page.locator("input[type=file][multiple]").count()) === 1,
      "the landing's picker stays the page's only multi-file input with Settings open",
    );
    // A file dragged over the open dialog (Brands' logo picker) must not
    // raise the page-wide drop veil over it.
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "logo.png", { type: "image/png" }));
      window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    check((await page.locator(".drop-veil").count()) === 0, "a file drag over open Settings raises no drop veil");
    await page.keyboard.press("Escape");
    await settingsDialog.waitFor({ state: "hidden", timeout: 5000 });
    check(
      await gear.evaluate((el) => el === document.activeElement),
      "closing Settings returns focus to the landing gear",
    );
    check((await page.evaluate(() => location.hash)) !== "#process", "Settings on the landing leaves the hash alone");
    check(
      await page.getByRole("heading", { name: /Receipts in/ }).isVisible(),
      "the landing stays put under Settings",
    );
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

    // Touch: ONE tap opens a How step. Chromium fires a compat mouseenter
    // before the tap's click, so a hover-open handler plus the click's
    // toggle closed the step again (two taps per step on Android).
    {
      const touch = await browser.newContext({ ...devices["Pixel 7"] });
      const tp = await touch.newPage();
      await tp.goto(BASE, { waitUntil: "load" });
      const second = tp.locator("#how .steps li:nth-child(2) details");
      await second.locator("summary").tap();
      check(await second.evaluate((d) => d.open), "one tap opens a How step on a touch device");
      await touch.close();
    }
    // …and a real mouse hover still opens one without a click. A fresh
    // context: the main one holds receipts, so its origin boots straight
    // into the workspace.
    {
      const mouse = await browser.newContext();
      const hp = await mouse.newPage();
      await hp.goto(BASE, { waitUntil: "load" });
      const third = hp.locator("#how .steps li:nth-child(3) details");
      await third.locator("summary").hover();
      check(await third.evaluate((d) => d.open), "hovering a How step with a mouse opens it");
      await mouse.close();
    }

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
