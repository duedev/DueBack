<section id="logos" class="wrap logos">
  <div class="cols">
    <div class="copy">
      <p class="section-label">Logo recognition</p>
      <h2>Some merchants only sign with a logo. Teach it once.</h2>
      <p>
        Plenty of receipts never print the store's name, just a logo the text
        reader can't spell. Teach it once: in Settings, add one clear photo of
        the logo and give it a name and a category.
      </p>
      <p>
        From then on it's recognized on sight and filed to the right category.
        Matching runs on your device; sign in and taught brands are saved to
        your own private workspace, so they follow you to any device.
      </p>
    </div>

    <div class="pair" aria-hidden="true">
      <div class="card teach">
        <div class="pair-label">You teach it once</div>
        <div class="mock">
          <div class="logo-mark framed">
            ▚ logo, no text ▞
            <span class="frame"></span>
            <span class="handle tl"></span>
            <span class="handle tr"></span>
            <span class="handle bl"></span>
            <span class="handle br"></span>
          </div>
          <div class="m-line"><span>Espresso ×2</span><span>7.50</span></div>
          <div class="m-line faint"><span>TOTAL</span><span>7.50</span></div>
        </div>
        <div class="caption">
          add one clear photo of the logo → name it “Corner Bistro” · Meals
        </div>
      </div>

      <div class="pair-arrow">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 12h14m0 0-5.5-5.5M18 12l-5.5 5.5" />
        </svg>
      </div>

      <div class="card after">
        <div class="pair-label">Every receipt after</div>
        <div class="mock">
          <div class="logo-mark">▚ logo, no text ▞</div>
          <div class="m-line"><span>Cappuccino</span><span>4.75</span></div>
          <div class="m-line faint"><span>TOTAL</span><span>4.75</span></div>
        </div>
        <div class="match"><i class="dot"></i>Corner Bistro · Meals · matched</div>
      </div>
    </div>
  </div>
</section>

<style>
  .cols {
    display: grid;
    grid-template-columns: 1fr 1.1fr;
    gap: 3.2rem;
    align-items: center;
  }
  .copy p:not(.section-label) {
    color: var(--ink-soft);
    max-width: 32rem;
  }

  .pair {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    gap: 0.9rem;
    align-items: center;
  }
  .teach,
  .after {
    padding: 1.1rem;
  }
  .after {
    border-color: var(--accent-line);
  }
  .pair-label {
    font: 600 0.75rem/1 var(--font-ui);
    color: var(--ink-faint);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 0.65rem;
  }
  .mock {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius-m);
    padding: 0.85rem 0.75rem;
    font: 500 0.66rem/1.5 var(--font-mono);
    color: var(--ink);
  }
  .logo-mark {
    position: relative;
    text-align: center;
    padding: 0.55rem 0.4rem;
    font-weight: 700;
    color: var(--cat-3);
    background: color-mix(in srgb, var(--cat-3) 8%, transparent);
    border-radius: 4px;
  }
  .frame {
    position: absolute;
    inset: -6px;
    border: 1.5px dashed var(--accent);
    border-radius: 6px;
    pointer-events: none;
  }
  .handle {
    position: absolute;
    width: 7px;
    height: 7px;
    background: var(--accent);
    border-radius: 2px;
  }
  .handle.tl { left: -9px; top: -9px; }
  .handle.tr { right: -9px; top: -9px; }
  .handle.bl { left: -9px; bottom: -9px; }
  .handle.br { right: -9px; bottom: -9px; }
  .framed .frame,
  .framed .handle {
    animation: db-crop 6s ease-out infinite;
  }
  .m-line {
    display: flex;
    justify-content: space-between;
    gap: 0.6rem;
    padding-top: 0.5rem;
  }
  .m-line.faint {
    color: var(--ink-faint);
    padding-top: 0.15rem;
  }
  .caption {
    font: 500 0.8rem/1.45 var(--font-ui);
    color: var(--ink-soft);
    margin-top: 0.65rem;
  }
  .match {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin-top: 0.65rem;
    font: 600 0.8rem/1.3 var(--font-ui);
    color: var(--accent);
    animation: db-match 6s ease-out infinite;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
  }
  .pair-arrow {
    color: var(--accent);
  }

  /* The capture frame settles in, then the match line lights up. */
  @keyframes db-crop {
    0% {
      opacity: 0;
      transform: scale(1.25);
    }
    14% {
      opacity: 1;
      transform: scale(1);
    }
    90% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
  @keyframes db-match {
    0%, 26% {
      opacity: 0.2;
    }
    40%, 100% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .framed .frame,
    .framed .handle {
      animation: none;
      opacity: 1;
      transform: none;
    }
    .match {
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
  @media (max-width: 640px) {
    .pair {
      grid-template-columns: 1fr;
      justify-items: center;
    }
    .teach,
    .after {
      width: min(340px, 100%);
    }
    .pair-arrow svg {
      transform: rotate(90deg);
    }
  }
</style>
