// Social share image (Open Graph / Twitter card): 1200×630, the brand mark on
// the dark PWA ground with the tagline. Run with `npm run og`; commit the PNG.
// Text is drawn as SVG paths? No — as <text> in a generic sans-serif, so the
// exact letterforms depend on the runner's fonts; the composition (mark +
// receipt strip) carries the image even if a runner has no fonts at all.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public");
const svg = await readFile(join(pub, "icons", "favicon.svg"));

const W = 1200;
const H = 630;
const bg = "#12100e";
const MARK = 300;

const glyph = await sharp(svg).resize(MARK, MARK).png().toBuffer();

// A paper "receipt" strip on the right, echoing the landing's hero visual.
const strip = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect x="770" y="105" width="330" height="420" rx="14" fill="#f7f5f1"/>
  <rect x="800" y="150" width="140" height="18" rx="4" fill="#147246" opacity="0.9"/>
  <rect x="800" y="200" width="270" height="12" rx="3" fill="#d6d3d1"/>
  <rect x="800" y="232" width="220" height="12" rx="3" fill="#d6d3d1"/>
  <rect x="800" y="264" width="250" height="12" rx="3" fill="#d6d3d1"/>
  <rect x="800" y="330" width="270" height="1" fill="#c7c2b9"/>
  <rect x="800" y="360" width="90" height="16" rx="3" fill="#1c1917" opacity="0.8"/>
  <rect x="990" y="356" width="80" height="24" rx="5" fill="#147246"/>
  <g font-family="Inter, Helvetica, Arial, sans-serif" fill="#f7f5f1">
    <text x="90" y="480" font-size="84" font-weight="700">DueBack</text>
    <text x="92" y="552" font-size="34" font-weight="500" fill="#d6d3d1">Receipts in. Report out.</text>
  </g>
</svg>`);

await sharp({ create: { width: W, height: H, channels: 4, background: bg } })
  .composite([
    { input: glyph, top: 60, left: 90 },
    { input: strip, top: 0, left: 0 },
  ])
  .png()
  .toFile(join(pub, "og.png"));
console.log(`wrote public/og.png (${W}x${H})`);
