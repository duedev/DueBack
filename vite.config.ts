import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { VitePWA } from "vite-plugin-pwa";

// Static, client-side-only app. `base: "./"` keeps every asset reference
// relative so the same build works whether it is served from a domain root
// (Netlify/Vercel), a project subpath (GitHub Pages), or inside an embed
// iframe (Carrd) — no config needed.
export default defineConfig({
  base: "./",
  // Inject the optional built-in OpenRouter free key at build time so it lives
  // in your deployment's bundle, never in source. Set OPENROUTER_API_KEY (or
  // VITE_OPENROUTER_FREE_KEY) in the build env to enable the zero-click free
  // vision tier; omit it to keep everything on-device. (dist/ is gitignored.)
  define: {
    __OPENROUTER_FREE_KEY__: JSON.stringify(
      process.env.OPENROUTER_API_KEY ?? process.env.VITE_OPENROUTER_FREE_KEY ?? "",
    ),
  },
  build: {
    target: "es2022",
    // The Tesseract OCR core is a ~3.4 MB wasm payload; let Workbox precache it
    // so the app works fully offline after the first visit.
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
        name: "Reimbursements F5",
        short_name: "Reimburse",
        description:
          "Receipts in. Reimbursement report out. On-device OCR + logo recognition, polished Excel export, optional cloud sync.",
        theme_color: "#12100e",
        background_color: "#12100e",
        display: "standalone",
        orientation: "portrait",
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
        // are runtime-cached on first use (keeps install light).
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2,webmanifest}"],
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
});
