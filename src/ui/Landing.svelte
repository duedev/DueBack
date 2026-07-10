<script lang="ts">
  import { app } from "./state.svelte.ts";
  import ThemeToggle from "./ThemeToggle.svelte";
  import { LIMITS } from "../config/constants.ts";
  import type { Receipt } from "../types.ts";

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

  // ---- Contact form ---------------------------------------------------------
  // Static site, no server: the form opens the visitor's own mail app via a
  // prefilled mailto: draft. mailto can't attach files, so the "attach my
  // tuning bundle" checkbox downloads the ZIP first and the draft asks the
  // sender to attach it — honest, works everywhere, no third-party service.
  const CONTACT_EMAIL = "contact@duanehamilton.net";
  let cName = $state("");
  let cMsg = $state("");
  let cAttach = $state(false);
  let cBusy = $state(false);

  async function sendMessage(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!cMsg.trim()) return;
    cBusy = true;
    let attachNote = "";
    try {
      if (cAttach) {
        const { buildTuningBundle, downloadBundle } = await import("../train/bundle.ts");
        const receipts = $state.snapshot(app.receipts) as Receipt[];
        const bundle = await buildTuningBundle(receipts);
        downloadBundle(bundle);
        attachNote =
          `

(P.S. Please attach the file "${bundle.fileName}" that just downloaded — ` +
          `it holds my ${bundle.receiptCount} receipts' extraction data and ` +
          `${bundle.correctionCount} corrections for tuning.)`;
      }
    } catch {
      /* the message still goes out without the bundle */
    } finally {
      cBusy = false;
    }
    const subject = encodeURIComponent(
      `DueBack feedback${cName.trim() ? ` from ${cName.trim()}` : ""}`,
    );
    const body = encodeURIComponent(
      `${cMsg.trim()}${cName.trim() ? `

— ${cName.trim()}` : ""}${attachNote}`,
    );
    window.location.href = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
  }

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
  <header class="wrap hero">
    <div class="hero-copy">
      <h1>Receipts in.<br />Reimbursement report out.</h1>
      <p class="hero-sub">
        Snap or drop a pile of receipts. They're read on your device: the
        printed text, plus any brand logos you've taught it. You review the
        flagged ones in seconds, and out comes a polished Excel workbook your
        office will actually accept.
      </p>
      <div class="hero-ctas">
        <button class="btn btn-primary btn-lg" onclick={pick}>
          Add receipts
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 16V4m0 0 4.5 4.5M12 4 7.5 8.5M4 16.5v2A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-2" />
          </svg>
        </button>
        {#if app.receipts.length > 0}
          <button class="btn btn-lg" onclick={() => app.enter()}>
            Back to your receipts ({app.receipts.length})
          </button>
        {:else}
          <a class="btn btn-lg" href="#how">See how it works</a>
        {/if}
      </div>
      <ul class="hero-trust" aria-label="Key facts">
        <li><strong>$0</strong> per receipt</li>
        <li>Runs on your device</li>
        <li>No account needed</li>
      </ul>
    </div>

    <!-- Stylized before/after: receipt → workbook. Pure CSS, no images. -->
    <div class="hero-visual" aria-hidden="true">
      <div class="paper receipt">
        <div class="r-vendor"><mark class="hl hl-vendor">MAPLE ST. HARDWARE</mark></div>
        <div class="r-line"><span>Wood screws #8</span><span>4.29</span></div>
        <div class="r-line"><span>Paint roller kit</span><span>12.99</span></div>
        <div class="r-line"><span>Drop cloth 9×12</span><span>8.49</span></div>
        <div class="r-line faint"><span>Subtotal</span><span>25.77</span></div>
        <div class="r-line faint"><span>Tax 6.5%</span><span>1.68</span></div>
        <div class="r-total"><span>TOTAL</span><mark class="hl hl-amount">$27.45</mark></div>
        <div class="r-date"><mark class="hl hl-date">06/24/2026</mark> · 14:07</div>
        <div class="r-scan"></div>
      </div>

      <div class="flow-arrow">
        <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 12h14m0 0-5.5-5.5M18 12l-5.5 5.5" />
        </svg>
        <span class="flow-note">read · checked · filed</span>
      </div>

      <div class="paper sheet">
        <div class="s-head">
          <span>Vendor</span><span>Date</span><span>Category</span><span>Amount</span>
        </div>
        <div class="s-row">
          <span><mark class="hl hl-vendor">Maple St. Hardware</mark></span><span><mark class="hl hl-date">06/24</mark></span><span><i class="dot d1"></i>Materials</span><span><mark class="hl hl-amount">27.45</mark></span>
        </div>
        <div class="s-row">
          <span>Corner Bistro</span><span>06/24</span><span><i class="dot d2"></i>Meals</span><span>18.20</span>
        </div>
        <div class="s-row">
          <span>CityGas #214</span><span>06/25</span><span><i class="dot d3"></i>Fuel</span><span>41.03</span>
        </div>
        <div class="s-total">
          <span>TOTAL</span><span class="s-sum">$86.68</span>
        </div>
        <div class="s-foot">= SUM(D2:D4) · foots ✓</div>
      </div>
    </div>
  </header>

  <!-- ======================= how it works ======================= -->
  <section id="how" class="wrap how">
    <p class="section-label">How it works</p>
    <h2>Three steps. About a minute.</h2>
    <ol class="steps">
      <li class="card step">
        <span class="step-n">1</span>
        <h4>Snap or drop</h4>
        <p>
          Use your phone camera or drag files in: photos, scans or PDFs. Each
          receipt is straightened, cleaned and read on your device.
        </p>
      </li>
      <li class="card step">
        <span class="step-n">2</span>
        <h4>Review the flagged few</h4>
        <p>
          Most receipts file themselves. The uncertain ones are queued for a
          keyboard-driven sweep with the amount, date and vendor highlighted
          right on the image.
        </p>
      </li>
      <li class="card step">
        <span class="step-n">3</span>
        <h4>Download the workbook</h4>
        <p>
          One click builds a themed Excel report with a summary that foots,
          receipts embedded per category, and insights, ready to hand in.
        </p>
      </li>
    </ol>
  </section>

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
  <section id="contact" class="wrap contact">
    <p class="section-label">Contact</p>
    <h2>Tell us what broke (or what worked).</h2>
    <form class="card contact-card" onsubmit={sendMessage}>
      <div class="c-row">
        <label class="c-field">
          <span>Your name (optional)</span>
          <input type="text" bind:value={cName} autocomplete="name" />
        </label>
      </div>
      <label class="c-field">
        <span>Message</span>
        <textarea rows="5" required bind:value={cMsg} placeholder="What happened, what you expected, which receipt…"></textarea>
      </label>
      <label class="c-check">
        <input type="checkbox" bind:checked={cAttach} />
        <span>
          Attach my tuning bundle — receipts' extraction data, corrections and
          images, zipped for download so you can add it to the email.
        </span>
      </label>
      <div class="c-actions">
        <button class="btn btn-primary" disabled={cBusy}>
          {cBusy ? "Packaging…" : "Open email draft"}
        </button>
        <span class="muted small">
          Opens your mail app addressed to {CONTACT_EMAIL}.
          {#if cAttach}The bundle ZIP downloads first; attach it before sending.{/if}
        </span>
      </div>
    </form>
  </section>

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

  /* ---- hero ---- */
  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
    align-items: center;
    gap: 3rem;
    padding: 4.5rem 0 5rem;
  }
  .hero-copy h1 {
    font-size: clamp(2.5rem, 5.4vw, 4rem);
  }
  .hero-sub {
    font-size: 1.14rem;
    color: var(--ink-soft);
    max-width: 34rem;
  }
  .hero-ctas {
    display: flex;
    flex-wrap: wrap;
    gap: 0.8rem;
    margin: 1.6rem 0 1.4rem;
  }
  .hero-trust {
    display: flex;
    gap: 1.4rem;
    list-style: none;
    padding: 0;
    margin: 0;
    color: var(--ink-soft);
    font-size: 0.92rem;
  }
  .hero-trust li::before {
    content: "✓";
    color: var(--ok);
    font-weight: 700;
    margin-right: 0.4rem;
  }
  @media (max-width: 900px) {
    .hero {
      grid-template-columns: 1fr;
      padding-top: 2.5rem;
    }
  }

  /* ---- hero visual ---- */
  .hero-visual {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1.25fr);
    align-items: center;
    gap: 0.9rem;
  }
  .paper {
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-m);
    box-shadow: var(--shadow-3);
  }
  .receipt {
    font-family: var(--font-mono);
    font-size: 0.62rem;
    padding: 0.9rem 0.85rem 1.1rem;
    transform: rotate(-3deg);
    position: relative;
    overflow: hidden;
  }
  .r-vendor {
    font-weight: 700;
    text-align: center;
    letter-spacing: 0.04em;
    margin-bottom: 0.7rem;
    border: 1.5px solid var(--accent);
    border-radius: 6px;
    padding: 0.3rem 0.2rem;
    color: var(--accent);
  }
  .r-line {
    display: flex;
    justify-content: space-between;
    gap: 0.6rem;
    padding: 0.14rem 0;
  }
  .r-line.faint {
    color: var(--ink-faint);
  }
  .r-total {
    display: flex;
    justify-content: space-between;
    font-weight: 700;
    border-top: 1.5px dashed var(--line-strong);
    margin-top: 0.4rem;
    padding-top: 0.4rem;
    color: var(--gold);
  }
  .r-date {
    margin-top: 0.55rem;
    color: var(--ink-faint);
    text-align: center;
  }
  .r-scan {
    position: absolute;
    inset-inline: 0;
    top: 0;
    height: 34%;
    background: linear-gradient(180deg, var(--accent-soft), transparent);
    /* One unhurried pass, then a long rest. The receipt highlights below key
       off the same 8s clock so each mark appears only AFTER the scan line
       has swept past it. */
    animation: scan 8s ease-in-out infinite;
    pointer-events: none;
  }
  @keyframes scan {
    0%,
    100% {
      transform: translateY(-10%);
      opacity: 0;
    }
    5% {
      opacity: 1;
    }
    40% {
      transform: translateY(210%);
      opacity: 0.9;
    }
    48% {
      opacity: 0;
    }
    99% {
      transform: translateY(210%);
    }
  }

  /* Receipt-side highlights: hidden until the scanner passes their line.
     The text itself stays visible; only the highlighter tint waits. */
  .receipt .hl {
    position: relative;
    background: transparent;
    box-shadow: none;
  }
  .receipt .hl::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 3px;
    opacity: 0;
    pointer-events: none;
  }
  .receipt .hl-vendor::after {
    background: color-mix(in srgb, #1d4ed8 22%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, #1d4ed8 45%, transparent);
    animation: reveal-vendor 8s ease-out infinite;
  }
  .receipt .hl-amount::after {
    background: color-mix(in srgb, #147246 20%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, #147246 45%, transparent);
    animation: reveal-amount 8s ease-out infinite;
  }
  .receipt .hl-date::after {
    background: color-mix(in srgb, #dc2626 18%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, #dc2626 45%, transparent);
    animation: reveal-date 8s ease-out infinite;
  }
  /* Reveal points trail the scan band's position at the same cycle time. */
  @keyframes reveal-vendor {
    0%, 8% { opacity: 0; }
    12%, 96% { opacity: 1; }
    100% { opacity: 0; }
  }
  @keyframes reveal-amount {
    0%, 32% { opacity: 0; }
    36%, 96% { opacity: 1; }
    100% { opacity: 0; }
  }
  @keyframes reveal-date {
    0%, 39% { opacity: 0; }
    43%, 96% { opacity: 1; }
    100% { opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .r-scan {
      animation: none;
      opacity: 0;
    }
    .receipt .hl-vendor::after,
    .receipt .hl-amount::after,
    .receipt .hl-date::after {
      animation: none;
      opacity: 1;
    }
  }

  .flow-arrow {
    display: grid;
    justify-items: center;
    gap: 0.3rem;
    color: var(--accent);
  }
  .flow-note {
    font: 600 0.62rem/1 var(--font-ui);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-faint);
    white-space: nowrap;
  }

  .sheet {
    font: 500 0.66rem/1.25 var(--font-ui);
    padding: 0.7rem;
    transform: rotate(1.6deg);
  }
  .s-head,
  .s-row,
  .s-total {
    display: grid;
    /* minmax(0,…) lets cells shrink; nothing may bleed out of the card. */
    grid-template-columns: minmax(0, 1.6fr) minmax(0, 0.7fr) minmax(0, 1.1fr) minmax(0, 0.75fr);
    gap: 0.45rem;
    padding: 0.32rem 0.45rem;
    align-items: center;
  }
  .s-head span,
  .s-row span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hl {
    background: transparent;
    color: inherit;
    border-radius: 3px;
    padding: 0 0.14em;
    box-decoration-break: clone;
  }
  .hl-vendor {
    background: color-mix(in srgb, #1d4ed8 22%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, #1d4ed8 45%, transparent);
  }
  .hl-date {
    background: color-mix(in srgb, #dc2626 18%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, #dc2626 45%, transparent);
  }
  .hl-amount {
    background: color-mix(in srgb, #147246 20%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, #147246 45%, transparent);
  }
  .s-head {
    background: var(--accent);
    color: var(--accent-ink);
    border-radius: 6px;
    font-weight: 700;
  }
  .s-row {
    border-bottom: 1px solid var(--line);
  }
  .s-row span:last-child,
  .s-head span:last-child {
    text-align: right;
  }
  .dot {
    display: inline-block;
    width: 0.45em;
    height: 0.45em;
    border-radius: 50%;
    margin-right: 0.3em;
    vertical-align: middle;
  }
  .d1 {
    background: var(--cat-3);
  }
  .d2 {
    background: var(--cat-2);
  }
  .d3 {
    background: var(--cat-1);
  }
  .s-total {
    grid-template-columns: 1fr auto;
    font-weight: 700;
    padding-top: 0.5rem;
  }
  .s-sum {
    color: var(--accent);
  }
  .s-foot {
    color: var(--ink-faint);
    font-family: var(--font-mono);
    font-size: 0.58rem;
    padding: 0.15rem 0.45rem 0.05rem;
  }
  @media (max-width: 480px) {
    .flow-arrow svg {
      width: 30px;
      height: 30px;
    }
    .flow-note {
      display: none;
    }
  }

  /* ---- sections ---- */
  section {
    padding: 3.6rem 0;
  }
  section h2 {
    font-size: clamp(1.7rem, 3.2vw, 2.3rem);
    margin-bottom: 1.6rem;
  }

  .steps {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 1rem;
    list-style: none;
    padding: 0;
    margin: 0;
    counter-reset: step;
  }
  .step {
    padding: 1.4rem 1.4rem 1.2rem;
  }
  .step-n {
    display: inline-grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    font: 700 0.95rem/1 var(--font-display);
    margin-bottom: 0.8rem;
  }
  .step p {
    color: var(--ink-soft);
    margin: 0;
    font-size: 0.95rem;
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

  /* ---- contact form ---- */
  .contact {
    padding-block: 2.5rem;
  }
  .contact-card {
    display: grid;
    gap: 1rem;
    max-width: 40rem;
    padding: 1.4rem;
  }
  .c-field {
    display: grid;
    gap: 0.35rem;
    font: 600 0.85rem/1.2 var(--font-ui);
    color: var(--ink-soft);
  }
  .c-field input,
  .c-field textarea {
    font: 500 0.95rem/1.4 var(--font-ui);
    color: var(--ink);
    background: var(--raised);
    border: 1px solid var(--line-strong);
    border-radius: 9px;
    padding: 0.6rem 0.7rem;
    resize: vertical;
  }
  .c-field input:focus-visible,
  .c-field textarea:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .c-check {
    display: flex;
    gap: 0.6rem;
    align-items: flex-start;
    font: 500 0.88rem/1.45 var(--font-ui);
    color: var(--ink-soft);
    cursor: pointer;
  }
  .c-check input {
    margin-top: 0.2rem;
    accent-color: var(--accent);
  }
  .c-actions {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    flex-wrap: wrap;
  }
</style>
