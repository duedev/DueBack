<script lang="ts">
  import { app } from "./state.svelte.ts";
  import ThemeToggle from "./ThemeToggle.svelte";
  import Hero from "./landing/Hero.svelte";
  import HowSection from "./landing/HowSection.svelte";
  import ContactSection from "./landing/ContactSection.svelte";
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
      a: "JPEG, PNG and WebP photos plus PDFs (HEIC too on Safari). Snap receipts with your phone camera or drop in files; crumpled, faded and tilted receipts are straightened and cleaned up before reading.",
    },
    {
      q: "How does logo recognition help?",
      a: "Many receipts show the merchant only as a stylized logo the text reader can't spell. Teach the app a brand once with one clear photo of the logo in Settings, and from then on it recognizes that logo visually, names the brand, and files it in the right category.",
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

<div class="landing">
  <!-- ======================= nav ======================= -->
  <nav class="wrap nav">
    <div class="brand">
      <span class="brand-mark">DB</span>
      <span class="brand-name">DueBack</span>
    </div>
    <div class="nav-links">
      <a href="#how">How it works</a>
      <a href="#features">Features</a>
      <a href="#privacy">Privacy</a>
      <a href="#faq">FAQ</a>
      <a href="#contact">Contact</a>
    </div>
    <div class="nav-actions">
      <ThemeToggle />
      <button class="btn" onclick={() => app.enter()}>Open the app</button>
    </div>
  </nav>

  <!-- ======================= hero ======================= -->
  <Hero onAdd={pick} />

  <!-- ======================= why ======================= -->
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

  <!-- ======================= how it works ======================= -->
  <HowSection />

  <!-- ======================= features ======================= -->
  <section id="features" class="wrap features">
    <p class="section-label">What's inside</p>
    <h2>Small app. Serious pipeline.</h2>
    <div class="feat-grid">
      <div class="card feat">
        <h4>📖 On-device OCR</h4>
        <p>
          Open-source text recognition runs in your browser, with an optional
          stronger on-device engine for tough photos. No servers, no upload.
        </p>
      </div>
      <div class="card feat">
        <h4>🔎 Visual logo recognition</h4>
        <p>
          When the merchant is a logo, not text, the app identifies the brand
          visually and files it correctly. Teach it any new brand with one
          image.
        </p>
      </div>
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
        <h4>📊 A report worth handing in</h4>
        <p>
          Themed multi-sheet Excel with live formulas, embedded receipt images,
          spending insights and charts, plus a one-click CSV.
        </p>
      </div>
      <div class="card feat">
        <h4>☁️ Optional sync</h4>
        <p>
          Sign in to keep batches on your own private cloud workspace and pick
          up on another device. Entirely optional; local-first by design.
        </p>
      </div>
    </div>
  </section>

  <!-- ======================= privacy ======================= -->
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
          Images stay in your browser's storage. OCR, logo recognition,
          extraction and the Excel build all run on your hardware. Close the
          tab and it's still there; clear it and it's gone. The hosted site
          counts visits anonymously (Cloudflare Web Analytics, no cookies);
          your receipts and their contents are never part of that.
        </p>
      </div>
      <div class="card priv">
        <h4>Optional boosters</h4>
        <p class="priv-flow">
          <span class="chip">AI second opinion</span>
          <span class="chip">cloud sync</span>
        </p>
        <p>
          Turn on the AI assist and low-confidence receipts go to the model you
          configure. Sign in and your batches sync to your own Supabase
          workspace, protected by row-level security. Both are opt-in, clearly
          labeled, and off by default.
        </p>
      </div>
    </div>
  </section>

  <!-- ======================= faq ======================= -->
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

  <!-- ======================= contact ======================= -->
  <ContactSection />

  <!-- ======================= final cta + footer ======================= -->
  <section class="wrap last-cta">
    <div class="card cta-card">
      <h2>Got a pile of receipts?</h2>
      <p>You're about a minute away from a finished report.</p>
      <button class="btn btn-primary btn-lg" onclick={pick}>Add receipts</button>
    </div>
  </section>

  <footer class="wrap foot">
    <span>DueBack</span>
    <span class="foot-sep">·</span>
    <a href="https://github.com/duedev/ReimbursementsF5" rel="noopener">GitHub</a>
    <span class="foot-sep">·</span>
    <span>MIT license</span>
    <span class="foot-sep">·</span>
    <span>Built with on-device AI</span>
  </footer>
</div>

<style>
  .landing {
    min-height: 100dvh;
  }

  /* ---- nav ---- */
  .nav {
    display: flex;
    align-items: center;
    gap: 1.2rem;
    padding: 1.1rem 0;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-right: auto;
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
  .nav-links {
    display: flex;
    gap: 1.3rem;
  }
  .nav-links a {
    color: var(--ink-soft);
    text-decoration: none;
    font: 550 0.92rem/1 var(--font-ui);
  }
  .nav-links a:hover {
    color: var(--ink);
  }
  .nav-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  @media (max-width: 760px) {
    .nav-links {
      display: none;
    }
  }

  /* ---- sections ---- */
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
  .priv-arrow {
    color: var(--ink-faint);
  }
  .priv p:last-child {
    color: var(--ink-soft);
    margin: 0.6rem 0 0;
    font-size: 0.95rem;
  }

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
    color: var(--ink-faint);
    font-size: 0.88rem;
  }
  .foot-sep {
    opacity: 0.5;
  }
</style>
