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
          file: r.fileName,
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
    check(coffee.cat === "Meals & Entertainment", `coffee: categorized (got ${coffee.cat})`);
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

    // 6. Review modal: open the first card and approve through the sweep.
    await page.locator(".rc").first().click();
    await page.getByRole("dialog", { name: /Review receipt/ }).waitFor({ timeout: 10000 });
    check(true, "review modal opened");
    const dialog = page.getByRole("dialog", { name: /Review receipt/ });
    for (let i = 0; i < 5 && (await dialog.isVisible()); i++) {
      await page.getByRole("button", { name: /Approve/ }).click();
      await page.waitForTimeout(500);
    }
    check(!(await dialog.isVisible()), "approve & next sweep closes when done");

    // 7. Generate the spreadsheet and validate the downloaded workbook.
    await page.locator("#xb-emp").fill("Ada Lovelace");
    await page.locator("#xb-job").fill("Q1 Coffee Run");
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
    check(names.includes("All Receipts"), "workbook has All Receipts sheet");
    check(
      names.includes("Meals & Entertainment") && names.includes("Fuel"),
      `workbook has the category sheets (sheets: ${names.join(", ")})`,
    );
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
