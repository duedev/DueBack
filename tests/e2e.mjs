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

    // 2. Add a synthetic receipt straight from the hero CTA's file input.
    log("uploading synthetic receipt, running on-device OCR…");
    await page
      .locator('input[type=file][multiple]')
      .first()
      .setInputFiles({
        name: "receipt.png",
        mimeType: "image/png",
        buffer: await makeReceiptPng(),
      });

    // 3. Workspace board appears with the processing card.
    await page.getByText("Drop receipts here").waitFor({ timeout: 10000 });
    check(true, "workspace rendered after adding a file");

    // 4. Wait for the card to show a parsed amount.
    await page.waitForFunction(
      () => {
        const e = document.querySelector(".rc .amount");
        return e && /\d/.test(e.textContent || "");
      },
      { timeout: 120000 },
    );
    const amountText = (await page.locator(".rc .amount").first().textContent())?.trim();
    const vendorText = (await page.locator(".rc .vendor").first().textContent())?.trim();
    log(`extracted → vendor="${vendorText}" amount="${amountText}"`);
    check(/8\.99/.test(amountText || ""), `OCR+rules read the total (got ${amountText})`);
    check(/BLUE|BOTTLE|COFFEE/i.test(vendorText || ""), `OCR+rules read the vendor (got ${vendorText})`);

    // 5. Verify the receipt persisted in IndexedDB with category + cost.
    const dbInfo = await page.evaluate(async () => {
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
      return all.map((r) => ({ cat: r.category.value, cost: r.cost, method: r.methodUsed }));
    });
    check(dbInfo.length === 1, "one receipt stored in IndexedDB");
    check(dbInfo[0]?.cost === 0 && dbInfo[0]?.method === "rules", "recorded as free (rules, $0)");
    check(dbInfo[0]?.cat === "Meals & Entertainment", `categorized (got ${dbInfo[0]?.cat})`);

    // 6. Review modal: open the card, check markers/fields, approve.
    await page.locator(".rc").first().click();
    await page.getByRole("dialog", { name: /Review receipt/ }).waitFor({ timeout: 10000 });
    check(true, "review modal opened");
    const approve = page.getByRole("button", { name: /Approve/ });
    await approve.click();
    await page.getByRole("dialog", { name: /Review receipt/ }).waitFor({ state: "hidden", timeout: 10000 });
    check(true, "approve & next sweep closes when done");

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
      names.includes("Meals & Entertainment"),
      `workbook has the category sheet (sheets: ${names.join(", ")})`,
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
