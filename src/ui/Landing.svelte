<script lang="ts">
  import { tick } from "svelte";
  import { app } from "./state.svelte.ts";
  import ThemeToggle from "./ThemeToggle.svelte";
  import BrandLogo from "./BrandLogo.svelte";
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

  /* ---- page-wide drop ----------------------------------------------------
     Testers dragged receipts straight onto the landing, so the whole
     document is the drop target — not a box you have to aim at. A window
     drag carrying files raises a full-page veil (pointer-events: none, so
     the drop still lands on window), and dropping anywhere ingests via the
     same addFiles path as the pickers (which auto-enters the workspace).
     Depth-counted because dragenter/dragleave fire per element crossed;
     listeners live here so they vanish with the landing on unmount. */
  let dragDepth = $state(0);
  const dragging = $derived(dragDepth > 0);

  function dragHasFiles(e: DragEvent): boolean {
    return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
  }

  $effect(() => {
    const enter = (e: DragEvent): void => {
      if (dragHasFiles(e)) dragDepth += 1;
    };
    const leave = (e: DragEvent): void => {
      if (dragHasFiles(e)) dragDepth = Math.max(0, dragDepth - 1);
    };
    const over = (e: DragEvent): void => {
      if (dragHasFiles(e)) e.preventDefault(); // required to allow the drop
    };
    const drop = (e: DragEvent): void => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      const files = e.dataTransfer?.files;
      if (files?.length) void app.addFiles(files);
    };
    const end = (): void => {
      dragDepth = 0; // cancelled drags (Esc) don't always pair leave events
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    window.addEventListener("dragend", end);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragend", end);
    };
  });

  /* ---- the "pages" -------------------------------------------------------
     One document, five pages: the hash is the router, so every page is a
     real URL and back/forward work. All pages STAY MOUNTED (hidden, not
     removed) — the contact form keeps its draft across page switches, and
     the e2e's landing assertions (hero h1, #contact form, the single file
     input) hold on first render. Old section anchors keep working: each is
     mapped to the page that now hosts it. */
  type PageId = "home" | "how" | "workbook" | "data" | "help" | "contact";
  const TABS: { id: PageId; hash: string; label: string }[] = [
    { id: "home", hash: "home", label: "Home" },
    { id: "how", hash: "how", label: "How it works" },
    { id: "workbook", hash: "workbook", label: "Excel workbook" },
    { id: "data", hash: "privacy", label: "Your data" },
    { id: "help", hash: "faq", label: "Help" },
    { id: "contact", hash: "contact", label: "Contact" },
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
    help: "help",
    roadmap: "help",
    contact: "contact",
  };

  let page = $state<PageId>("home");
  const baseTitle = document.title;

  async function applyHash(): Promise<void> {
    const raw = location.hash.replace(/^#\/?/, "");
    // #process belongs to the workspace: entering unmounts this component.
    if (raw === "process") {
      app.enter();
      return;
    }
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

  // Entries marked `nerd` describe future work and only render with Nerd
  // mode on — a visitor with the toggle off sees only what exists today.
  const faqs: { q: string; a: string; nerd?: boolean }[] = [
    {
      q: "Is it really free?",
      a: "Yes. Receipts are read on your device with open-source OCR, so there is no per-receipt charge, no trial and no account.",
    },
    {
      q: "Where do my receipts go?",
      a: "Nowhere. Images are stored in your browser and processed on your device. Close the tab and they're still there; clear your browser data and they're gone. Nothing is uploaded.",
    },
    {
      q: "What do I hand to my office?",
      a: "A polished multi-sheet Excel workbook: a summary that foots with real formulas, per-category sheets with the receipt images embedded and an insights dashboard. A print packet PDF of the receipts downloads alongside for offices that keep paper copies.",
    },
    {
      q: "What kinds of files work?",
      a: "JPEG, PNG and WebP photos plus PDFs (HEIC too on Safari). You can also drop in a ZIP: every receipt inside is unpacked no matter how deeply its folders nest, and a multi-page PDF becomes one receipt per page. Crumpled, faded and tilted receipts are straightened and cleaned up before reading.",
    },
    {
      q: "How does logo recognition help?",
      a: "Many receipts show the merchant only as a stylized logo the text reader can't spell. Teach the app a brand once with one clear photo of the logo in Settings. From then on it recognizes that logo visually, names the brand and files it in the right category.",
    },
    {
      q: "Can it watch a Google Drive or OneDrive folder?",
      a: "Not yet. Both are on the roadmap: automatic Drive-folder scanning that keeps a workbook current, and saving reports straight to OneDrive. The full roadmap is right below this FAQ.",
      nerd: true,
    },
    {
      q: "What is Nerd mode?",
      a: "The { } toggle in the top bar. It reveals engineering margin notes across the site (how the pipeline, sync and workbook actually work) plus the project roadmap here on the Help page. Purely informational, and it changes nothing about how the app runs.",
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

{#snippet ctaMini()}
  <div class="card cta-mini">
    <div class="cm-copy">
      <strong>Got a pile of receipts?</strong>
      <span class="muted">You're about a minute from a finished report.</span>
    </div>
    <button class="btn btn-primary" onclick={pick}>Add receipts</button>
  </div>
{/snippet}

<div class="landing" class:nerd-on={prefs.nerd}>
  {#if dragging}
    <div class="drop-veil" aria-hidden="true">
      <div class="drop-box">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 16V4m0 0 4.5 4.5M12 4 7.5 8.5M4 16.5v2A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-2" />
        </svg>
        <strong>Drop your receipts</strong>
        <span>Photos, scans, PDFs or ZIP folders, read right on this device.</span>
      </div>
    </div>
  {/if}

  <!-- ======================= nav / page tabs ======================= -->
  <div class="nav-bar">
    <nav class="wrap nav" aria-label="Site">
      <a class="brand" href="#home" aria-label="DueBack home">
        <BrandLogo size={30} />
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
          aria-label="Nerd mode"
          aria-pressed={prefs.nerd}
          onclick={() => prefs.toggleNerd()}
          title="Reveal the engineering margin notes"
        >
          <span class="nt-mark" aria-hidden="true">&#123;&nbsp;&#125;</span>
          <span class="nt-label">Nerd mode</span>
        </button>
        <ThemeToggle />
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
            check against the image. Approve or fix in a couple of clicks.
          </span>
          <span class="g-more">See the review →</span>
        </a>
        <a class="card glance-card" href="#workbook">
          <span class="g-n">3</span>
          <span class="g-title">Download the Excel workbook</span>
          <span class="g-deck">
            One click builds a themed Excel report with live totals and the
            receipt images embedded, plus a CSV if you need one.
          </span>
          <span class="g-more">See the Excel workbook →</span>
        </a>
      </div>
      <p class="trust-line">
        Local-first by design: receipts stay in your browser.
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
      <h2 class="page-title">From glovebox pile to checked and filed.</h2>
      <p class="page-deck">
        The three steps in detail: what you can throw at it, how the review
        keeps you honest, and how merchants that only sign with a logo still
        get named.
      </p>
    </header>

    <HowSection />
    <TimeSection />

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

    <LogoSection />

    <div class="wrap page-foot">
      {@render ctaMini()}
      <a class="next-link" href="#workbook">Next: The Excel workbook →</a>
    </div>
  </div>

  <!-- =================================================================
       PAGE · The workbook
       ================================================================= -->
  <div class="lpage" hidden={page !== "workbook"}>
    <header class="wrap page-head">
      <p class="page-no">03 · The Excel workbook</p>
      <h2 class="page-title">The deliverable, in detail.</h2>
      <p class="page-deck">
        What lands in your download folder, and why your office will take it
        without a second look.
      </p>
    </header>

    <WorkbookSection />

    <div class="wrap page-foot">
      {@render ctaMini()}
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
          <h4>The default path: nothing ever leaves this device</h4>
          <p>
            <strong>Images stay in your browser's storage.</strong> OCR, logo
            recognition, extraction and the Excel build all run on your
            hardware. Close the tab and it's still there; clear it and it's
            gone. The hosted site counts visits anonymously (Cloudflare Web
            Analytics, no cookies). Your receipts and their contents are never
            part of that.
          </p>
        </div>
        <figure class="priv-art" aria-hidden="true">
          <svg viewBox="0 0 330 200" fill="none">
            <!-- your browser window -->
            <rect x="12" y="14" width="176" height="154" rx="12" stroke="var(--line-strong)" stroke-width="1.5" fill="var(--bg-raised)" />
            <circle cx="31" cy="31" r="3" fill="var(--err)" opacity="0.5" />
            <circle cx="43" cy="31" r="3" fill="var(--gold)" opacity="0.5" />
            <circle cx="55" cy="31" r="3" fill="var(--ok)" opacity="0.5" />
            <line x1="13" y1="43" x2="187" y2="43" stroke="var(--line)" stroke-width="1.5" />
            <!-- the receipt, living inside it -->
            <g transform="translate(58 58)">
              <path d="M0 88 V6 a6 6 0 0 1 6 -6 h46 a6 6 0 0 1 6 6 v82 l-14.5 -9 -14.5 9 -14.5 -9 -14.5 9 z" fill="var(--bg)" stroke="var(--line-strong)" stroke-width="1.5" />
              <line x1="11" y1="19" x2="47" y2="19" stroke="var(--cat-3)" stroke-width="4.5" stroke-linecap="round" />
              <line x1="11" y1="34" x2="39" y2="34" stroke="var(--cat-4)" stroke-width="4.5" stroke-linecap="round" />
              <line x1="11" y1="49" x2="44" y2="49" stroke="var(--ok)" stroke-width="4.5" stroke-linecap="round" />
            </g>
            <!-- shield: it stays put -->
            <g transform="translate(152 118)">
              <path d="M19 0 l17 6.5 v13 c0 10.5 -7.5 19 -17 23.5 c-9.5 -4.5 -17 -13 -17 -23.5 v-13 z" fill="var(--accent)" />
              <path d="M11 20 l6.5 6.5 L29 13.5" stroke="var(--accent-ink)" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round" />
            </g>
            <!-- the cloud is dashed, padlocked, and off to the side -->
            <path d="M200 90 h42" stroke="var(--ink-faint)" stroke-width="2" stroke-dasharray="5 6" />
            <g transform="translate(246 62)">
              <path d="M20 44 h-4 a14 14 0 1 1 3 -27.7 a18 18 0 0 1 34.6 5.2 a12.5 12.5 0 0 1 -3.4 22.5 z" stroke="var(--ink-faint)" stroke-width="2" />
              <rect x="16" y="24" width="18" height="14" rx="3.5" fill="var(--ink-faint)" />
              <path d="M20 24 v-3 a5 5 0 0 1 10 0 v3" stroke="var(--ink-faint)" stroke-width="2.6" />
            </g>
            <text x="273" y="128" text-anchor="middle" font-size="10.5" font-weight="600" fill="var(--ink-soft)">locked until</text>
            <text x="273" y="141" text-anchor="middle" font-size="10.5" font-weight="600" fill="var(--ink-soft)">you opt in</text>
            <text x="100" y="188" text-anchor="middle" font-size="10.5" font-weight="600" fill="var(--ink-soft)">everything happens here</text>
          </svg>
        </figure>
        <div class="card priv db-nerd-only">
          <h4>Optional boosters</h4>
          <p class="priv-flow">
            <span class="chip">AI second opinion</span>
            <a class="chip" href="#account">cloud sync</a>
          </p>
          <p>
            These are rolling out now; the roadmap under Help tracks them.
            Once enabled, the AI assist sends low-confidence receipts to the
            model you configure, and signing in syncs your batches to your
            own private workspace behind row-level security. Both will
            always be opt-in and <strong>off by default</strong>.
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
          directions: a stale device can't clobber a newer edit, and deletes
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
      {@render ctaMini()}
      <a class="next-link" href="#faq">Next: Help →</a>
    </div>
  </div>

  <!-- =================================================================
       PAGE · Help
       ================================================================= -->
  <div class="lpage" hidden={page !== "help"}>
    <header class="wrap page-head">
      <p class="page-no">05 · Help</p>
      <h2 class="page-title">Questions, answered.</h2>
      <p class="page-deck">
        The short answers first. Need more? The Contact page is a direct
        line to the developer.
      </p>
    </header>

    <section id="faq" class="wrap faq">
      <p class="section-label">FAQ</p>
      <h2>Questions, answered.</h2>
      {#each faqs.filter((f) => !f.nerd || prefs.nerd) as f (f.q)}
        <details class="card qa">
          <summary>{f.q}</summary>
          <p>{f.a}</p>
        </details>
      {/each}
    </section>

    <!-- Roadmap: nerd-mode only (the { } toggle), like the margin notes. -->
    <section id="roadmap" class="wrap roadmap db-nerd-only" aria-label="Project roadmap">
      <p class="section-label">Roadmap</p>
      <h2>Where this is going.</h2>
      <div class="road-cols">
        <div class="card road">
          <span class="chip chip-ok">Shipped</span>
          <ul>
            <li>On-device reading: OCR, cleanup passes and total reconciliation</li>
            <li>Teach-a-brand visual logo recognition</li>
            <li>Themed Excel workbook, insights dashboard, CSV and image archive</li>
            <li>Installable app (PWA) that works offline</li>
          </ul>
        </div>
        <div class="card road">
          <span class="chip chip-warn">In progress</span>
          <ul>
            <li>Cloud sync: sign in and pick up your batches on any device</li>
            <li>AI second opinion for low-confidence receipts, behind a policed proxy</li>
            <li>Save the workbook straight to OneDrive</li>
          </ul>
        </div>
        <div class="card road">
          <span class="chip">Planned</span>
          <ul>
            <li>Google Drive folder watch: drop receipts in Drive, download a current workbook</li>
            <li>Stronger on-device OCR engine as a one-click booster</li>
            <li>Shared team workspaces</li>
          </ul>
        </div>
      </div>
      <p class="muted road-note">
        Dates on purpose absent: one developer, real job. Want something
        sooner? Say so below.
      </p>
    </section>

    <div class="wrap page-foot">
      {@render ctaMini()}
      <a class="next-link" href="#contact">Next: Contact →</a>
    </div>
  </div>

  <!-- =================================================================
       PAGE · Contact
       ================================================================= -->
  <div class="lpage" hidden={page !== "contact"}>
    <header class="wrap page-head">
      <p class="page-no">06 · Contact</p>
      <h2 class="page-title">A direct line to the developer.</h2>
      <p class="page-deck">
        No ticket system and no support queue: the form below opens an email
        straight to the person who built this.
      </p>
    </header>

    <ContactSection />

    <div class="wrap page-foot">
      {@render ctaMini()}
      <a class="next-link" href="#home">Back to the start →</a>
    </div>
  </div>

  <footer class="foot">
    <div class="wrap foot-in">
      <div class="foot-brand">
        <a class="foot-logo" href="#home" aria-label="DueBack home">
          <BrandLogo size={32} />
        </a>
        <p>
          Receipts in. Report out. Read on your device, filed into an Excel
          workbook your office will love.
        </p>
      </div>
      <nav class="foot-col" aria-label="Product pages">
        <h4>Product</h4>
        <a href="#how">How it works</a>
        <a href="#workbook">The Excel workbook</a>
        <a href="#privacy">Your data</a>
        <a href="#faq">Help &amp; FAQ</a>
      </nav>
      <nav class="foot-col" aria-label="Project links">
        <h4>Project</h4>
        <a href="https://github.com/duedev/DueBack" rel="noopener">GitHub</a>
        <a href="#contact">Contact</a>
        {#if prefs.nerd}<a href="#roadmap">Roadmap</a>{/if}
      </nav>
    </div>
  </footer>
</div>

<style>
  .landing {
    min-height: 100dvh;
  }

  /* ---- page-wide drop veil ---- */
  .drop-veil {
    position: fixed;
    inset: 0;
    z-index: 60; /* above the sticky nav (40) */
    display: grid;
    place-items: center;
    padding: 1.5rem;
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    pointer-events: none; /* visual only — the drop lands on window */
    animation: db-veil-in 0.18s ease-out both;
  }
  .drop-box {
    display: grid;
    justify-items: center;
    gap: 0.55rem;
    max-width: 26rem;
    text-align: center;
    padding: 2.4rem 2.6rem;
    border: 2px dashed var(--accent);
    border-radius: var(--radius-l);
    background: var(--bg-raised);
    color: var(--accent);
    box-shadow: var(--shadow-2);
  }
  .drop-box strong {
    font: 650 1.35rem/1.2 var(--font-display);
    color: var(--ink);
  }
  .drop-box span {
    font: 500 0.92rem/1.5 var(--font-ui);
    color: var(--ink-soft);
  }
  @keyframes db-veil-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    /* Static end-state: the veil simply shows. */
    .drop-veil {
      animation: none;
    }
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
    text-decoration: none;
    color: inherit;
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
  /* Phone widths: the first nav row (brand + actions) must fit the viewport —
     an overflowing row used to widen the page and let touch swipes pan it
     sideways. The wordmark and the Nerd-mode label give way; the DB mark and
     the { } glyph (aria-label keeps the name) carry the identity. */
  @media (max-width: 560px) {
    .nav {
      gap: 0.6rem;
    }
    .brand :global(.bl-name) {
      display: none;
    }
    .nerd-toggle .nt-label {
      display: none;
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
  /* The end-of-page ask: the same "Got a pile of receipts?" call to action
     on every page, compact enough not to shout. */
  .cta-mini {
    flex: 1 1 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    padding: 1.05rem 1.3rem;
  }
  .cm-copy {
    display: grid;
    gap: 0.1rem;
  }
  .cm-copy strong {
    font: 600 1.05rem/1.3 var(--font-display);
  }
  .cm-copy .muted {
    font-size: 0.88rem;
  }
  .next-link {
    margin-left: auto; /* the forward path reads from the right edge */
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
    align-items: stretch;
  }
  .priv-art {
    margin: 0;
    display: grid;
    align-content: center;
    padding: 0.6rem 0.4rem;
  }
  .priv-art svg {
    width: 100%;
    height: auto;
    max-width: 24rem;
    justify-self: center;
    font-family: var(--font-ui);
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
  /* ---- roadmap (nerd-mode only) ---- */
  .roadmap {
    padding-block: 1.8rem 0.4rem;
  }
  .road-cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 0.9rem;
    align-items: stretch;
  }
  .road {
    padding: 1.1rem 1.2rem;
    display: grid;
    gap: 0.7rem;
    align-content: start;
  }
  .road .chip {
    justify-self: start;
  }
  .road ul {
    margin: 0;
    padding-left: 1.1rem;
    display: grid;
    gap: 0.45rem;
    font-size: 0.92rem;
    color: var(--ink-soft);
  }
  .road-note {
    font-size: 0.85rem;
    margin-top: 0.9rem;
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

  /* ---- footer: brand + link columns over a legal line ---- */
  .foot {
    border-top: 1px solid var(--line);
    background: var(--bg-sunken);
    margin-top: 2rem;
  }
  .foot-in {
    display: grid;
    grid-template-columns: minmax(240px, 1.4fr) repeat(2, minmax(140px, 1fr));
    gap: 2rem;
    padding: 2.4rem 0 2.6rem;
  }
  .foot-brand {
    display: grid;
    gap: 0.8rem;
    align-content: start;
    justify-items: start;
  }
  .foot-logo {
    text-decoration: none;
    color: inherit;
  }
  .foot-brand p {
    margin: 0;
    color: var(--ink-soft);
    font-size: 0.9rem;
    max-width: 24rem;
  }
  .foot-col {
    display: grid;
    gap: 0.5rem;
    align-content: start;
    justify-items: start;
  }
  .foot-col h4 {
    font: 700 0.75rem/1 var(--font-ui);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-faint);
    margin: 0 0 0.3rem;
  }
  .foot-col a {
    font-size: 0.92rem;
    color: var(--ink-soft);
    text-decoration: none;
  }
  .foot-col a:hover {
    color: var(--accent);
    text-decoration: underline;
  }
  @media (max-width: 700px) {
    .foot-in {
      grid-template-columns: 1fr 1fr;
    }
    .foot-brand {
      grid-column: 1 / -1;
    }
  }
</style>
