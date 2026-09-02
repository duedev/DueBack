import { defineConfig, loadEnv } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { VitePWA } from "vite-plugin-pwa";
import { createRequire } from "node:module";

// The vendored Tesseract worker/core live under a VERSIONED path
// (scripts/vendor-tesseract.mjs); ocr.ts needs the same version at runtime.
const TESSERACT_VERSION: string = createRequire(import.meta.url)(
  "tesseract.js/package.json",
).version;

// Static, client-side-only app. `base: "./"` keeps every asset reference
// relative so the same build works whether it is served from a domain root
// (Netlify/Vercel), a project subpath (GitHub Pages), or inside an embed
// iframe (Carrd) — no config needed.
export default defineConfig(({ mode }) => {
  // Vite only exposes VITE_-prefixed .env values to the app and never fills
  // process.env from .env files at config time, so the OPENROUTER_API_KEY line
  // .env.example documents was silently ignored unless exported in the shell.
  // loadEnv with an empty prefix reads every key; the real environment wins.
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  return {
    base: "./",
    // Inject the optional built-in OpenRouter free key at build time so it
    // lives in your deployment's bundle, never in source. Set
    // OPENROUTER_API_KEY (or VITE_OPENROUTER_FREE_KEY) in the build env or a
    // .env file to enable the zero-click free vision tier; omit it to keep
    // everything on-device. (dist/ is gitignored.)
    define: {
      __OPENROUTER_FREE_KEY__: JSON.stringify(
        env.OPENROUTER_API_KEY ?? env.VITE_OPENROUTER_FREE_KEY ?? "",
      ),
      __TESSERACT_VERSION__: JSON.stringify(TESSERACT_VERSION),
    },
    build: {
      target: "es2022",
      // The workbook chunk (ExcelJS + Chart.js) is ~1.2 MB by design — it is
      // lazy-loaded from the report bar. Warn on anything bigger than that
      // instead of the default 500 kB (the Tesseract cores live under
      // /vendor/, outside the bundle, and are runtime-cached, not precached).
      chunkSizeWarningLimit: 1500,
    },
    worker: {
      format: "es",
    },
    plugins: [
      svelte(),
      VitePWA({
        // "prompt", not "autoUpdate": autoUpdate forces skipWaiting +
        // clientsClaim, so a deploy purged the previous build's precache
        // under every open tab and its next lazy import (Generate, the PDF
        // renderer, the ZIP reader) 404'd. The waiting build now stays put
        // until the user takes the reload bar (main.ts registerSW).
        registerType: "prompt",
        includeAssets: ["icons/favicon.svg", "icons/apple-touch-icon.png"],
        manifest: {
          // A stable identity: without `id`, Chromium derives it from
          // start_url, and any later change there orphans installed copies.
          id: "./",
          name: "DueBack",
          short_name: "DueBack",
          categories: ["productivity", "finance", "business"],
          description:
            "Receipts in. Report out. On-device OCR + logo recognition, polished Excel export, optional cloud sync.",
          theme_color: "#12100e",
          background_color: "#12100e",
          display: "standalone",
          start_url: "./",
          scope: "./",
          icons: [
            { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
            {
              src: "icons/icon-maskable-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          // App chunks (exceljs, pdf.js) can exceed the 2 MB default.
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
          // Precache the small app shell only; the multi-MB OCR/embedding models
          // are runtime-cached on first use (keeps install light). `.mjs` is
          // the pdf.js worker: without it PDF intake 404ed offline — the one
          // intake path the "works offline after the first visit" promise
          // was silently missing.
          globPatterns: ["**/*.{js,mjs,css,html,svg,png,ico,woff2,webmanifest}"],
          globIgnores: [
            "**/vendor/**",
            // The share image is for link previews, not for every install's precache.
            "**/og.png",
            // Font subsets an English UI never selects (unicode-range fetches
            // them on demand online): ~185 KB per install otherwise.
            "**/*-cyrillic*",
            "**/*-greek*",
            "**/*-vietnamese*",
            "**/*-math-*",
            "**/*-symbols-*",
            // The CLIP runtime chunk is lazy and inert while the logo index is
            // empty; it is runtime-cached on first use instead (below).
            "**/transformers.web-*.js",
          ],
          runtimeCaching: [
            {
              // Same-origin OCR worker, wasm cores, and language data: cache on
              // first use so every later (and offline) run is free.
              urlPattern: ({ url }) => url.pathname.includes("/vendor/"),
              handler: "CacheFirst",
              options: {
                cacheName: "ocr-assets",
                expiration: { maxEntries: 24, maxAgeSeconds: 60 * 60 * 24 * 365 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              // OCR language data CDN fallback; cache it forever.
              urlPattern: /^https:\/\/tessdata\.projectnaptha\.com\/.*/i,
              handler: "CacheFirst",
              options: {
                cacheName: "tesseract-langdata",
                expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              // The logo layer's own code: the transformers.js chunk and the
              // same-origin ONNX runtime wasm it resolves via import.meta.url
              // (23 MB — never precached). Cached on first use so recognition
              // keeps working offline once it has run.
              urlPattern: ({ url }) =>
                /\/assets\/(transformers\.web-|ort-wasm)/.test(url.pathname),
              handler: "CacheFirst",
              options: {
                cacheName: "logo-model",
                expiration: { maxEntries: 24, maxAgeSeconds: 60 * 60 * 24 * 365 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              // CLIP embedding model weights (visual logo recognition), fetched
              // from the Hugging Face CDN on first use; cache forever.
              urlPattern: /^https:\/\/(huggingface\.co|cdn-lfs.*\.huggingface\.co)\/.*/i,
              handler: "CacheFirst",
              options: {
                cacheName: "logo-model",
                expiration: { maxEntries: 24, maxAgeSeconds: 60 * 60 * 24 * 365 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
        devOptions: { enabled: false },
      }),
    ],
  };
});
