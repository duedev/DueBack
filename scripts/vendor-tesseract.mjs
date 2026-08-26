// Copies the Tesseract worker + wasm core out of node_modules into
// public/vendor/tesseract so they are served same-origin under stable names.
// Why not let the bundler handle it? The Emscripten ".wasm.js" loader fetches
// its sibling ".wasm" by name at runtime; content-hashed bundling breaks that.
// Serving the originals unhashed keeps the relative fetch intact and lets the
// app run fully offline (the service worker caches them on first use).
//
// Runs automatically before `dev` and `build`. The output is gitignored.
import { mkdir, copyFile, access, writeFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// Whether a failed language-data download must fail the build. There is NO
// runtime CDN fallback in the app (OCR.useLocal is compile-time; ocr.ts picks
// its langPath once), so a build that expects local tessdata but lacks it
// would deploy green with OCR 404ing for everyone. Only an explicit
// VITE_TESSDATA_LOCAL=0 (CDN mode) makes the skip non-fatal.
export function tessdataFailureIsFatal(env = process.env) {
  return env.VITE_TESSDATA_LOCAL !== "0";
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..");
  const outDir = join(root, "public", "vendor", "tesseract");
  await mkdir(outDir, { recursive: true });

  const coreDir = join(root, "node_modules", "tesseract.js-core");
  const distDir = join(root, "node_modules", "tesseract.js", "dist");

  // SIMD-LSTM is what modern browsers use; the plain LSTM pair is the fallback.
  const files = [
    [join(distDir, "worker.min.js"), "worker.min.js"],
    [join(coreDir, "tesseract-core-simd-lstm.wasm.js"), "tesseract-core-simd-lstm.wasm.js"],
    [join(coreDir, "tesseract-core-simd-lstm.wasm"), "tesseract-core-simd-lstm.wasm"],
    [join(coreDir, "tesseract-core-lstm.wasm.js"), "tesseract-core-lstm.wasm.js"],
    [join(coreDir, "tesseract-core-lstm.wasm"), "tesseract-core-lstm.wasm"],
  ];

  for (const [src, name] of files) {
    try {
      await access(src);
    } catch {
      console.error(`! missing ${src} — is tesseract.js installed?`);
      process.exit(1);
    }
    await copyFile(src, join(outDir, name));
  }
  console.log(`vendored ${files.length} Tesseract assets → public/vendor/tesseract`);

  // --- Language data -------------------------------------------------------
  // Fetch eng.traineddata.gz so OCR runs fully offline, same-origin, at $0 with
  // no third-party CDN at runtime. Tried in order; fatal if none are reachable,
  // because the built app has no runtime fallback — unless the build opts into
  // the CDN path with VITE_TESSDATA_LOCAL=0, which makes the skip harmless.
  const LANG = "eng";
  const tessDir = join(root, "public", "vendor", "tessdata", "4.0.0");
  await mkdir(tessDir, { recursive: true });
  const langFile = join(tessDir, `${LANG}.traineddata.gz`);

  let haveLang = false;
  try {
    const s = await stat(langFile);
    haveLang = s.size > 1_000_000; // sanity: real data is several MB
  } catch {
    /* not present yet */
  }

  if (!haveLang) {
    const sources = [
      `https://tessdata.projectnaptha.com/4.0.0/${LANG}.traineddata.gz`,
      `https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0/${LANG}.traineddata.gz`,
    ];
    let ok = false;
    for (const url of sources) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1_000_000) throw new Error("suspiciously small");
        await writeFile(langFile, buf);
        console.log(
          `vendored ${LANG}.traineddata.gz (${(buf.length / 1e6).toFixed(1)} MB) → public/vendor/tessdata/4.0.0`,
        );
        ok = true;
        break;
      } catch (err) {
        console.warn(`  · ${url} failed: ${err.message}`);
      }
    }
    if (!ok) {
      if (tessdataFailureIsFatal()) {
        console.error(
          "! could not vendor OCR language data, and this build expects it\n" +
            "  same-origin (there is no runtime CDN fallback — OCR would 404 for\n" +
            "  every user). Fix the network and retry, or build with\n" +
            "  VITE_TESSDATA_LOCAL=0 to serve language data from the public CDN.",
        );
        process.exit(1);
      }
      console.warn(
        "! could not vendor OCR language data — continuing because\n" +
          "  VITE_TESSDATA_LOCAL=0: the app fetches it from the public CDN at\n" +
          "  runtime.",
      );
    }
  } else {
    console.log(`language data already present → public/vendor/tessdata/4.0.0`);
  }
}

// Import-safe: tests import tessdataFailureIsFatal without running the vendor
// work (which copies files and may hit the network).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
