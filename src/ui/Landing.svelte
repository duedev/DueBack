<script lang="ts">
  import { tick } from "svelte";
  import { app } from "./state.svelte.ts";
  import ThemeToggle from "./ThemeToggle.svelte";
  import Hero from "./landing/Hero.svelte";
  import HowSection from "./landing/HowSection.svelte";
  import TimeSection from "./landing/TimeSection.svelte";
  import LogoSection from "./landing/LogoSection.svelte";
  import WorkbookSection from "./landing/WorkbookSection.svelte";
  import AccountSection from "./landing/AccountSection.svelte";
  import ContactSection from "./landing/ContactSection.svelte";
  import { prefs } from "./landing/prefs.svelte.ts";
  import { LIMITS } from "../config/constants.ts";
  import "./landing/landing.css";

  let fileInput = $state<HTMLInputElement | null>(null);

  function pick(): void {
    fileInput?.click();
  }

  function onPicked(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    // Copy the live FileList before clearing the input — resetting `value`
    // empties it while the async addFiles loop is still reading, silently
    // dropping every file after the first on a multi-select.
    const files = input.files ? Array.from(input.files) : [];
    input.value = "";
    if (files.length) void app.addFiles(files);
  }

  const accept = LIMITS.acceptedExtensions.join(",");

  /* ---- the "pages" -------------------------------------------------------
     One document, five pages: the hash is the router, so every page is a
     real URL and back/forward work. All pages STAY MOUNTED (hidden, not
     removed) — the contact form keeps its draft across page switches, and
     the e2e's landing assertions (hero h1, #contact form, the single file
     input) hold on first render. Old section anchors keep working: each is
     mapped to the page that now hosts it. */
  type PageId = "home" | "how" | "workbook" | "data" | "help";
  const TABS: { id: PageId; hash: string; label: string }[] = [
    { id: "home", hash: "home", label: "Home" },
    { id: "how", hash: "how", label: "How it works" },
    { id: "workbook", hash: "workbook", label: "The workbook" },
    { id: "data", hash: "privacy", label: "Your data" },
    { id: "help", hash: "faq", label: "Help" },
  ];
  const PAGE_FOR_HASH: Record<string, PageId> = {
    home: "home",
    how: "how",
    features: "how",
    time: "how",
    logos: "how",
    workbook: "workbook",
    privacy: "data",
    account: "data",
    faq: "help",
    contact: "help",
    help: "help",
  };

  let page = $state<PageId>("home");
  const baseTitle = document.title;

  async function applyHash(): Promise<void> {
    const raw = location.hash.replace(/^#\/?/, "");
    const target = PAGE_FOR_HASH[raw] ?? "home";
    const anchor = raw && raw !== target ? raw : null;
    page = target;
    await tick(); // the page must be un-hidden before it can be scrolled to
    if (anchor) document.getElementById(anchor)?.scrollIntoView();
    else window.scrollTo(0, 0);
  }

  $effect(() => {
    const onHash = (): void => void applyHash();
    window.addEventListener("hashchange", onHash);
    void applyHash();
    return () => window.removeEventListener("hashchange", onHash);
  });

  $effect(() => {
    const tab = TABS.find((t) => t.id === page);
    document.title =
      page === "home" || !tab ? baseTitle : `${tab.label} · ${baseTitle}`;
  });

  const faqs = [
    {
      q: "Is it really free?",
      a: "Yes. Receipts are read on your device with open-source OCR, so there is no per-receipt charge, no trial, no account. Optional boosters (an AI second opinion, cloud sync) are off by default.",
    },
    {
      q: "Where do my receipts go?",
      a: "Nowhere, by default. Images are stored in your browser and processed on your device. If you sign in (optional), your data syncs to your own private cloud workspace; if you enable the AI booster, low-confidence receipts are sent to the model you choose.",
    },
    {
      q: "What do I hand to my office?",
      a: "A polished multi-sheet Excel workbook: a summary that foots with real formulas, per-category sheets with the receipt images embedded, an insights sheet, plus a CSV if your system prefers imports.",
    },
    {
      q: "What kinds of files work?",
      a: "JPEG, PNG and WebP photos plus PDFs (HEIC too on Safari). You can also drop in a ZIP — every receipt inside is unpacked, however deeply its folders nest, and a multi-page PDF becomes one receipt per page. Snap receipts with your phone camera or drop in files; crumpled, faded and tilted receipts are straightened and cleaned up before reading.",
    },
    {
      q: "How does logo recognition help?",
      a: "Many receipts show the merchant only as a stylized logo the text reader can't spell. Teach the app a brand once with one clear photo of the logo in Settings, and from then on it recognizes that logo visually, names the brand, and files it in the right category.",
    },
    {
      q: "Can it watch a Google Drive folder?",
      a: "Not yet — it's planned. Today you can sign in to keep batches, receipts and taught brands in your own private cloud workspace and pick up on any device. Automatic Drive-folder scanning that keeps a workbook current is on the roadmap.",
    },
  ];
</script>

<input
  type="file"
  bind:this={fileInput}
  onchange={onPicked}
  {accept}
  multiple
  class="sr-only"
  aria-hidden="true"
  tabindex="-1"
/>

<div class="landing" class:nerd-on={prefs.nerd}>
  <!-- ======================= nav / page tabs ======================= -->
  <div class="nav-bar">
    <nav class="wrap nav" aria-label="Site">
      <a class="brand" href="#home">
        <span class="brand-mark">DB</span>
        <span class="brand-name">DueBack</span>
      </a>
      <div class="nav-tabs">
        {#each TABS as t (t.id)}
          <a
            class="tab"
            class:active={page === t.id}
            href={"#" + t.hash}
            aria-current={page === t.id ? "page" : undefined}
          >{t.label}</a>
        {/each}
      </div>
      <div class="nav-actions">
        <button
          class="nerd-toggle"
          aria-pressed={prefs.nerd}
          onclick={() => prefs.toggleNerd()}
          title="Reveal the engineering margin notes"
        >
          <span class="nt-mark" aria-hidden="true">&#123;&nbsp;&#125;</span>
          Nerd mode
        </button>
        <ThemeToggle />
        <button class="btn" onclick={() => app.enter()}>Open the app</button>
      </div>
    </nav>
  </div>

  <!-- =================================================================
       PAGE · Home — the whole pitch in three screens. Everything deeper
       lives on its own page.
       ================================================================= -->
  <div class="lpage" hidden={page !== "home"}>
    <Hero onAdd={pick} />

    <section class="wrap why">
      <p class="section-label">Why DueBack</p>
      <h2>From receipt pile to finished report, without the busywork.</h2>
      <p>
        Retyping vendors, dates and totals is data entry no one should still be
        doing by hand. Add your receipts and DueBack reads each one right in
        your browser, checks the totals against the paper, and files it into a
        report your office will accept.
      </p>
      <p>
        No account and no per-receipt fee. <strong>Receipts stay on your
        device</strong>, and your money gets back into your account faster.
      </p>
    </section>

    <section class="wrap glance">
      <p class="section-label">At a glance</p>
      <h2>Three steps. About a minute.</h2>
      <div class="glance-grid">
        <a class="card glance-card" href="#how">
          <span class="g-n">1</span>
          <span class="g-title">Snap or drop</span>
          <span class="g-deck">
            Phone camera, photos, scans, PDFs or a whole ZIP. Each receipt is
            straightened, cleaned and read on your device.
          </span>
          <span class="g-more">How it works →</span>
        </a>
        <a class="card glance-card" href="#how">
          <span class="g-n">2</span>
          <span class="g-title">Review the flagged few</span>
          <span class="g-deck">
            Most receipts file themselves. The uncertain ones queue for a quick
            check against the image — approve or fix in a couple of clicks.
          </span>
          <span class="g-more">See the review →</span>
        </a>
        <a class="card glance-card" href="#workbook">
          <span class="g-n">3</span>
          <span class="g-title">Download the workbook</span>
          <span class="g-deck">
            One click builds a themed Excel report with live totals and the
            receipt images embedded — plus a CSV if you need one.
          </span>
          <span class="g-more">See the workbook →</span>
        </a>
      </div>
      <p class="trust-line">
        Local-first by design — receipts stay in your browser.
        <a href="#privacy">Exactly what leaves your device, and when →</a>
      </p>
      <aside class="db-nerd" aria-label="Technical details">
        <span class="db-nerd-tag">nerd note · the stack</span>
        <p>
          Svelte 5 + TypeScript. OCR is Tesseract compiled to WebAssembly,
          running in the tab you're reading this in; an optional ONNX engine
          and a CLIP embedder (visual logo matching) load lazily. The workbook
          is built client-side with ExcelJS. Static hosting, no backend
          required, MIT-licensed.
        </p>
      </aside>
    </section>

    <section class="wrap last-cta">
      <div class="card cta-card">
        <h2>Got a pile of receipts?</h2>
        <p>You're about a minute away from a finished report.</p>
        <button class="btn btn-primary btn-lg" onclick={pick}>Add receipts</button>
      </div>
    </section>
  </div>

  <!-- =================================================================
       PAGE · How it works
       ================================================================= -->
  <div class="lpage" hidden={page !== "how"}>
    <header class="wrap page-head">
      <p class="page-no">02 · How it works</p>
      <h2 class="page-title">From glovebox pile to filed and checked.</h2>
      <p class="page-deck">
        The three steps in detail — what you can throw at it, how the review
        keeps you honest, and how merchants that only sign with a logo still
        get named.
      </p>
    </header>

    <HowSection />
    <TimeSection />
    <LogoSection />

    <section id="features" class="wrap features">
      <p class="section-label">What's inside</p>
      <h2>Small app. Serious pipeline.</h2>
      <div class="feat-grid">
        <div class="card feat">
          <h4>🧮 Totals that reconcile</h4>
          <p>
            Amounts are grounded in the printed grand total, cross-checked
            against line items and tax, and flagged when something doesn't foot.
          </p>
        </div>
        <div class="card feat">
          <h4>⌨️ Fast, honest review</h4>
          <p>
            A kanban board tracks every receipt; the review screen zooms into
            each field on the image and clears a batch with Approve&nbsp;&amp;&nbsp;Next.
          </p>
        </div>
        <div class="card feat">
          <h4>📖 Reads tough receipts</h4>
          <p>
            Open-source text recognition runs in your browser, with a second
            cleanup pass for unevenly lit photos and an optional stronger
            on-device engine. No servers, no upload.
          </p>
        </div>
      </div>
    </section>

    <div class="wrap page-foot">
      <button class="btn btn-primary" onclick={pick}>Add receipts</button>
      <a class="next-link" href="#workbook">Next: The workbook →</a>
    </div>
  </div>

  <!-- =================================================================
       PAGE · The workbook
       ================================================================= -->
  <div class="lpage" hidden={page !== "workbook"}>
    <header class="wrap page-head">
      <p class="page-no">03 · The workbook</p>
      <h2 class="page-title">The deliverable, in detail.</h2>
      <p class="page-deck">
        What lands in your download folder — and why your office will take it
        without a second look.
      </p>
    </header>

    <WorkbookSection />

    <div class="wrap page-foot">
      <button class="btn btn-primary" onclick={pick}>Add receipts</button>
      <a class="next-link" href="#privacy">Next: Your data →</a>
    </div>
  </div>

  <!-- =================================================================
       PAGE · Your data
       ================================================================= -->
  <div class="lpage" hidden={page !== "data"}>
    <header class="wrap page-head">
      <p class="page-no">04 · Your data</p>
      <h2 class="page-title">Where things live, and when they move.</h2>
      <p class="page-deck">
        The default is simple: nothing leaves your device. Everything beyond
        that is opt-in, labeled, and explained here.
      </p>
    </header>

    <section id="privacy" class="wrap privacy">
      <p class="section-label">Privacy</p>
      <h2>Local first. Cloud only when you say so.</h2>
      <div class="priv-cols">
        <div class="card priv">
          <h4>The default path</h4>
          <p class="priv-flow">
            <span class="chip chip-ok">your device</span>
            <span class="priv-arrow">→</span>
            <span class="chip chip-ok">your device</span>
          </p>
          <p>
            <strong>Images stay in your browser's storage.</strong> OCR, logo
            recognition, extraction and the Excel build all run on your
            hardware. Close the tab and it's still there; clear it and it's
            gone. The hosted site counts visits anonymously (Cloudflare Web
            Analytics, no cookies); your receipts and their contents are never
            part of that.
          </p>
        </div>
        <div class="card priv">
          <h4>Optional boosters</h4>
          <p class="priv-flow">
            <span class="chip">AI second opinion</span>
            <a class="chip" href="#account">cloud sync</a>
          </p>
          <p>
            Turn on the AI assist and low-confidence receipts go to the model you
            configure. Sign in and your batches sync to your own Supabase
            workspace, protected by row-level security. Both are opt-in, clearly
            labeled, and <strong>off by default</strong>.
          </p>
        </div>
      </div>
      <aside class="db-nerd" aria-label="Technical details">
        <span class="db-nerd-tag">nerd note · the sync contract</span>
        <p>
          Local-first means IndexedDB in your browser is the source of truth.
          Sign in and rows mirror to your own Supabase workspace behind
          row-level security (<strong>user_id = auth.uid()</strong>),
          reconciled last-write-wins on <strong>updatedAt</strong> in both
          directions — a stale device can't clobber a newer edit, and deletes
          propagate as tombstones so nothing you removed ever resurrects.
        </p>
        <p>
          The optional AI assist never sees a raw API key: calls route through
          a policed proxy with a model allowlist, a token cap, and a per-user
          daily limit.
        </p>
      </aside>
    </section>

    <AccountSection />

    <div class="wrap page-foot">
      <button class="btn btn-primary" onclick={pick}>Add receipts</button>
      <a class="next-link" href="#faq">Next: Help →</a>
    </div>
  </div>

  <!-- =================================================================
       PAGE · Help
       ================================================================= -->
  <div class="lpage" hidden={page !== "help"}>
    <header class="wrap page-head">
      <p class="page-no">05 · Help</p>
      <h2 class="page-title">Questions, answered — and a direct line.</h2>
      <p class="page-deck">
        The short answers first; if yours isn't here, the form below goes
        straight to the developer.
      </p>
    </header>

    <section id="faq" class="wrap faq">
      <p class="section-label">FAQ</p>
      <h2>Questions, answered.</h2>
      {#each faqs as f (f.q)}
        <details class="card qa">
          <summary>{f.q}</summary>
          <p>{f.a}</p>
        </details>
      {/each}
    </section>

    <ContactSection />

    <div class="wrap page-foot">
      <button class="btn btn-primary" onclick={pick}>Add receipts</button>
      <a class="next-link" href="#home">Back to the start →</a>
    </div>
  </div>

  <footer class="wrap foot">
    <span>DueBack</span>
    <span class="foot-sep">·</span>
    <a href="https://github.com/duedev/ReimbursementsF5" rel="noopener">GitHub</a>
    <span class="foot-sep">·</span>
    <span>MIT license</span>
    <span class="foot-sep">·</span>
    <span>
      Built by one person, with on-device AI — feedback goes straight to the
      developer.
    </span>
  </footer>
</div>

<style>
  .landing {
    min-height: 100dvh;
  }

  /* ---- nav / page tabs ---- */
  .nav-bar {
    position: sticky;
    top: 0;
    z-index: 40;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--line);
  }
  .nav {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 1.1rem;
    padding: 0.75rem 0;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    text-decoration: none;
    color: inherit;
  }
  .brand-mark {
    font: 600 1rem/1 var(--font-display);
    color: var(--accent-ink);
    background: var(--accent);
    border-radius: 9px;
    padding: 0.45rem 0.55rem;
  }
  .brand-name {
    font: 650 1.02rem/1 var(--font-ui);
    letter-spacing: -0.01em;
  }
  .nav-tabs {
    display: flex;
    justify-content: center;
    gap: 0.25rem;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .nav-tabs::-webkit-scrollbar {
    display: none;
  }
  .nav-tabs .tab {
    color: var(--ink-soft);
    text-decoration: none;
    font: 550 0.9rem/1 var(--font-ui);
    padding: 0.5rem 0.8rem;
    border-radius: var(--radius-pill);
    white-space: nowrap;
  }
  .nav-tabs .tab:hover {
    color: var(--ink);
    background: var(--bg-sunken);
  }
  .nav-tabs .tab.active {
    color: var(--accent);
    background: var(--accent-soft);
    font-weight: 650;
  }
  /* .nav-tabs scrolls horizontally, which clips the global outside focus
     halo — draw the ring inset. */
  .nav-tabs .tab:focus-visible {
    outline: none;
    box-shadow:
      inset 0 0 0 2px var(--bg),
      inset 0 0 0 4px var(--accent);
  }
  .nav-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .nerd-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    font: 600 0.8rem/1 var(--font-ui);
    color: var(--ink-soft);
    background: transparent;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-pill);
    padding: 0.45rem 0.75rem;
    cursor: pointer;
  }
  .nt-mark {
    font: 700 0.72rem/1 var(--font-mono);
    color: var(--ink-faint);
  }
  .nerd-toggle:hover {
    color: var(--ink);
    border-color: var(--accent-line);
  }
  .nerd-toggle[aria-pressed="true"] {
    color: var(--accent);
    background: var(--accent-soft);
    border-color: var(--accent-line);
  }
  .nerd-toggle[aria-pressed="true"] .nt-mark {
    color: var(--accent);
  }
  @media (max-width: 860px) {
    .nav {
      grid-template-columns: auto auto;
      justify-content: space-between;
    }
    /* Tabs drop to their own full-width row and scroll — never hidden. */
    .nav-tabs {
      grid-column: 1 / -1;
      grid-row: 2;
      justify-content: flex-start;
      margin: 0 -4px;
      padding: 0 4px 0.35rem;
    }
    .nerd-toggle {
      padding: 0.45rem 0.6rem;
    }
  }

  /* ---- page frame ---- */
  .lpage {
    animation: db-page-in 0.28s ease-out both;
  }
  .lpage[hidden] {
    display: none;
  }
  @keyframes db-page-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    /* Static end-state: pages appear in place, no slide. */
    .lpage {
      animation: none;
    }
  }

  .page-head {
    padding: 3rem 0 0;
  }
  .page-no {
    font: 600 0.75rem/1 var(--font-mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--accent);
    margin: 0 0 0.8rem;
  }
  .page-title {
    font-size: clamp(1.9rem, 4vw, 2.8rem);
    margin: 0 0 0.7rem;
  }
  .page-deck {
    color: var(--ink-soft);
    max-width: 42rem;
    font-size: 1.05rem;
    margin: 0;
  }

  .page-foot {
    display: flex;
    align-items: center;
    gap: 1.1rem;
    flex-wrap: wrap;
    padding: 0.4rem 0 3.4rem;
  }
  .next-link {
    font: 600 0.92rem/1 var(--font-ui);
    color: var(--accent);
    text-decoration: none;
  }
  .next-link:hover {
    text-decoration: underline;
  }

  /* ---- home sections ---- */
  .why {
    padding-top: 1rem;
  }
  .why p {
    color: var(--ink-soft);
    max-width: 44rem;
    font-size: 1.02rem;
  }
  .why strong {
    color: var(--ink);
  }

  .glance {
    padding-top: 0.6rem;
  }
  .glance-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 1rem;
  }
  .glance-card {
    display: grid;
    gap: 0.5rem;
    align-content: start;
    padding: 1.25rem 1.3rem 1.15rem;
    text-decoration: none;
    color: inherit;
    transition: border-color 0.15s ease;
  }
  .glance-card:hover {
    border-color: var(--accent-line);
  }
  .g-n {
    display: inline-grid;
    place-items: center;
    width: 1.9rem;
    height: 1.9rem;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    font: 700 0.9rem/1 var(--font-display);
  }
  .g-title {
    font: 650 1.02rem/1.3 var(--font-ui);
  }
  .g-deck {
    color: var(--ink-soft);
    font-size: 0.92rem;
    line-height: 1.55;
  }
  .g-more {
    font: 600 0.85rem/1 var(--font-ui);
    color: var(--accent);
    margin-top: 0.2rem;
  }
  .trust-line {
    color: var(--ink-soft);
    font-size: 0.95rem;
    margin: 1.4rem 0 0;
  }
  .trust-line a {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }
  .trust-line a:hover {
    text-decoration: underline;
  }

  /* ---- how page ---- */
  .feat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 1rem;
  }
  .feat {
    padding: 1.3rem 1.4rem 1.1rem;
  }
  .feat p {
    color: var(--ink-soft);
    margin: 0;
    font-size: 0.95rem;
  }

  /* ---- data page ---- */
  .priv-cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 1rem;
  }
  .priv {
    padding: 1.4rem;
  }
  .priv-flow {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .priv-flow a.chip {
    text-decoration: none;
  }
  .priv-flow a.chip:hover {
    color: var(--accent);
  }
  .priv-arrow {
    color: var(--ink-faint);
  }
  .priv p:last-of-type {
    color: var(--ink-soft);
    margin: 0.6rem 0 0;
    font-size: 0.95rem;
  }

  /* ---- help page ---- */
  .qa {
    padding: 0;
    margin-bottom: 0.7rem;
    overflow: hidden;
  }
  .qa summary {
    cursor: pointer;
    font: 600 1rem/1.3 var(--font-ui);
    padding: 1rem 1.2rem;
    list-style: none;
    position: relative;
  }
  .qa summary::-webkit-details-marker {
    display: none;
  }
  /* .qa's overflow:hidden clips the global focus ring — draw it inset. */
  .qa summary:focus-visible {
    box-shadow: inset 0 0 0 2px var(--bg), inset 0 0 0 4px var(--accent);
  }
  .qa summary::after {
    content: "+";
    position: absolute;
    right: 1.1rem;
    top: 50%;
    transform: translateY(-50%);
    color: var(--accent);
    font-size: 1.2rem;
  }
  .qa[open] summary::after {
    content: "–";
  }
  .qa p {
    padding: 0 1.2rem 1.1rem;
    margin: 0;
    color: var(--ink-soft);
    font-size: 0.95rem;
  }

  /* ---- shared ---- */
  .last-cta {
    padding-bottom: 2rem;
  }
  .cta-card {
    text-align: center;
    padding: 3rem 1.5rem;
    background:
      radial-gradient(
        60% 120% at 50% 0%,
        var(--accent-soft),
        transparent 70%
      ),
      var(--bg-raised);
  }
  .cta-card p {
    color: var(--ink-soft);
    margin-bottom: 1.4rem;
  }

  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: center;
    padding: 1.6rem 0 2.2rem;
    color: var(--ink-soft);
    font-size: 0.88rem;
  }
  .foot-sep {
    opacity: 0.5;
  }
</style>
