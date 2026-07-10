<section id="how" class="wrap how">
  <p class="section-label">How it works</p>
  <h2>Three steps. About a minute.</h2>
  <ol class="steps">
    <li>
      <details class="card step" open>
        <summary>
          <span class="step-n">1</span>
          <span class="step-head">
            <span class="step-title">Snap or drop</span>
            <span class="step-deck">
              Phone camera, photos, scans or PDFs. Each one is straightened,
              cleaned and read on your device.
            </span>
          </span>
        </summary>
        <div class="step-body">
          <p>
            <strong>What works:</strong> JPEG, PNG, WebP and PDFs (HEIC on
            Safari). Multi-select a whole pile at once; on a phone, the camera
            opens directly.
          </p>
          <p>
            Crumpled, faded and tilted receipts are auto-rotated, straightened
            and cleaned before reading. No manual cropping, and no third-party
            scanner app like CamScanner required: the cleanup is built in.
          </p>
        </div>
      </details>
    </li>
    <li>
      <details class="card step">
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
            your memory. Approve or fix each one in a couple of clicks.
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
      <details class="card step">
        <summary>
          <span class="step-n">3</span>
          <span class="step-head">
            <span class="step-title">Download the workbook</span>
            <span class="step-deck">
              One click builds a themed Excel report, plus a CSV and an images
              ZIP if you need them.
            </span>
          </span>
        </summary>
        <div class="step-body">
          <p>
            <strong>Inside the .xlsx:</strong> a Summary whose grand total is a
            live formula that matches every category sheet, per-category pages
            with the receipt images embedded beside their rows, and an Insights
            sheet with charts.
          </p>
          <p><span class="file-pill">report.xlsx · totals add up ✓ · ready to hand in</span></p>
        </div>
      </details>
    </li>
  </ol>
</section>

<style>
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
</style>
