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
      // The Tesseract OCR core is a ~3.4 MB wasm payload; let Workbox precache
      // it so the app works fully offline after the first visit.
      chunkSizeWarningLimit: 6000,
    },
    worker: {
      format: "es",
    },
    plugins: [
      svelte(),
      VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["icons/favicon.svg", "icons/apple-touch-icon.png"],
        manifest: {
          name: "DueBack",
          short_name: "DueBack",
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
          globIgnores: ["**/vendor/**"],
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
