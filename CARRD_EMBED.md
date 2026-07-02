# Embedding in Carrd (or any site)

The app builds to a single static bundle with **relative asset paths**, so it
works from a domain root, a GitHub Pages subpath, or inside an iframe.

## Recommended: iframe embed

1. Deploy the app (GitHub Pages via the included workflow, or Netlify/Cloudflare
   Pages — just publish `dist/`).
2. In Carrd (Pro plan for embeds), add an **Embed** element → *Code*:

```html
<iframe
  src="https://YOUR-PAGES-URL/"
  style="width:100%;min-height:100dvh;border:0;border-radius:12px"
  allow="camera"
  title="Reimbursements F5">
</iframe>
```

`allow="camera"` keeps the phone-camera capture working inside the frame.

## Notes

- **Storage:** receipts live in the iframe origin's IndexedDB — the same data
  appears whether users visit the app directly or through the Carrd page.
- **Sign-in (if you enabled Supabase sync):** add the Carrd page URL *and* the
  app origin to Supabase **Auth → Redirect URLs**. OAuth pop-ups can be blocked
  inside iframes on some browsers; the magic-link email flow always works.
- **A full-page link is a fine fallback** — a Carrd button pointing at the
  deployed URL gives the identical app, full-screen and installable (PWA).
