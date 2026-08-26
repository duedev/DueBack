<script lang="ts">
  import { app } from "./state.svelte.ts";
  import ThemeToggle from "./ThemeToggle.svelte";
  import Hero from "./landing/Hero.svelte";
  import HowSection from "./landing/HowSection.svelte";
  import LogoSection from "./landing/LogoSection.svelte";
  import WorkbookSection from "./landing/WorkbookSection.svelte";
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

  /* ---- one page, anchored -------------------------------------------------
     The landing is a single scrolling document: the nav links are plain
     anchors, and every hash the five-page era (or older) ever handed out
     still lands on the section that hosts that content today. A hash that
     points at a FAQ <details> pops it open before scrolling; the sticky
     nav's height is cleared by scroll-margin-top (landing.css). */
  const NAV = [
    { id: "how", label: "How it works" },
    { id: "workbook", label: "Workbook" },
    { id: "faq", label: "FAQ" },
    { id: "contact", label: "Contact" },
  ];
  /** legacy hash → the id hosting it today ("" = top of page) */
  const ANCHOR_FOR_HASH: Record<string, string> = {
    home: "",
    how: "how",
    features: "how",
    time: "how",
    logos: "logos",
    workbook: "workbook",
    privacy: "privacy",
    account: "account",
    faq: "faq",
    help: "faq",
    contact: "contact",
  };

  function applyHash(initial = false): void {
    const raw = location.hash.replace(/^#\/?/, "");
    if (!raw) return; // no target — stay put
    const id = ANCHOR_FOR_HASH[raw] ?? raw;
    if (!id) {
      window.scrollTo(0, 0); // #home
      return;
    }
    const el = document.getElementById(id);
    if (!el) {
      if (!initial) window.scrollTo(0, 0);
      return;
    }
    if (el instanceof HTMLDetailsElement) el.open = true;
    el.scrollIntoView();
  }

  $effect(() => {
    const onHash = (): void => applyHash();
    window.addEventListener("hashchange", onHash);
    applyHash(true); // deep links land after mount, once the ids exist
    return () => window.removeEventListener("hashchange", onHash);
  });

  /* Scroll-spy: the nav link whose section crosses the upper reading band
     lights up. The hero is observed too — it has no id, so reaching the top
     naturally clears the highlight. */
  let activeId = $state("");
  $effect(() => {
    const targets = [
      document.querySelector<HTMLElement>(".landing .hero"),
      ...NAV.map((l) => document.getElementById(l.id)),
    ].filter((el): el is HTMLElement => el !== null);
    const spy = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) activeId = (e.target as HTMLElement).id;
        }
      },
      { rootMargin: "-15% 0px -75% 0px" },
    );
    targets.forEach((el) => spy.observe(el));
    return () => spy.disconnect();
  });

  /* The Your-data page lives on as FAQ answers; #privacy and #account keep
     resolving to the two entries that carry its substance. */
  const faqs: { q: string; a: string; id?: string }[] = [
    {
      q: "Is it really free?",
      a: "Yes. Receipts are read on your device with open-source OCR, so there is no per-receipt charge, no trial, no account. Optional boosters (an AI second opinion, cloud sync) are off by default.",
    },
    {
      id: "privacy",
      q: "Where do my receipts go?",
      a: "Nowhere, by default. Images are stored in your browser and processed on your device — the reading, the logo matching and the Excel build all run on your hardware. The hosted site counts visits anonymously (no cookies); your receipts and their contents are never part of that. If you sign in, your data syncs to your own private cloud workspace; if you enable the AI booster, low-confidence receipts go to the model you choose. Both are opt-in, clearly labeled, and off by default.",
    },
    {
      id: "account",
      q: "What does signing in add?",
      a: "A private workspace that follows you — nothing more. Reading still happens in your browser, but your batches, receipts and taught brands sync to your own cloud workspace, protected by row-level security, so you can pick up on any device. Signing in is one tap with Google or an email magic link (no new password), and it's entirely optional: skip it and everything simply stays on this device.",
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
      a: "Not yet — it's planned. Today you can sign in to keep batches, receipts and taught brands in your own private cloud workspace and pick up on any device. The plan: link a Drive folder, snap receipts into it from your phone as you go, and download an up-to-date workbook whenever you need one.",
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
  {#if dragging}
    <div class="drop-veil" aria-hidden="true">
      <div class="drop-box">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 16V4m0 0 4.5 4.5M12 4 7.5 8.5M4 16.5v2A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-2" />
        </svg>
        <strong>Drop your receipts</strong>
        <span>Photos, scans, PDFs or ZIP folders — read right on this device.</span>
      </div>
    </div>
  {/if}

  <!-- ======================= sticky anchor nav ======================= -->
  <div class="nav-bar">
    <nav class="wrap nav" aria-label="Site">
      <a class="brand" href="#home">
        <span class="brand-mark">DB</span>
        <span class="brand-name">DueBack</span>
      </a>
      <div class="nav-tabs">
        {#each NAV as l (l.id)}
          <a
            class="tab"
            class:active={activeId === l.id}
            href={"#" + l.id}
            aria-current={activeId === l.id ? "location" : undefined}
          >{l.label}</a>
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

  <Hero onAdd={pick} />

  <!-- ======================= the pitch, in one breath ================ -->
  <section class="wrap why">
    <p class="section-label">Why DueBack</p>
    <h2>Stop retyping vendors, dates and totals.</h2>
    <p>
      Snap or drop a pile — photos, scans, PDFs, even a whole ZIP. DueBack
      reads each receipt right in your browser, checks the math against the
      paper, and files everything into a report your office will accept. You
      only look at the few it flags.
    </p>
    <p>
      No account and no per-receipt fee. <strong>Receipts stay on your
      device</strong>, and your money gets back into your account faster.
      <a class="quiet-link" href="#privacy">Exactly what leaves your device, and when →</a>
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

  <HowSection />
  <LogoSection />
  <WorkbookSection />

  <section class="wrap last-cta">
    <div class="card cta-card">
      <h2>Got a pile of receipts?</h2>
      <p>You're about a minute away from a finished report.</p>
      <button class="btn btn-primary btn-lg" onclick={pick}>Add receipts</button>
    </div>
  </section>

  <!-- ======================= FAQ (incl. the Your-data story) ========= -->
  <section id="faq" class="wrap faq">
    <p class="section-label">FAQ</p>
    <h2>Questions, answered.</h2>
    {#each faqs as f (f.q)}
      <details class="card qa" id={f.id}>
        <summary>{f.q}</summary>
        <p>{f.a}</p>
      </details>
    {/each}
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

  <ContactSection />

  <footer class="wrap foot">
    <span>DueBack</span>
    <span class="foot-sep">·</span>
    <a href="https://github.com/duedev/DueBack" rel="noopener">GitHub</a>
    <span class="foot-sep">·</span>
    <span>MIT license</span>
    <span class="foot-sep">·</span>
    <span>Built by one person, with on-device AI.</span>
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

  /* ---- nav ---- */
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

  /* ---- why ---- */
  .why {
    padding-top: 1.2rem;
  }
  .why p {
    color: var(--ink-soft);
    max-width: 44rem;
    font-size: 1.02rem;
  }
  .why strong {
    color: var(--ink);
  }
  .quiet-link {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }
  .quiet-link:hover {
    text-decoration: underline;
  }

  /* ---- FAQ ---- */
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
    max-width: 52rem;
  }

  /* ---- closing CTA ---- */
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
