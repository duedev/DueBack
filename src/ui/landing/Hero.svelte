<script lang="ts">
  import { app } from "../state.svelte.ts";

  /** The orchestrator owns the page's single hidden file input; the hero
      triggers it through this callback. */
  let { onAdd }: { onAdd: () => void } = $props();
</script>

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
      <button class="btn btn-primary btn-lg" onclick={onAdd}>
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
    <p class="hero-note">
      <strong>Runs entirely in your browser — your receipts never leave your
      device.</strong>
    </p>
    <ul class="hero-stats" aria-label="Key facts">
      <li class="stat">
        <span class="stat-n">$0</span>
        <span class="stat-l">per receipt</span>
      </li>
      <li class="stat">
        <span class="stat-n">~1 min</span>
        <span class="stat-l">pile to finished report</span>
      </li>
      <li class="stat">
        <span class="stat-n">On-device</span>
        <span class="stat-l">receipts stay in your browser</span>
      </li>
    </ul>
  </div>

  <!-- The product story as a strip: a receipt is scanned, the read fields
       pop onto an approved card, and the workbook total re-foots. Pure CSS,
       no images; one shared 8s clock sequences the stages. -->
  <div class="hero-visual" aria-hidden="true">
    <div class="paper receipt">
      <div class="r-vendor"><mark class="hl">CITYGAS #214<span class="rv rv-vendor"></span></mark></div>
      <div class="r-line"><span>Pump 04 · Regular</span><span></span></div>
      <div class="r-line"><span>9.842 gal @ 4.169/gal</span><span>41.03</span></div>
      <div class="r-line faint"><span>Sales tax</span><span>incl.</span></div>
      <div class="r-total"><span>TOTAL</span><mark class="hl">$41.03<span class="rv rv-amount"></span></mark></div>
      <div class="r-date"><mark class="hl">06/25/2026<span class="rv rv-date"></span></mark> · 07:41</div>
      <div class="r-scan"></div>
    </div>

    <div class="mini-arrow arrow-1">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 12h14m0 0-5.5-5.5M18 12l-5.5 5.5" />
      </svg>
      <span class="arrow-note">read · checked</span>
    </div>

    <div class="paper approved">
      <div class="a-top">
        <mark class="hl hl-vendor">CityGas #214</mark>
        <span class="a-pill">Approved ✓</span>
      </div>
      <div class="a-fields">
        <span class="a-key">Date</span>
        <mark class="hl hl-date">06/25/2026</mark>
        <span class="a-key">Total</span>
        <mark class="hl hl-amount">$41.03</mark>
      </div>
      <div class="a-filed"><i class="dot"></i>Fuel · filed automatically</div>
    </div>

    <div class="mini-arrow arrow-2">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 12h14m0 0-5.5-5.5M18 12l-5.5 5.5" />
      </svg>
      <span class="arrow-note">one click</span>
    </div>

    <div class="paper book">
      <div class="b-tabs">
        <span class="b-tab active">Summary</span>
        <span class="b-tab">Insights</span>
        <span class="b-tab">Fuel</span>
      </div>
      <div class="b-body">
        <div class="b-head">
          <span>Vendor</span><span>Date</span><span>Amount</span>
        </div>
        <div class="b-row">
          <span>CityGas #214</span><span>06/25</span><span>41.03</span>
        </div>
        <div class="b-row">
          <span>Corner Bistro</span><span>06/24</span><span>18.20</span>
        </div>
        <div class="b-total">
          <span>TOTAL</span><span class="b-sum">$59.23</span>
        </div>
      </div>
    </div>
  </div>
</header>

<style>
  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
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
    margin: 1.6rem 0 1rem;
  }
  .hero-note {
    font-size: 0.95rem;
    margin: 0 0 1.6rem;
  }
  .hero-stats {
    display: flex;
    gap: 2.2rem;
    flex-wrap: wrap;
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .stat {
    display: grid;
    gap: 0.15rem;
  }
  .stat-n {
    font: 600 1.9rem/1.1 var(--font-display);
    color: var(--ink);
  }
  .stat-l {
    font: 500 0.85rem/1.3 var(--font-ui);
    color: var(--ink-soft);
  }
  @media (max-width: 900px) {
    .hero {
      grid-template-columns: 1fr;
      padding-top: 2.5rem;
    }
  }

  /* ---- hero visual: receipt → approved card → workbook ---- */
  .hero-visual {
    display: grid;
    gap: 0.65rem;
    justify-items: center;
  }

  .receipt {
    position: relative;
    width: min(240px, 100%);
    padding: 0.95rem 0.85rem;
    font: 500 0.66rem/1.45 var(--font-mono);
    overflow: hidden;
  }
  .r-vendor {
    text-align: center;
    font-weight: 700;
    letter-spacing: 0.06em;
    margin-bottom: 0.55rem;
  }
  .r-line {
    display: flex;
    justify-content: space-between;
    gap: 0.6rem;
    padding: 0.1rem 0;
  }
  .r-line.faint {
    color: var(--ink-faint);
  }
  .r-total {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-weight: 700;
    border-top: 1.5px dashed var(--line-strong);
    margin-top: 0.4rem;
    padding-top: 0.4rem;
  }
  .r-date {
    margin-top: 0.45rem;
    color: var(--ink-faint);
    text-align: center;
  }
  .r-scan {
    position: absolute;
    inset-inline: 0;
    top: 0;
    height: 34%;
    background: linear-gradient(180deg, var(--accent-soft), transparent);
    /* One unhurried pass, then a long rest (keyframes in landing.css). */
    animation: db-scan 8s ease-in-out infinite;
    pointer-events: none;
  }

  /* Receipt-side highlights: hidden until the scanner passes their line.
     The text stays visible; only the highlighter tint (.rv overlay) waits. */
  .receipt .hl {
    position: relative;
    background: transparent;
    box-shadow: none;
  }
  .rv {
    position: absolute;
    inset: 0;
    border-radius: 3px;
    opacity: 0;
    pointer-events: none;
  }
  .rv-vendor {
    background: color-mix(in srgb, #1d4ed8 22%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, #1d4ed8 45%, transparent);
    animation: db-reveal-vendor 8s ease-out infinite;
  }
  .rv-amount {
    background: color-mix(in srgb, #147246 20%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, #147246 45%, transparent);
    animation: db-reveal-amount 8s ease-out infinite;
  }
  .rv-date {
    background: color-mix(in srgb, #dc2626 18%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, #dc2626 45%, transparent);
    animation: db-reveal-date 8s ease-out infinite;
  }

  .mini-arrow {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--accent);
  }
  .mini-arrow svg {
    transform: rotate(90deg);
  }
  .arrow-1 {
    animation: db-nudge1 8s ease-in-out infinite;
  }
  .arrow-2 {
    animation: db-nudge2 8s ease-in-out infinite;
  }
  .arrow-note {
    font: 600 0.66rem/1 var(--font-ui);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }

  .approved {
    width: min(330px, 100%);
    padding: 0.75rem 0.9rem;
    font: 500 0.75rem/1.4 var(--font-ui);
  }
  .a-top {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .a-top .hl-vendor {
    font-weight: 650;
  }
  .a-pill {
    margin-left: auto;
    font: 600 0.69rem/1 var(--font-ui);
    padding: 0.22rem 0.6rem;
    border-radius: var(--radius-pill);
    background: var(--accent-soft);
    color: var(--accent);
    animation: db-pop 8s ease-out infinite;
  }
  .a-fields {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex-wrap: wrap;
  }
  .a-key {
    color: var(--ink-faint);
  }
  .a-fields .hl-amount {
    font-weight: 650;
  }
  .a-filed {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.5rem;
    color: var(--ink-soft);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--cat-1);
  }

  .book {
    width: min(330px, 100%);
    overflow: hidden;
    font: 500 0.72rem/1.4 var(--font-ui);
  }
  .b-tabs {
    display: flex;
    gap: 2px;
    padding: 0.4rem 0.5rem 0;
    background: var(--bg-sunken);
    border-bottom: 1px solid var(--line);
  }
  .b-tab {
    font: 500 0.63rem/1 var(--font-ui);
    padding: 0.3rem 0.65rem;
    color: var(--ink-soft);
  }
  .b-tab.active {
    font-weight: 600;
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    color: var(--accent);
  }
  .b-body {
    padding: 0.55rem 0.75rem 0.75rem;
  }
  .b-head,
  .b-row {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(0, 0.7fr) minmax(0, 0.75fr);
    gap: 0.5rem;
    padding: 0.3rem 0.5rem;
  }
  .b-head {
    background: var(--accent);
    color: var(--accent-ink);
    border-radius: 6px;
    font-weight: 700;
  }
  .b-row {
    border-bottom: 1px solid var(--line);
  }
  .b-head span:last-child,
  .b-row span:last-child {
    text-align: right;
  }
  .b-total {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.5rem;
    padding: 0.45rem 0.5rem 0;
    font-weight: 700;
  }
  .b-sum {
    color: var(--accent);
    border-radius: 4px;
    padding: 0 0.25rem;
    margin: 0 -0.25rem;
    animation: db-cell-flash 8s ease-out infinite;
  }

  /* Static end-states when motion is off: everything read, approved, footed. */
  @media (prefers-reduced-motion: reduce) {
    .r-scan {
      animation: none;
      opacity: 0;
    }
    .rv-vendor,
    .rv-amount,
    .rv-date {
      animation: none;
      opacity: 1;
    }
    .arrow-1,
    .arrow-2 {
      animation: none;
      opacity: 0.7;
    }
    .a-pill {
      animation: none;
      opacity: 1;
      transform: none;
    }
    .b-sum {
      animation: none;
      background: transparent;
    }
  }
</style>
