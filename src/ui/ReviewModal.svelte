<script lang="ts">
  import { app } from "./state.svelte.ts";
  import { repo } from "../store/repo.ts";
  import { CATEGORIES } from "../config/categories.ts";
  import { parseAmount, safeAmount } from "../util/money.ts";
  import { isValidIso } from "../util/format.ts";
  import { receiptFileName } from "../util/rename.ts";
  import { annotateReceipt, HIGHLIGHT_COLORS } from "../pipeline/annotate.ts";
  import { buildCorrectionRecords, appendCorrections } from "../train/corrections.ts";
  import type { Receipt, BBox, Category, OcrLine, Field } from "../types.ts";

  // The review sweep: board → modal → keyboard Approve & Next. On-image markers
  // and per-field zoomed callouts show each extracted value beside the slice of
  // the receipt it came from, so a human can confirm a batch in seconds.

  const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF", "INR", "MXN", "CNY"];

  const list = $derived(app.receipts);
  const index = $derived(list.findIndex((r) => r.id === app.reviewId));
  const current = $derived(index >= 0 ? list[index] : undefined);

  // Editable copies (re-seeded whenever the open receipt changes). The amount
  // and tax fields are number inputs — Svelte rebinds them as numbers after a
  // user edit, so their type is honest about carrying either.
  let vendor = $state("");
  let date = $state("");
  let amount = $state<string | number>("");
  let tax = $state<string | number>("");
  let currency = $state("USD");
  let category = $state<Category>("Other");

  let imgEl = $state<HTMLImageElement | null>(null);
  let imgLoaded = $state(false);
  let imageUrl = $state<string | null>(null);
  let seededId: string | null = null;

  $effect(() => {
    const r = current;
    if (!r || r.id === seededId) return;
    seededId = r.id;
    vendor = r.vendor.value;
    date = r.date.value;
    amount = r.amount.value ? String(r.amount.value) : "";
    tax = r.tax.value ? String(r.tax.value) : "";
    currency = r.currency;
    category = r.category.value;
    imgLoaded = false;
    imageUrl = null;
    void app.blobUrl(r.cleanedKey ?? r.fileKey).then((u) => (imageUrl = u));
  });

  function close(): void {
    app.reviewId = null;
    seededId = null;
  }

  function go(delta: number): void {
    const next = index + delta;
    if (next < 0 || next >= list.length) return;
    const target = list[next];
    if (target) app.reviewId = target.id;
  }

  function patchFromForm(receipt: Receipt): Partial<Receipt> {
    // Unwrap the $state proxy: IndexedDB's structuredClone can't clone proxies,
    // and this patch carries nested objects (bboxes) from the reactive record.
    const r = $state.snapshot(receipt) as Receipt;
    const amt = parseAmount(amount);
    const tx = parseAmount(tax);
    const newVendor = vendor.trim();
    const newDate = date && isValidIso(date) ? date : r.date.value;
    const newAmount = amt !== null ? safeAmount(amt) : r.amount.value;
    return {
      vendor: { value: newVendor, confidence: 1, edited: true, ...(r.vendor.bbox ? { bbox: r.vendor.bbox } : {}) },
      date: {
        value: newDate,
        confidence: 1,
        edited: true,
        ...(r.date.bbox ? { bbox: r.date.bbox } : {}),
      },
      amount: {
        value: newAmount,
        confidence: 1,
        edited: true,
        ...(r.amount.bbox ? { bbox: r.amount.bbox } : {}),
      },
      tax: { value: tx !== null ? safeAmount(tx) : r.tax.value, confidence: 1, edited: true },
      currency: currency.toUpperCase(),
      category: { value: category, confidence: 1, edited: true },
      // Edits change the fields the file is named after — keep it in sync
      // (same amount>0 gate as the pipeline: failed reads keep their name).
      ...(newAmount > 0
        ? {
            fileName: receiptFileName({
              category,
              date: newDate,
              vendor: newVendor,
              fileName: r.originalFileName ?? r.fileName,
            }),
          }
        : {}),
      originalFileName: r.originalFileName ?? r.fileName,
    };
  }

  /** Apply a review patch, closing the improvement loop: locate each
   *  corrected value on the receipt, move its highlight there, re-bake the
   *  annotated copy, and log the correction for training. */
  async function applyPatch(receipt: Receipt, patch: Partial<Receipt>): Promise<void> {
    const r = $state.snapshot(receipt) as Receipt;
    const lines = (r.ocrLines ?? []) as OcrLine[];
    const records = buildCorrectionRecords(r, patch, lines);

    // Corrected values that were found printed on the receipt get their
    // provenance boxes moved — markers, callouts and baked highlights all
    // follow the human's value from now on.
    for (const rec of records) {
      if (!rec.bbox) continue;
      if (rec.field === "vendor" || rec.field === "date") {
        const f = patch[rec.field] as Field<string> | undefined;
        if (f) f.bbox = rec.bbox;
      } else if (rec.field === "amount") {
        const f = patch.amount as Field<number> | undefined;
        if (f) f.bbox = rec.bbox;
      }
    }

    // Re-bake the highlighter copy whenever a highlighted field changed;
    // fall back to the clean image if the bake fails.
    const oldKey = r.annotatedKey;
    const highlightedChanged = records.some(
      (rec) => rec.field === "vendor" || rec.field === "date" || rec.field === "amount",
    );
    if (highlightedChanged) {
      let newKey: string | undefined;
      try {
        const cleanBlob = r.cleanedKey ? await repo.getBlob(r.cleanedKey) : undefined;
        if (cleanBlob) {
          const box = (field: "vendor" | "date" | "amount"): BBox | undefined =>
            (patch[field] as Field<unknown> | undefined)?.bbox ?? r[field].bbox;
          const marks = [
            ...(box("vendor") ? [{ bbox: box("vendor")!, color: HIGHLIGHT_COLORS.vendor }] : []),
            ...(box("date") ? [{ bbox: box("date")!, color: HIGHLIGHT_COLORS.date }] : []),
            ...(box("amount") ? [{ bbox: box("amount")!, color: HIGHLIGHT_COLORS.amount }] : []),
          ];
          const baked = await annotateReceipt(cleanBlob, marks);
          if (baked) newKey = await repo.putBlob(baked, "annotated");
        }
      } catch {
        /* highlights are pure upside */
      }
      patch.annotatedKey = newKey; // undefined = clean image fallback
    }

    await repo.updateReceipt(r.id, patch);
    if (highlightedChanged && oldKey && patch.annotatedKey !== oldKey) {
      await repo.deleteBlob(oldKey).catch(() => {});
    }
    await appendCorrections(records).catch(() => {});
  }

  async function save(): Promise<void> {
    const r = current;
    if (!r) return;
    await applyPatch(r, patchFromForm(r));
  }

  async function approveAndNext(): Promise<void> {
    const r = current;
    if (!r) return;
    const patch = patchFromForm(r);
    const amountOk = (patch.amount?.value ?? r.amount.value) > 0;
    const keptFlags = ($state.snapshot(r.flags) as Receipt["flags"]).filter(
      (f) => f.severity === "error" && f.code === "no_amount",
    );
    await applyPatch(r, {
      ...patch,
      approved: true,
      reviewRequired: false,
      status: "done",
      flags: amountOk ? [] : keptFlags,
    });
    // Advance to the next receipt that still wants a look; else next; else done.
    const fresh = app.receipts;
    const after = fresh.findIndex(
      (x, i) => i > index && x.reviewRequired && !x.approved,
    );
    if (after >= 0) {
      const target = fresh[after];
      if (target) app.reviewId = target.id;
    } else if (index < fresh.length - 1) {
      const target = fresh[index + 1];
      if (target) app.reviewId = target.id;
    } else {
      app.toast("All caught up. Every receipt reviewed.", "ok");
      close();
    }
  }

  async function deleteCurrent(): Promise<void> {
    const r = current;
    if (!r) return;
    // Deletes immediately — a blocking confirm dialog here was unwanted
    // friction (the button is explicit and the modal shows what it targets).
    const wasIndex = index;
    await app.deleteReceipt(r.id);
    const fresh = app.receipts;
    if (fresh.length === 0) close();
    else {
      const target = fresh[Math.min(wasIndex, fresh.length - 1)];
      if (target) app.reviewId = target.id;
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (!current) return;
    const tag = (e.target as HTMLElement)?.tagName;
    const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
    if (e.key === "Escape") {
      close();
      return;
    }
    // Approve & Next works even while typing (Enter), for a fast sweep.
    if (e.key === "Enter") {
      e.preventDefault();
      void approveAndNext();
      return;
    }
    if (typing) return;
    if (e.key === "ArrowRight" || e.key.toLowerCase() === "n") go(1);
    else if (e.key === "ArrowLeft" || e.key.toLowerCase() === "p") go(-1);
    else if (e.key.toLowerCase() === "a") void approveAndNext();
  }

  /** Svelte action: render a zoomed crop of the receipt around a bbox. */
  function callout(canvas: HTMLCanvasElement, bbox: BBox | undefined): { update: (b: BBox | undefined) => void } {
    const draw = (b: BBox | undefined) => {
      const img = imgEl;
      if (!b || !img || !imgLoaded || b.w <= 0 || b.h <= 0) return;
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      if (!iw || !ih) return;
      const padX = b.w * 0.12;
      const padY = b.h * 0.5;
      const sx = Math.max(0, (b.x - padX) * iw);
      const sy = Math.max(0, (b.y - padY) * ih);
      const sw = Math.min(iw - sx, (b.w + padX * 2) * iw);
      const sh = Math.min(ih - sy, (b.h + padY * 2) * ih);
      if (sw <= 0 || sh <= 0) return;
      const scale = Math.min(230 / sw, 60 / sh, 4);
      canvas.width = Math.max(1, Math.round(sw * scale));
      canvas.height = Math.max(1, Math.round(sh * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    };
    draw(bbox);
    return { update: draw };
  }

  const markers = $derived.by(() => {
    const r = current;
    if (!r) return [];
    const list: { cls: string; label: string; bbox: BBox }[] = [];
    const add = (bbox: BBox | undefined, cls: string, label: string) => {
      if (bbox && bbox.w > 0 && bbox.h > 0) list.push({ cls, label, bbox });
    };
    add(r.vendor.bbox, "m-vendor", "Vendor");
    add(r.date.bbox, "m-date", "Date");
    add(r.amount.bbox, "m-amount", "Total");
    return list;
  });
</script>

<svelte:window onkeydown={onKey} />

{#if current}
  <div
    class="scrim"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) close();
    }}
  >
    <div class="modal card" role="dialog" aria-modal="true" aria-label="Review receipt">
      <header class="m-head">
        <strong>Review receipt</strong>
        <span class="muted">{index + 1} of {list.length}</span>
        {#if current.reviewRequired && !current.approved}
          <span class="chip chip-warn">needs review</span>
        {:else if current.approved}
          <span class="chip chip-ok">approved</span>
        {/if}
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" onclick={close}>Close ✕</button>
      </header>

      <div class="m-body">
        <div class="m-image">
          {#if imageUrl}
            <div class="imgwrap">
              <img
                bind:this={imgEl}
                src={imageUrl}
                alt={current.fileName}
                onload={() => (imgLoaded = true)}
              />
              {#if imgLoaded}
                <div class="overlay" aria-hidden="true">
                  {#each markers as m (m.label)}
                    <div
                      class="marker {m.cls}"
                      style="left:{m.bbox.x * 100}%;top:{m.bbox.y * 100}%;width:{m.bbox.w * 100}%;height:{m.bbox.h * 100}%"
                    >
                      <span>{m.label}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {:else}
            <div class="imgwrap skeleton" style="min-height:300px"></div>
          {/if}
        </div>

        <div class="m-form">
          <div class="frow f-vendor">
            <label for="rv-vendor">Vendor</label>
            <input id="rv-vendor" type="text" bind:value={vendor} onchange={save} />
            {#if imgLoaded && current.vendor.bbox}
              {#key current.id}
                <canvas class="callout" use:callout={current.vendor.bbox}></canvas>
              {/key}
            {/if}
          </div>

          <div class="frow f-date">
            <label for="rv-date">Date</label>
            <input id="rv-date" type="date" bind:value={date} onchange={save} />
            {#if imgLoaded && current.date.bbox}
              {#key current.id}
                <canvas class="callout" use:callout={current.date.bbox}></canvas>
              {/key}
            {/if}
          </div>

          <div class="frow f-amount">
            <label for="rv-amount">Amount</label>
            <div class="amount-grid">
              <input
                id="rv-amount"
                type="number"
                step="0.01"
                min="0"
                bind:value={amount}
                onchange={save}
              />
              <select aria-label="Currency" bind:value={currency} onchange={save}>
                {#each [...new Set([current.currency, ...CURRENCIES])] as c (c)}
                  <option value={c}>{c}</option>
                {/each}
              </select>
            </div>
            {#if imgLoaded && current.amount.bbox}
              {#key current.id}
                <canvas class="callout" use:callout={current.amount.bbox}></canvas>
              {/key}
            {/if}
          </div>

          <div class="frow">
            <label for="rv-tax">Tax</label>
            <input id="rv-tax" type="number" step="0.01" min="0" bind:value={tax} onchange={save} />
          </div>

          <div class="frow">
            <label for="rv-cat">Category</label>
            <select id="rv-cat" bind:value={category} onchange={save}>
              {#each CATEGORIES as c (c)}
                <option value={c}>{c}</option>
              {/each}
            </select>
          </div>

          {#if current.flags.length}
            <div class="flags">
              {#each current.flags as f (f.code + f.message)}
                <div class="flag {f.severity}">
                  <span>{f.severity === "error" ? "⛔" : f.severity === "warn" ? "⚠️" : "ℹ️"}</span>
                  <span>{f.message}</span>
                </div>
              {/each}
            </div>
          {/if}

          <p class="provenance muted">
            {current.methodUsed === "paid"
              ? `Read by ${current.methodDetail ?? "AI assist"}`
              : "Read on-device"}
            {#if current.logoMatch}
              · brand via {current.logoMatch.source === "logo" ? "visual logo" : current.logoMatch.source}
              ({Math.round(current.logoMatch.score * 100)}%)
            {/if}
            · {Math.round(current.confidence * 100)}% confidence
          </p>
        </div>
      </div>

      <footer class="m-foot">
        <button class="btn btn-sm" onclick={() => go(-1)} disabled={index <= 0}>← Prev</button>
        <button class="btn btn-sm" onclick={() => go(1)} disabled={index >= list.length - 1}>Next →</button>
        <button class="btn btn-sm btn-danger" onclick={deleteCurrent}>Delete</button>
        <span class="spacer"></span>
        <span class="kbd">Enter</span>
        <button class="btn btn-primary" onclick={approveAndNext}>Approve &amp; Next</button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgb(10 8 6 / 0.55);
    backdrop-filter: blur(3px);
    display: grid;
    place-items: center;
    padding: 1rem;
    z-index: 50;
  }
  .modal {
    width: min(1040px, 100%);
    max-height: min(92dvh, 100%);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: var(--shadow-3);
  }
  .m-head,
  .m-foot {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    padding: 0.85rem 1.1rem;
  }
  .m-head {
    border-bottom: 1px solid var(--line);
  }
  .m-foot {
    border-top: 1px solid var(--line);
  }
  .spacer {
    flex: 1;
  }

  .m-body {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(300px, 1fr);
    gap: 1.1rem;
    padding: 1.1rem;
    overflow: auto;
  }
  @media (max-width: 800px) {
    .m-body {
      grid-template-columns: 1fr;
    }
  }

  .imgwrap {
    position: relative;
    border-radius: var(--radius-m);
    overflow: hidden;
    background: var(--bg-sunken);
  }
  .imgwrap img {
    width: 100%;
    height: auto;
  }
  .overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .marker {
    position: absolute;
    border: 2px solid;
    border-radius: 4px;
    box-shadow: 0 0 0 2000px rgb(0 0 0 / 0.03);
  }
  .marker span {
    position: absolute;
    top: -1.35rem;
    left: -2px;
    font: 700 0.62rem/1 var(--font-ui);
    letter-spacing: 0.05em;
    text-transform: uppercase;
    padding: 0.18rem 0.4rem;
    border-radius: 4px;
    color: #fff;
    white-space: nowrap;
  }
  .m-vendor {
    border-color: var(--cat-3);
  }
  .m-vendor span {
    background: var(--cat-3);
  }
  .m-date {
    border-color: var(--err);
  }
  .m-date span {
    background: var(--err);
  }
  .m-amount {
    border-color: var(--ok);
  }
  .m-amount span {
    background: var(--ok);
    color: var(--accent-ink);
  }

  .m-form {
    display: grid;
    gap: 0.9rem;
    align-content: start;
  }
  .frow {
    display: grid;
    gap: 0.3rem;
  }
  /* Field tint matches its on-image marker color. */
  .f-vendor input {
    border-left: 3px solid var(--cat-3);
  }
  .f-date input {
    border-left: 3px solid var(--err);
  }
  .f-amount input {
    border-left: 3px solid var(--ok);
  }
  .amount-grid {
    display: grid;
    grid-template-columns: 1fr 6.2rem;
    gap: 0.5rem;
  }
  .callout {
    margin-top: 0.15rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: #fff;
    max-width: 100%;
  }

  .flags {
    display: grid;
    gap: 0.4rem;
  }
  .flag {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    font-size: 0.88rem;
    padding: 0.5rem 0.7rem;
    border-radius: var(--radius-s);
    background: var(--bg-sunken);
  }
  .flag.warn {
    background: var(--gold-soft);
    color: var(--gold);
  }
  .flag.error {
    background: var(--err-soft);
    color: var(--err);
  }
  .provenance {
    font-size: 0.8rem;
    margin: 0;
  }
</style>
