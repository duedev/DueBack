<script lang="ts">
  // Steps open on hover and stay open (reading shouldn't require a click);
  // clicking the summary still toggles, so a click can close one again.
  // Touch devices synthesize mouseenter right before the tap's click — the
  // hover opened the step and the click closed it again, so every step took
  // two taps. Only real hover-capable pointers get the hover behaviour.
  function openOnHover(e: MouseEvent): void {
    if (typeof matchMedia === "function" && !matchMedia("(hover: hover)").matches) return;
    (e.currentTarget as HTMLDetailsElement).open = true;
  }
</script>

<section id="how" class="wrap how">
  <p class="section-label">How it works</p>
  <h2>Three steps. About a minute.</h2>
  <p class="how-deck">
    By hand, a pile of receipts is 5 to 45 minutes of data entry. Here, the
    reading happens while you watch — you only check the few it flags.
  </p>

  <div class="how-cols">
    <ol class="steps">
      <li>
        <details class="card step" open onmouseenter={openOnHover}>
          <summary>
            <span class="step-n">1</span>
            <span class="step-head">
              <span class="step-title">Snap or drop</span>
              <span class="step-deck">
                Phone camera, photos, scans, PDFs or a ZIP folder. Each one is
                straightened, cleaned and read on your device.
              </span>
            </span>
          </summary>
          <div class="step-body">
            <p>
              <strong>What works:</strong> JPEG, PNG, WebP and PDFs (HEIC on
              Safari). Multi-select a whole pile at once; on a phone, the camera
              opens directly. Drop in a ZIP and every receipt inside it is
              unpacked, nested folders and all.
            </p>
            <p>
              Crumpled, faded and tilted receipts are auto-rotated,
              straightened and cleaned before reading — no manual cropping, no
              third-party scanner app. The reading itself is open-source text
              recognition running in your browser, with a second cleanup pass
              for unevenly lit photos. No servers, no upload.
            </p>
          </div>
        </details>
      </li>
      <li>
        <details class="card step" onmouseenter={openOnHover}>
          <summary>
            <span class="step-n">2</span>
            <span class="step-head">
              <span class="step-title">Review the flagged few</span>
              <span class="step-deck">
                Most receipts file themselves; the uncertain few queue for a
                quick check.
              </span>
            </span>
          </summary>
          <div class="step-body">
            <p>
              The vendor, date and amount are highlighted right on the receipt
              image with a zoomed callout, so you check against the paper, not
              your memory. Approve or fix each one in a couple of clicks; a
              board tracks every receipt through the sweep.
            </p>
            <p>
              Behind the flags, every amount is grounded in the printed grand
              total and cross-checked against line items and tax — anything
              that doesn't add up is <strong>flagged for you</strong> instead
              of silently "fixed".
            </p>
            <p class="kbd-row">
              Clearing a big batch? There are shortcuts for that:
              <kbd class="kbd">Enter</kbd> approve &amp; next ·
              <kbd class="kbd">Tab</kbd> next field.
            </p>
          </div>
        </details>
      </li>
      <li>
        <details class="card step" onmouseenter={openOnHover}>
          <summary>
            <span class="step-n">3</span>
            <span class="step-head">
              <span class="step-title">Download the Excel workbook</span>
              <span class="step-deck">
                One click builds a themed Excel report and a print packet PDF
                of the receipts for offices that keep paper.
              </span>
            </span>
          </summary>
          <div class="step-body">
            <p>
              <strong>Inside the .xlsx:</strong> a Summary whose grand total is
              a live formula that matches every category sheet, per-category
              pages with the receipt images embedded beside their rows, and an
              optional Insights sheet with charts.
            </p>
            <p>
              <span class="file-pill">report.xlsx · totals add up ✓ · ready to hand in</span>
              <a class="step-more" href="#workbook">See what's inside →</a>
            </p>
          </div>
        </details>
      </li>
    </ol>

    <!-- Hand-vs-DueBack timing; decorative, summarized by the deck copy. -->
    <aside class="card race">
      <p class="race-title">The same pile, timed</p>
      <div class="groups" aria-hidden="true">
        <div class="group">
          <div class="count">10 receipts</div>
          <div class="bars">
            <span class="who">by hand</span>
            <div class="track">
              <div class="fill hand" style="width: 14%"></div>
              <span class="val by-hand" style="left: calc(14% + 8px)">~5 min</span>
            </div>
            <span class="who">DueBack</span>
            <div class="track">
              <div class="fill fast" style="width: 2%"></div>
              <span class="val by-app" style="left: calc(2% + 8px)">seconds</span>
            </div>
          </div>
        </div>
        <div class="group">
          <div class="count">25 receipts</div>
          <div class="bars">
            <span class="who">by hand</span>
            <div class="track">
              <div class="fill hand" style="width: 48%"></div>
              <span class="val by-hand" style="left: calc(48% + 8px)">~20 min</span>
            </div>
            <span class="who">DueBack</span>
            <div class="track">
              <div class="fill fast" style="width: 3%"></div>
              <span class="val by-app" style="left: calc(3% + 8px)">under a minute</span>
            </div>
          </div>
        </div>
        <div class="group">
          <div class="count">50 receipts</div>
          <div class="bars">
            <span class="who">by hand</span>
            <div class="track">
              <!-- Capped short of 100% so the label sits outside the fill
                   (the design's in-bar white-on-orange label fails AA). -->
              <div class="fill hand" style="width: 78%"></div>
              <span class="val by-hand" style="left: calc(78% + 8px)">~45 min</span>
            </div>
            <span class="who">DueBack</span>
            <div class="track">
              <div class="fill fast" style="width: 5%"></div>
              <span class="val by-app" style="left: calc(5% + 8px)">~2 min, review included</span>
            </div>
          </div>
        </div>
      </div>
      <p class="fine">
        Hand-timed estimates for retyping, renaming and pasting images into a
        sheet. Your pace may vary.
      </p>
    </aside>
  </div>

  <aside class="db-nerd" aria-label="Technical details">
    <span class="db-nerd-tag">nerd note · the reading pipeline</span>
    <p>
      Every image is straightened before it's read: EXIF rotation, a
      projection-profile deskew, and an edge-energy autocrop, then OCR runs
      over a transient ~2600px render, <strong>on your hardware</strong>, no
      server round-trip. Weak reads get a second pass over an adaptively
      binarized copy (rescue-only: binarization helps uneven phone photos and
      hurts clean scans, so it never runs first).
    </p>
    <p>
      The money grammar is deliberately strict: "3.499/gal" and "11.204 GAL"
      are decimals, never $3,499; the line under a bare TOTAL label must
      parse as strict money and must not be a tender line, so "CASH 20.00"
      never ships as the total. Subtotal + tax must foot, gallons ×
      price-per-gallon is cross-checked on fuel receipts, and anything that
      doesn't reconcile is <strong>flagged for you</strong> instead of
      silently "fixed".
    </p>
    <p>
      Accuracy is gated: the extraction rules run against a fixed
      nine-challenge test set on every change, and CI drives real OCR in a
      real browser over sample receipts (fuel math, split total labels,
      skewed scans, multi-page PDFs) with per-receipt amount assertions. A
      regression fails the build, <strong>not your report</strong>.
    </p>
  </aside>
</section>

<style>
  .how-deck {
    color: var(--ink-soft);
    max-width: 42rem;
    font-size: 1.02rem;
    margin: -0.8rem 0 1.8rem;
  }

  .how-cols {
    display: grid;
    grid-template-columns: minmax(0, 1.25fr) minmax(0, 0.75fr);
    gap: 1.6rem;
    align-items: start;
  }

  .steps {
    display: grid;
    gap: 0.8rem;
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .step {
    padding: 0;
    overflow: hidden;
  }
  .step summary {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 1rem;
    padding: 1.1rem 1.3rem;
    cursor: pointer;
    list-style: none;
  }
  .step summary::-webkit-details-marker {
    display: none;
  }
  /* .step's overflow:hidden clips the global focus ring — draw it inset. */
  .step summary:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--bg), inset 0 0 0 4px var(--accent);
  }
  .step summary::after {
    content: "+";
    color: var(--accent);
    font-size: 1.3rem;
    line-height: 1;
  }
  .step[open] summary::after {
    content: "–";
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
  }
  .step-head {
    display: grid;
    gap: 0.15rem;
    min-width: 0;
  }
  .step-title {
    font: 650 1.02rem/1.3 var(--font-ui);
  }
  .step-deck {
    color: var(--ink-soft);
    font-size: 0.92rem;
  }
  .step-body {
    border-top: 1px solid var(--line);
    padding: 1rem 1.3rem 1.15rem;
    max-width: 46rem;
  }
  .step-body p {
    color: var(--ink-soft);
    font-size: 0.95rem;
    margin: 0 0 0.7rem;
  }
  .step-body p:last-child {
    margin-bottom: 0;
  }
  .step-body strong {
    color: var(--ink);
  }
  .kbd-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .file-pill {
    display: inline-flex;
    align-items: center;
    font: 650 0.8rem/1.4 var(--font-mono);
    padding: 0.35rem 0.75rem;
    border-radius: var(--radius-pill);
    background: var(--accent-soft);
    border: 1px solid var(--accent-line);
    color: var(--accent);
  }
  .step-more {
    display: inline-block;
    margin-left: 0.7rem;
    font: 600 0.88rem/1.4 var(--font-ui);
    color: var(--accent);
    text-decoration: none;
    white-space: nowrap;
  }
  .step-more:hover {
    text-decoration: underline;
  }

  /* ---- the race rail ---- */
  .race {
    position: sticky;
    top: 5rem; /* clears the sticky nav */
    padding: 1.3rem 1.4rem 1.1rem;
    display: grid;
    gap: 1.1rem;
  }
  .race-title {
    font: 600 0.75rem/1 var(--font-ui);
    color: var(--ink-faint);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin: 0;
  }
  .groups {
    display: grid;
    gap: 1.3rem;
  }
  .group {
    display: grid;
    gap: 0.5rem;
  }
  .count {
    font: 600 0.85rem/1 var(--font-ui);
    color: var(--ink);
  }
  .bars {
    display: grid;
    grid-template-columns: 64px 1fr;
    gap: 0.5rem;
    align-items: center;
  }
  .who {
    font: 600 0.72rem/1 var(--font-ui);
    color: var(--ink-faint);
    text-align: right;
  }
  .track {
    position: relative;
    height: 14px;
    border-radius: 4px;
    background: var(--bg-sunken);
  }
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 4px;
    transform-origin: left;
  }
  .fill.hand {
    background: var(--gold);
    animation: db-fill-hand 8s ease-in-out infinite;
  }
  .fill.fast {
    background: var(--accent);
    animation: db-fill-fast 8s ease-out infinite;
  }
  .val {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    font: 600 0.7rem/1 var(--font-ui);
    white-space: nowrap;
  }
  .val.by-hand {
    color: var(--ink-soft);
    animation: db-fade-hand 8s linear infinite;
  }
  .val.by-app {
    color: var(--accent);
    animation: db-fade-fast 8s linear infinite;
  }
  .fine {
    color: var(--ink-soft);
    font-size: 0.8rem;
    margin: 0;
  }

  /* The hand crawls the whole 8s cycle; DueBack is done by 16%. Labels fade
     in as their bar finishes. */
  @keyframes db-fill-hand {
    0%, 6% {
      transform: scaleX(0.02);
    }
    86%, 100% {
      transform: scaleX(1);
    }
  }
  @keyframes db-fill-fast {
    0%, 6% {
      transform: scaleX(0.02);
    }
    16%, 100% {
      transform: scaleX(1);
    }
  }
  @keyframes db-fade-hand {
    0%, 84% {
      opacity: 0;
    }
    90%, 100% {
      opacity: 1;
    }
  }
  @keyframes db-fade-fast {
    0%, 14% {
      opacity: 0;
    }
    20%, 100% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    /* Static end-state: both bars full, both labels shown. */
    .fill.hand,
    .fill.fast {
      animation: none;
      transform: scaleX(1);
    }
    .val.by-hand,
    .val.by-app {
      animation: none;
      opacity: 1;
    }
  }

  @media (max-width: 900px) {
    .how-cols {
      grid-template-columns: 1fr;
    }
    .race {
      position: static;
    }
  }
  @media (max-width: 480px) {
    .val {
      font-size: 0.66rem;
    }
  }
</style>
