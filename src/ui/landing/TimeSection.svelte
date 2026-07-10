<section id="time" class="wrap time">
  <div class="cols">
    <div class="copy">
      <p class="section-label">Time saved</p>
      <h2>A ready-to-turn-in workbook in seconds.</h2>
      <p>
        Doing it by hand, a pile of receipts costs 5 to 45 minutes of retyping
        vendors, dates and totals, depending on the stack.
      </p>
      <p>
        With DueBack, the reading happens while you watch, you glance over the
        flagged few, and the Excel workbook itself builds in seconds.
      </p>
    </div>

    <div class="card race">
      <!-- Hand-vs-DueBack comparison bars; decorative, summarized by the copy. -->
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
    </div>
  </div>
</section>

<style>
  .cols {
    display: grid;
    grid-template-columns: 1fr 1.15fr;
    gap: 3.2rem;
    align-items: center;
  }
  .copy p:not(.section-label) {
    color: var(--ink-soft);
    max-width: 32rem;
  }
  .race {
    padding: 1.6rem 1.7rem 1.2rem;
    display: grid;
    gap: 1.2rem;
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
    grid-template-columns: 88px 1fr;
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
    font: 600 0.72rem/1 var(--font-ui);
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
    .cols {
      grid-template-columns: 1fr;
      gap: 1.6rem;
    }
  }
  @media (max-width: 480px) {
    .bars {
      grid-template-columns: 64px 1fr;
    }
    .val {
      font-size: 0.66rem;
    }
  }
</style>
