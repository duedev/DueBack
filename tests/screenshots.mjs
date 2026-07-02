// Screenshot pass over the production build: landing (light/dark, desktop/
// mobile) and the workspace with a processed receipt. Outputs to tmp/shots/.
// Run with: node tests/screenshots.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, access } from "node:fs/promises";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "tmp", "shots");
const PORT = 5181;
const BASE = `http://localhost:${PORT}/`;

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
    } catch {}
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
    </g>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = spawn(
    "npx",
    ["vite", "preview", "--port", String(PORT), "--strictPort"],
    { cwd: root, stdio: "ignore" },
  );
  let browser;
  try {
    await waitForServer(BASE);
    browser = await launchBrowser();

    const shots = [
      { name: "landing-desktop-light", vp: { width: 1440, height: 960 }, scheme: "light" },
      { name: "landing-desktop-dark", vp: { width: 1440, height: 960 }, scheme: "dark" },
      { name: "landing-mobile-light", vp: { width: 390, height: 844 }, scheme: "light" },
      { name: "landing-mobile-dark", vp: { width: 390, height: 844 }, scheme: "dark" },
    ];
    for (const s of shots) {
      const ctx = await browser.newContext({ viewport: s.vp, colorScheme: s.scheme });
      const page = await ctx.newPage();
      await page.goto(BASE, { waitUntil: "load" });
      await page.getByRole("heading", { name: /Receipts in/ }).waitFor({ timeout: 15000 });
      await page.waitForTimeout(600); // fonts settle
      await page.screenshot({ path: join(OUT, `${s.name}.png`), fullPage: true });
      console.log("•", s.name);
      await ctx.close();
    }

    // Workspace with a processed receipt + review modal (desktop light).
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      colorScheme: "light",
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "load" });
    await page.getByRole("heading", { name: /Receipts in/ }).waitFor({ timeout: 15000 });
    await page.locator("input[type=file][multiple]").first().setInputFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: await makeReceiptPng(),
    });
    await page.waitForFunction(
      () => /\d/.test(document.querySelector(".rc .amount")?.textContent || ""),
      { timeout: 120000 },
    );
    await page.screenshot({ path: join(OUT, "workspace.png"), fullPage: true });
    console.log("•", "workspace");
    await page.locator(".rc").first().click();
    await page.getByRole("dialog", { name: /Review receipt/ }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, "review-modal.png") });
    console.log("•", "review-modal");
    await ctx.close();

    console.log(`\nScreenshots → ${OUT}`);
  } finally {
    if (browser) await browser.close();
    server.kill("SIGKILL");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
