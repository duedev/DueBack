<script lang="ts">
  import { app } from "../state.svelte.ts";
  import type { Receipt } from "../../types.ts";

  // Static site, no server: the form opens the visitor's own mail app via a
  // prefilled mailto: draft. mailto can't attach files, so the "attach my
  // tuning bundle" checkbox (ON by default — the bundle is what makes
  // feedback actionable) downloads the ZIP first and the draft asks the
  // sender to attach it — honest, works everywhere, no third-party service.
  const CONTACT_EMAIL = "contact@duanehamilton.net";
  let cName = $state("");
  let cMsg = $state("");
  let cAttach = $state(true);
  let cBusy = $state(false);

  async function sendMessage(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!cMsg.trim()) return;
    cBusy = true;
    let attachNote = "";
    try {
      if (cAttach) {
        const { buildTuningBundle, downloadBundle } = await import("../../train/bundle.ts");
        const receipts = $state.snapshot(app.receipts) as Receipt[];
        const bundle = await buildTuningBundle(receipts);
        downloadBundle(bundle);
        attachNote =
          `

(P.S. Please attach the file "${bundle.fileName}" that just downloaded. ` +
          `It holds my ${bundle.receiptCount} receipts' extraction data and ` +
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
</script>

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
        Attach my tuning bundle: extraction data, corrections and images,
        zipped so the developer can reproduce exactly what you saw.
      </span>
    </label>
    <div class="c-actions">
      <button
        class="btn btn-primary"
        disabled={cBusy}
        title={`Opens your mail app addressed to ${CONTACT_EMAIL}.${cAttach ? " The tuning-bundle ZIP downloads first; attach it to the email before sending." : ""}`}
      >
        {cBusy ? "Packaging…" : "Send email"}
      </button>
    </div>
  </form>
</section>

<style>
  .contact {
    padding-block: 2.5rem;
  }
  .contact-card {
    display: grid;
    gap: 1rem;
    max-width: 40rem;
    padding: 1.4rem;
    margin-inline: auto; /* centered — hugging the left edge looked unfinished */
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
    background: var(--bg-raised);
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
    text-transform: none;
    letter-spacing: 0;
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
