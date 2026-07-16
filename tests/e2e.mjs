// End-to-end smoke test against the real production build, driven through a
// headless Chromium. Proves the browser-only paths the unit tests can't:
// the landing hero, IndexedDB storage, canvas image-prep, on-device Tesseract
// OCR, the board/review UI, and xlsx export. Run with: node tests/e2e.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import ExcelJS from "exceljs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5179;
const BASE = `http://localhost:${PORT}/`;

const log = (...a) => console.log("•", ...a);
let failures = 0;
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

async function main() {
  log("starting preview server…");
  const server = spawn(
    "npx",
    ["vite", "preview", "--port", String(PORT), "--strictPort"],
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
      if (m.type() === "error") console.error("  [page error]", m.text());
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
      /^fuel_06-12-26_shell\.png$/.test(gas.renamed || ""),
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
    // Insights is opt-in (default off) — tick it so the dashboard assertions
    // below also gate the toggle itself.
    await page.getByText("Insights sheet", { exact: true }).click();
    const dlDir = await mkdtemp(join(tmpdir(), "reimb-"));
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60000 }),
      page.getByRole("button", { name: /Generate workbook/ }).click(),
    ]);
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
      if (v && typeof v === "object" && v.hyperlink) linkCount++;
    });
    check(linkCount === 4, `summary links every receipt to its image (got ${linkCount})`);

    // 7b. Images (.zip) packages every receipt image.
    const [zipDl] = await Promise.all([
      page.waitForEvent("download", { timeout: 60000 }),
      page.getByRole("button", { name: /Images \(\.zip\)/ }).click(),
    ]);
    const zipPath = join(dlDir, zipDl.suggestedFilename());
    await zipDl.saveAs(zipPath);
    const zipBytes = await (await import("node:fs/promises")).readFile(zipPath);
    check(
      zipBytes[0] === 0x50 && zipBytes[1] === 0x4b && /^Receipts_.*\.zip$/.test(zipDl.suggestedFilename()),
      `images zip downloads (${zipDl.suggestedFilename()}, ${zipBytes.length} bytes)`,
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

    // 8. Header brand navigates home; the hero offers the way back.
    await page.locator("header.ws-head .brand").click();
    await page.getByRole("heading", { name: /Receipts in/ }).waitFor({ timeout: 10000 });
    check(true, "brand click returns to the landing page");
    await page.getByRole("button", { name: /Back to your receipts \(6\)/ }).click();
    await page.getByText("Drop receipts here").waitFor({ timeout: 10000 });
    check(true, "landing offers the way back to the workspace");

    // 9. Delete all receipts — immediate, no confirm dialog.
    await page.getByRole("button", { name: /Delete all/ }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".rc").length === 0,
      { timeout: 15000 },
    );
    const left = (await readRows()).length;
    check(left === 0, `delete-all clears the board and the store (left ${left})`);
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
