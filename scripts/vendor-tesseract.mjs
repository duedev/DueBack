// Copies the Tesseract worker + wasm core out of node_modules into
// public/vendor/tesseract/<tesseract.js version> so they are served
// same-origin under stable names — VERSIONED, because the service worker
// caches everything under /vendor/ CacheFirst for a year: an unversioned
// path kept serving the previous worker to a bundle built against the next
// tesseract.js, and OCR broke after every upgrade until the cache expired.
// Why not let the bundler handle it? The Emscripten ".wasm.js" loader fetches
// its sibling ".wasm" by name at runtime; content-hashed bundling breaks that.
// Serving the originals unhashed keeps the relative fetch intact and lets the
// app run fully offline (the service worker caches them on first use).
//
// Runs automatically before `dev` and `build`. The output is gitignored.
import { mkdir, copyFile, access, writeFile, stat, readFile, readdir, rm } from "node:fs/promises";
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

/** Where the worker + cores live under public/ (and dist/) for a given
 *  tesseract.js version. ocr.ts builds the same path from the
 *  `__TESSERACT_VERSION__` define in vite.config.ts — keep the three in sync
 *  (tests/vendor_tesseract.test.ts pins it). */
export function tesseractVendorDir(version) {
  return `vendor/tesseract/${version}`;
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..");
  const pkg = JSON.parse(
    await readFile(join(root, "node_modules", "tesseract.js", "package.json"), "utf8"),
  );
  const outDir = join(root, "public", tesseractVendorDir(pkg.version));
  // Drop stale version folders so dist/ doesn't ship every release ever vendored.
  const parent = join(root, "public", "vendor", "tesseract");
  await mkdir(parent, { recursive: true });
  for (const entry of await readdir(parent)) {
    if (entry !== pkg.version) await rm(join(parent, entry), { recursive: true, force: true });
  }
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
  console.log(`vendored ${files.length} Tesseract assets → public/${tesseractVendorDir(pkg.version)}`);

  // --- Language data -------------------------------------------------------
  // Fetch eng.traineddata.gz so OCR runs fully offline, same-origin, at $0 with
  // no third-party CDN at runtime. Tried in order; fatal if none are reachable,
  // because the built app has no runtime fallback — unless the build opts into
  // the CDN path with VITE_TESSDATA_LOCAL=0, which makes the skip harmless.
  const LANG = "eng";
  const tessDir = join(root, "public", "vendor", "tessdata", "4.0.0");
  await mkdir(tessDir, { recursive: true });
  const langFile = join(tessDir, `${LANG}.traineddata.gz`);

  // gzip magic bytes: a CDN error page served with HTTP 200, or a partial
  // write, would otherwise be vendored (and cached in browsers for a year).
  const looksGzip = (buf) => buf.length > 1_000_000 && buf[0] === 0x1f && buf[1] === 0x8b;
  let haveLang = false;
  try {
    const s = await stat(langFile);
    haveLang = s.size > 1_000_000 && looksGzip(await readFile(langFile));
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
        // A CDN that accepts the connection and stalls used to hang prebuild
        // for a CI job's whole 6-hour limit; the fallback source never ran.
        const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (!looksGzip(buf)) throw new Error("not a gzip payload (or suspiciously small)");
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
