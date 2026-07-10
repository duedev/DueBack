<section id="account" class="wrap account">
  <p class="section-label">Google account &amp; storage</p>
  <div class="head-row">
    <h2>Drop receipts in Drive. A workbook shows up.</h2>
    <span class="badge-soon">Drive sync — coming soon</span>
  </div>
  <p class="lede">
    Sign in with your Google account (one tap, no new password; email magic
    links work too) and your batches, receipts and taught brands live in your
    own private workspace, so you can pick up on any device. Soon, you'll be
    able to link a Drive folder: DueBack will scan new receipts as they land
    and keep an up-to-date workbook ready to download.
  </p>

  <div class="flow">
    <div class="card step">
      <span class="step-n">1</span>
      <h4>Link your Google account</h4>
      <div class="g-btn" aria-hidden="true">
        <span class="g-mark">G</span>Continue with Google
      </div>
      <p>One tap. No password to create; a sign-in email works too.</p>
    </div>

    <div class="flow-arrow" aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 12h14m0 0-5.5-5.5M18 12l-5.5 5.5" />
      </svg>
    </div>

    <div class="card step">
      <span class="badge-soon corner">Planned</span>
      <span class="step-n">2</span>
      <h4>Pick a Drive folder</h4>
      <div class="folder" aria-hidden="true">
        Drive / Receipts / June
        <div class="scanning">3 new files found · scanning…</div>
      </div>
      <p>
        Snap to Drive from your phone as you go; new receipts will be picked
        up automatically.
      </p>
    </div>

    <div class="flow-arrow" aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 12h14m0 0-5.5-5.5M18 12l-5.5 5.5" />
      </svg>
    </div>

    <div class="card step done">
      <span class="badge-soon corner">Planned</span>
      <span class="step-n">3</span>
      <h4>The workbook keeps itself current</h4>
      <div class="fresh" aria-hidden="true">June-expenses.xlsx · up to date ✓</div>
      <p>
        Every new receipt will be read and filed; download the workbook
        whenever you need it.
      </p>
    </div>
  </div>

  <p class="trust">
    <strong>Reading still happens in your browser.</strong> Your workspace is
    private to you, protected by row-level security; nothing is shared until
    you sign in.
  </p>
</section>

<style>
  .head-row {
    display: flex;
    align-items: baseline;
    gap: 0.9rem;
    flex-wrap: wrap;
  }
  .lede {
    color: var(--ink-soft);
    max-width: 44rem;
  }

  .flow {
    display: grid;
    grid-template-columns: 1fr auto 1fr auto 1fr;
    gap: 0.9rem;
    align-items: stretch;
    margin-top: 1.4rem;
  }
  .step {
    position: relative;
    padding: 1.25rem;
    display: grid;
    gap: 0.7rem;
    align-content: start;
  }
  .step.done {
    border-color: var(--accent-line);
  }
  .step h4 {
    margin: 0;
    font-size: 0.97rem;
  }
  .step p {
    font-size: 0.82rem;
    line-height: 1.5;
    color: var(--ink-soft);
    margin: 0;
  }
  .step-n {
    display: inline-grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    font: 700 0.82rem/1 var(--font-display);
  }
  .corner {
    position: absolute;
    top: 0.8rem;
    right: 0.8rem;
  }

  .g-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.6rem;
    justify-self: start;
    background: var(--bg);
    border: 1px solid var(--line-strong);
    border-radius: 10px;
    padding: 0.55rem 0.85rem;
    font: 600 0.84rem/1 var(--font-ui);
    color: var(--ink);
  }
  .g-mark {
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1.5px solid var(--ink-soft);
    font: 700 0.68rem/1 var(--font-ui);
    color: var(--ink-soft);
  }

  .folder {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 0.6rem 0.85rem;
    font: 500 0.78rem/1.4 var(--font-mono);
    color: var(--ink);
  }
  .scanning {
    margin-top: 0.35rem;
    font-size: 0.69rem;
    color: var(--ink-faint);
    animation: db-blink 1.6s ease-in-out infinite;
  }

  .fresh {
    justify-self: start;
    font: 600 0.78rem/1.4 var(--font-mono);
    padding: 0.45rem 0.75rem;
    border-radius: var(--radius-pill);
    background: var(--accent-soft);
    color: var(--accent);
    animation: db-glow 2.8s ease-in-out infinite;
  }

  .flow-arrow {
    align-self: center;
    color: var(--accent);
    animation: db-nudge-x 2.8s ease-in-out infinite;
  }

  .trust {
    color: var(--ink-soft);
    max-width: 44rem;
    margin: 1.4rem 0 0;
    font-size: 0.92rem;
  }
  .trust strong {
    color: var(--ink);
  }

  @keyframes db-blink {
    0%, 100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
  @keyframes db-glow {
    0%, 100% {
      box-shadow: 0 0 0 0 var(--accent-soft);
    }
    50% {
      box-shadow: 0 0 0 6px var(--accent-soft);
    }
  }
  @keyframes db-nudge-x {
    0%, 100% {
      transform: translateX(0);
      opacity: 0.55;
    }
    50% {
      transform: translateX(4px);
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .scanning {
      animation: none;
      opacity: 1;
    }
    .fresh {
      animation: none;
      box-shadow: none;
    }
    .flow-arrow {
      animation: none;
      opacity: 1;
      transform: none;
    }
  }

  @media (max-width: 900px) {
    .flow {
      grid-template-columns: 1fr;
      justify-items: stretch;
    }
    .flow-arrow {
      justify-self: center;
    }
    .flow-arrow svg {
      transform: rotate(90deg);
    }
  }
</style>
