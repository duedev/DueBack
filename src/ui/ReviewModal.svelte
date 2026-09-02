<script lang="ts">
  import { app } from "./state.svelte.ts";
  import { repo } from "../store/repo.ts";
  import { CATEGORIES } from "../config/categories.ts";
  import { parseAmount, safeAmount } from "../util/money.ts";
  import { isValidIso } from "../util/format.ts";
  import { receiptFileName } from "../util/rename.ts";
  import { annotateReceipt, HIGHLIGHT_COLORS } from "../pipeline/annotate.ts";
  import { buildCorrectionRecords, appendCorrections } from "../train/corrections.ts";
  import { locateValue, readValueInBox } from "../pipeline/extract.ts";
  import type { Receipt, BBox, Category, OcrLine, Field, Flag } from "../types.ts";

  // The review sweep: board → modal → keyboard Approve & Next. On-image markers
  // and per-field zoomed callouts show each extracted value beside the slice of
  // the receipt it came from, so a human can confirm a batch in seconds.

  const list = $derived(app.receipts);
  const index = $derived(list.findIndex((r) => r.id === app.reviewId));
  const current = $derived(index >= 0 ? list[index] : undefined);

  // Editable copies (re-seeded whenever the open receipt changes). The amount
  // and tax fields are number inputs — Svelte rebinds them as numbers after a
  // user edit, so their type is honest about carrying either.
  let vendor = $state("");
  let date = $state("");
  let amount = $state<string | number>("");
  let category = $state<Category>("Other");

  let imgEl = $state<HTMLImageElement | null>(null);
  let imgLoaded = $state(false);
  let imageUrl = $state<string | null>(null);
  let seededId: string | null = null;
  /** The record version the form was seeded from, and what it was seeded
   *  with — so a receipt that finishes processing (or syncs) while its
   *  card is open re-seeds the form instead of letting Approve write the
   *  stale empty values over the machine's read. Only an UNTOUCHED form is
   *  re-seeded; typed edits always win. */
  let seededAt = 0;
  let seededImageKey: string | undefined;
  let seeded = { vendor: "", date: "", amount: "", category: "" };

  function formUntouched(): boolean {
    return (
      vendor === seeded.vendor &&
      date === seeded.date &&
      amount === seeded.amount &&
      category === seeded.category
    );
  }

  $effect(() => {
    const r = current;
    if (!r) return;
    const sameReceipt = r.id === seededId;
    if (sameReceipt && r.updatedAt === seededAt) return;
    if (sameReceipt && !formUntouched()) {
      // The human is mid-edit: keep their form, but follow a fresh image
      // (the pipeline swapped the raw upload for the cleaned copy).
      const key = r.cleanedKey ?? r.fileKey;
      if (key !== seededImageKey) {
        seededImageKey = key;
        const id = r.id;
        void app.blobUrl(key).then((u) => {
          if (seededId === id) imageUrl = u;
        });
      }
      seededAt = r.updatedAt;
      return;
    }
    seededId = r.id;
    seededAt = r.updatedAt;
    vendor = r.vendor.value;
    date = r.date.value;
    amount = r.amount.value ? String(r.amount.value) : "";
    category = r.category.value;
    seeded = { vendor, date, amount, category };
    imgLoaded = false;
    imageUrl = null;
    const id = r.id;
    const key = r.cleanedKey ?? r.fileKey;
    seededImageKey = key;
    void app.blobUrl(key).then((u) => {
      // Rapid prev/next: the LAST promise to resolve would win otherwise —
      // only the still-current receipt may set the image.
      if (seededId === id) imageUrl = u;
    });
  });

  // ---- Focus management (role=dialog + aria-modal promise it) -------------
  let dialogEl = $state<HTMLElement | null>(null);

  // On open, remember what had focus and move it into the dialog; on close
  // ({#if} unmount → bind:this null) the effect cleanup gives it back.
  $effect(() => {
    const el = dialogEl;
    if (!el) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.focus();
    return () => prev?.focus();
  });

  /** Keep Tab cycling inside the dialog instead of walking the obscured board. */
  function trapTab(e: KeyboardEvent): void {
    if (e.key !== "Tab" || !dialogEl) return;
    const focusables = Array.from(
      dialogEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogEl)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

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
    const newVendor = vendor.trim();
    // The native date input fires a change per typed segment ("0002-09-11",
    // "0020-09-11", …) — a year outside a sane range is a partial entry,
    // not a correction, and must not save/rename/log.
    const saneYear = (iso: string): boolean => {
      const y = Number(iso.slice(0, 4));
      return y >= 1990 && y <= 2100;
    };
    const newDate = date && isValidIso(date) && saneYear(date) ? date : r.date.value;
    const newAmount = amt !== null ? safeAmount(amt) : r.amount.value;
    // Boxes (and their hand-drawn flag) survive every save.
    const keepBox = (f: Field<unknown>) => ({
      ...(f.bbox ? { bbox: f.bbox } : {}),
      ...(f.manualBox ? { manualBox: true } : {}),
    });
    // `edited` marks a HUMAN change: it is what the training log, the
    // relocation ("an edited value that can't be found keeps no box") and
    // the pipeline's touched-before-claim guard read. Stamping it on every
    // field of every save dropped provenance boxes on values nobody touched.
    const edited = (f: Field<unknown>, value: unknown) =>
      f.value !== value || f.edited ? { edited: true } : {};
    return {
      vendor: {
        value: newVendor,
        confidence: 1,
        ...edited(r.vendor, newVendor),
        ...keepBox(r.vendor),
      },
      date: {
        value: newDate,
        confidence: 1,
        ...edited(r.date, newDate),
        ...keepBox(r.date),
      },
      amount: {
        value: newAmount,
        confidence: 1,
        ...edited(r.amount, newAmount),
        ...keepBox(r.amount),
      },
      currency: "USD", // USD-only app — a save normalizes any legacy value
      category: { value: category, confidence: 1, ...edited(r.category, category) },
      // Edits change the fields the file is named after — keep it in sync
      // (same amount>0 gate as the pipeline: failed reads keep their name).
      ...(newAmount > 0
        ? {
            fileName: receiptFileName({
              category,
              date: newDate,
              vendor: newVendor,
            }),
          }
        : {}),
      originalFileName: r.originalFileName ?? r.fileName,
    };
  }

  /** Apply a review patch, closing the improvement loop: locate each
   *  corrected value on the receipt, move its highlight there, re-bake the
   *  annotated copy, and log the correction for training. */
  /** Saves are serialized: a field's change event and the Approve click it
   *  precedes fire back to back, and two concurrent applyPatch calls logged
   *  the correction twice and orphaned an annotated blob. Each call also
   *  diffs against the receipt as STORED (not the snapshot taken before the
   *  previous save landed), so the second call finds nothing new to log. */
  let inflight: Promise<void> = Promise.resolve();
  function applyPatch(receipt: Receipt, patch: Partial<Receipt>): Promise<void> {
    const next = inflight.then(() => applyPatchNow(receipt, patch));
    inflight = next.catch(() => {});
    return next;
  }

  async function applyPatchNow(receipt: Receipt, patch: Partial<Receipt>): Promise<void> {
    const r = ((await repo.getReceipt(receipt.id)) ?? $state.snapshot(receipt)) as Receipt;
    const lines = (r.ocrLines ?? []) as OcrLine[];
    const records = buildCorrectionRecords(r, patch, lines);

    // Re-locate ALL highlighted fields on every save — not just the ones
    // changed in THIS patch — so a receipt corrected earlier (or before
    // relocation existed) heals the moment it's saved or approved. A
    // human-edited value that can't be found keeps NO box: a highlight on
    // the old misread is worse than none.
    let boxesMoved = false;
    for (const kind of ["vendor", "date", "amount"] as const) {
      const f = patch[kind] as Field<string | number> | undefined;
      if (!f) continue;
      const prev = r[kind].bbox;
      if (f.manualBox) {
        // A hand-drawn box is ground truth — relocation must never move it.
      } else if (lines.length > 0 && f.value) {
        const hit = locateValue(lines, kind, f.value);
        if (hit) f.bbox = hit.bbox;
        else if (f.edited) delete f.bbox;
      } else if (f.edited && f.value !== r[kind].value) {
        delete f.bbox; // no OCR geometry stored — drop the stale box
      }
      if (JSON.stringify(f.bbox ?? null) !== JSON.stringify(prev ?? null)) {
        boxesMoved = true;
      }
    }

    // Re-bake the highlighter copy whenever a highlighted field changed or
    // its box moved; fall back to the clean image if the bake fails.
    const oldKey = r.annotatedKey;
    const highlightedChanged =
      boxesMoved ||
      records.some(
        (rec) => rec.field === "vendor" || rec.field === "date" || rec.field === "amount",
      );
    if (highlightedChanged) {
      let newKey: string | undefined;
      try {
        const cleanBlob = r.cleanedKey ? await repo.getBlob(r.cleanedKey) : undefined;
        if (cleanBlob) {
          const box = (field: "vendor" | "date" | "amount"): BBox | undefined => {
            const f = patch[field] as Field<unknown> | undefined;
            // A field present in the patch OWNS its box: an intentionally
            // removed box (a corrected value that can't be located) must not
            // resurrect the stale mark from the old extraction.
            return f ? f.bbox : r[field].bbox;
          };
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

  /** Flags that no longer apply once a human changed the field they
   *  question: a save (onchange) used to keep "No date found" beside the
   *  date the user just typed, and the card kept its warn banner. Only ever
   *  REMOVES flags; approval, status and reviewRequired stay untouched — the
   *  receipt still needs its explicit Approve. */
  function flagsAfterEdit(r: Receipt, patch: Partial<Receipt>): Flag[] | undefined {
    const changed = (["vendor", "date", "amount", "category"] as const).filter(
      (k) => patch[k] !== undefined && patch[k]!.value !== r[k].value,
    );
    if (changed.length === 0) return undefined;
    const gone = new Set<string>(changed);
    const kept = r.flags.filter((f) => !gone.has(FLAG_FIELD[f.code] ?? ""));
    return kept.length === r.flags.length ? undefined : kept;
  }

  async function save(): Promise<void> {
    const r = current;
    if (!r) return;
    const patch = patchFromForm(r);
    const flags = flagsAfterEdit($state.snapshot(r) as Receipt, patch);
    if (flags) patch.flags = flags;
    await applyPatch(r, patch);
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
    // Advance ONLY through receipts that still need review (after this one,
    // wrapping to earlier ones) — the sweep must not cycle back through
    // already-done receipts. When none remain, the sweep is over. app.receipts
    // is still the PRE-save array here (refresh is async), so the just-approved
    // receipt must be excluded by id or the last one re-selects itself.
    const fresh = app.receipts;
    const after = fresh.find(
      (x, i) => i > index && x.id !== r.id && x.reviewRequired && !x.approved,
    );
    const target =
      after ?? fresh.find((x) => x.id !== r.id && x.reviewRequired && !x.approved);
    if (target) {
      app.reviewId = target.id;
    } else {
      // The sweep is over — every receipt reviewed. Worth a moment.
      void import("./confetti.ts").then((m) => m.celebrate());
      app.toast("All caught up. Every receipt reviewed.", "ok");
      close();
    }
  }

  async function deleteCurrent(): Promise<void> {
    const r = current;
    if (!r) return;
    // Deletes immediately — a blocking confirm dialog here was unwanted
    // friction (the button is explicit and the modal shows what it targets).
    // Pick the successor from the PRE-delete list, before the await:
    // app.receipts still contains the deleted receipt afterwards (refresh is
    // async), so a post-await read re-selected the deleted id and closed.
    const rest = list.filter((x) => x.id !== r.id);
    const target = rest[Math.min(index, rest.length - 1)];
    await app.deleteReceipt(r.id);
    if (target) app.reviewId = target.id;
    else close();
  }

  async function retryRead(): Promise<void> {
    const r = current;
    if (!r) return;
    if (await app.retryReceipt(r.id)) app.toast("Reading again…", "info");
  }

  function onKey(e: KeyboardEvent): void {
    if (!current) return;
    const tag = (e.target as HTMLElement)?.tagName;
    const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
    if (e.key === "Escape") {
      // Escape backs out of draw mode first; a second press closes.
      if (drawField) {
        cancelDraw();
        return;
      }
      close();
      return;
    }
    // Approve & Next works even while typing (Enter), for a fast sweep — but
    // Enter on a focused control must activate THAT control, not approve
    // (otherwise Delete/Close/Prev/Next and open selects all approve).
    if (e.key === "Enter") {
      if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY" || tag === "SELECT") return;
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

  // Each flag renders beside the field it questions, so the reason and the
  // fix share one glance (and one scroll position on a phone). Codes with no
  // home field stay in the general list under the form.
  const FLAG_FIELD: Record<string, "vendor" | "date" | "amount" | "category"> = {
    no_vendor: "vendor",
    vendor_unclear: "vendor",
    logo_mismatch: "vendor",
    no_date: "date",
    future_date: "date",
    stale_date: "date",
    no_amount: "amount",
    total_mismatch: "amount",
    total_suspect: "amount",
    large_amount: "amount",
    uncategorized: "category",
  };
  function flagsFor(field: "vendor" | "date" | "amount" | "category") {
    return (current?.flags ?? []).filter((f) => FLAG_FIELD[f.code] === field);
  }
  const generalFlags = $derived(
    (current?.flags ?? []).filter((f) => !FLAG_FIELD[f.code]),
  );

  // ---- Manual box drawing -------------------------------------------------
  // "Mark on image": pick a field, drag a rectangle on the receipt, and that
  // becomes the field's box — highlighted, re-baked into the annotated copy,
  // and protected from automatic relocation (Field.manualBox).
  type DrawField = "vendor" | "date" | "amount";
  let drawField = $state<DrawField | null>(null);
  let dragStart: { x: number; y: number } | null = null;
  let dragRect = $state<BBox | null>(null);

  /** Pointer position normalized to the receipt image's frame. */
  function normPoint(e: PointerEvent): { x: number; y: number } | null {
    const img = imgEl;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  }

  function drawDown(e: PointerEvent): void {
    if (!drawField) return;
    const p = normPoint(e);
    if (!p) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStart = p;
    dragRect = { x: p.x, y: p.y, w: 0, h: 0 };
  }

  function drawMove(e: PointerEvent): void {
    if (!drawField || !dragStart) return;
    const p = normPoint(e);
    if (!p) return;
    dragRect = {
      x: Math.min(dragStart.x, p.x),
      y: Math.min(dragStart.y, p.y),
      w: Math.abs(p.x - dragStart.x),
      h: Math.abs(p.y - dragStart.y),
    };
  }

  async function drawUp(): Promise<void> {
    const field = drawField;
    // Snapshot: dragRect is a $state proxy, and a proxy inside the patch
    // makes IndexedDB's structuredClone throw — the box then silently never
    // persisted (the original "marks don't stick" bug).
    const box = dragRect ? ($state.snapshot(dragRect) as BBox) : null;
    dragStart = null;
    dragRect = null;
    drawField = null;
    // A sub-1% smear is a slip, not a box.
    if (!field || !box || !current || box.w < 0.01 || box.h < 0.005) return;
    // The box also ANSWERS: read the stored OCR geometry inside it and
    // autofill the field, so drawing on the right line fixes the value too.
    const lines = ($state.snapshot(current.ocrLines ?? []) as OcrLine[]) ?? [];
    const read = readValueInBox(lines, field, box);
    if (read !== null && read !== "") {
      if (field === "vendor") vendor = String(read);
      else if (field === "date") date = String(read);
      else amount = String(read);
    }
    // Build the patch AFTER the autofill so the new value rides along.
    const patch = patchFromForm(current);
    const f = patch[field] as Field<string | number>;
    f.bbox = box;
    f.manualBox = true;
    // The autofill changed a value too: drop the flag that questioned it.
    const flags = flagsAfterEdit($state.snapshot(current) as Receipt, patch);
    if (flags) patch.flags = flags;
    await applyPatch(current, patch);
  }

  function cancelDraw(): void {
    dragStart = null;
    dragRect = null;
    drawField = null;
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
    <div
      class="modal card"
      role="dialog"
      aria-modal="true"
      aria-label="Review receipt"
      tabindex="-1"
      bind:this={dialogEl}
      onkeydown={trapTab}
    >
      <header class="m-head">
        <strong>Review receipt</strong>
        <span class="muted">{index + 1} of {list.length}</span>
        {#if current.approved}
          <span class="chip chip-ok">approved</span>
        {/if}
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" onclick={close}>Close ✕</button>
      </header>

      <div class="m-body">
        <div class="m-image">
          {#if imageUrl}
            <!-- svelte-ignore a11y_no_static_element_interactions -- the
                 pointer handlers only serve the draw-a-box mode; keyboard
                 users reach the same result via the field inputs. -->
            <div
              class="imgwrap"
              class:drawing={!!drawField}
              onpointerdown={drawDown}
              onpointermove={drawMove}
              onpointerup={() => void drawUp()}
              onpointercancel={cancelDraw}
            >
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
                  {#if dragRect}
                    <div
                      class="marker draw-rect m-{drawField}"
                      style="left:{dragRect.x * 100}%;top:{dragRect.y * 100}%;width:{dragRect.w * 100}%;height:{dragRect.h * 100}%"
                    ></div>
                  {/if}
                </div>
              {/if}
              {#if drawField}
                <div class="draw-hint">
                  Drag a box around the {drawField === "amount" ? "total" : drawField}
                  · Esc cancels
                </div>
              {/if}
            </div>
          {:else}
            <div class="imgwrap skeleton" style="min-height:300px"></div>
          {/if}
        </div>

        <div class="m-form">
          {#snippet fieldFlags(field: "vendor" | "date" | "amount" | "category")}
            {#each flagsFor(field) as f (f.code + f.message)}
              <div class="flag inline {f.severity}">
                <span>{f.severity === "error" ? "⛔" : f.severity === "warn" ? "⚠️" : "ℹ️"}</span>
                <span>{f.message}</span>
              </div>
            {/each}
          {/snippet}

          <div class="frow f-vendor">
            <div class="lrow">
              <label for="rv-vendor">Vendor</label>
              <button
                type="button"
                class="draw-btn db-vendor"
                class:active={drawField === "vendor"}
                onclick={() => (drawField = drawField === "vendor" ? null : "vendor")}
                title="Draw a box on the receipt around the vendor name"
              >▣ mark on image</button>
            </div>
            <input id="rv-vendor" type="text" bind:value={vendor} onchange={save} />
            {@render fieldFlags("vendor")}
            {#if imgLoaded && current.vendor.bbox}
              {#key current.id}
                <canvas class="callout" use:callout={current.vendor.bbox}></canvas>
              {/key}
            {/if}
          </div>

          <div class="frow f-date">
            <div class="lrow">
              <label for="rv-date">Date</label>
              <button
                type="button"
                class="draw-btn db-date"
                class:active={drawField === "date"}
                onclick={() => (drawField = drawField === "date" ? null : "date")}
                title="Draw a box on the receipt around the date"
              >▣ mark on image</button>
            </div>
            <input id="rv-date" type="date" bind:value={date} onchange={save} />
            {@render fieldFlags("date")}
            {#if imgLoaded && current.date.bbox}
              {#key current.id}
                <canvas class="callout" use:callout={current.date.bbox}></canvas>
              {/key}
            {/if}
          </div>

          <div class="frow f-amount">
            <div class="lrow">
              <label for="rv-amount">Amount</label>
              <button
                type="button"
                class="draw-btn db-amount"
                class:active={drawField === "amount"}
                onclick={() => (drawField = drawField === "amount" ? null : "amount")}
                title="Draw a box on the receipt around the grand total"
              >▣ mark on image</button>
            </div>
            <input
              id="rv-amount"
              type="number"
              step="0.01"
              min="0"
              bind:value={amount}
              onchange={save}
            />
            {@render fieldFlags("amount")}
            {#if imgLoaded && current.amount.bbox}
              {#key current.id}
                <canvas class="callout" use:callout={current.amount.bbox}></canvas>
              {/key}
            {/if}
          </div>

          <div class="frow">
            <label for="rv-cat">Category</label>
            <select id="rv-cat" bind:value={category} onchange={save}>
              {#each CATEGORIES as c (c)}
                <option value={c}>{c}</option>
              {/each}
            </select>
            {@render fieldFlags("category")}
          </div>

          {#if generalFlags.length}
            <div class="flags">
              {#each generalFlags as f (f.code + f.message)}
                <div class="flag {f.severity}">
                  <span>{f.severity === "error" ? "⛔" : f.severity === "warn" ? "⚠️" : "ℹ️"}</span>
                  <span>{f.message}</span>
                </div>
              {/each}
            </div>
          {/if}
          {#if current.status === "failed"}
            <!-- The card is itself a button, so the retry lives here. -->
            <p class="retry-row">
              <button class="btn btn-sm" onclick={() => void retryRead()}>↻ Retry reading</button>
              <span class="muted small">Reads the image again; anything you typed here is kept.</span>
            </p>
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
    max-height: min(94dvh, 100%);
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
    white-space: nowrap;
  }
  /* Each tag pairs its fill token with that token's ink partner — the fills
     turn pastel in dark mode, where hardcoded #fff fails AA. */
  .m-vendor {
    border-color: var(--cat-3);
  }
  .m-vendor span {
    background: var(--cat-3);
    color: var(--cat-3-ink);
  }
  /* Date reads purple, not red: red stayed too close to the orange "review"
     accents, and errors keep red to themselves. */
  .m-date {
    border-color: var(--cat-4);
  }
  .m-date span {
    background: var(--cat-4);
    color: var(--cat-4-ink);
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
    border-left: 3px solid var(--cat-4);
  }
  .f-amount input {
    border-left: 3px solid var(--ok);
  }
  .lrow {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.6rem;
  }
  .lrow label {
    margin-bottom: 0;
  }
  /* Prominent, color-coded to the field it marks, and big enough for a
     thumb: drawing works over touch (pointer events + touch-action none). */
  .draw-btn {
    border: 1.5px solid var(--db-c, var(--ink-faint));
    background: color-mix(in srgb, var(--db-c, var(--ink-faint)) 8%, transparent);
    font: 650 0.74rem/1 var(--font-ui);
    color: var(--db-c, var(--ink-faint));
    cursor: pointer;
    padding: 0.42rem 0.6rem;
    border-radius: var(--radius-pill);
    white-space: nowrap;
  }
  .draw-btn:hover {
    background: color-mix(in srgb, var(--db-c, var(--ink-faint)) 16%, transparent);
  }
  .draw-btn.active {
    background: var(--db-c);
    color: var(--bg-raised);
  }
  .db-vendor {
    --db-c: var(--cat-3);
  }
  .db-date {
    --db-c: var(--cat-4);
  }
  .db-amount {
    --db-c: var(--accent);
  }
  .imgwrap.drawing {
    cursor: crosshair;
    touch-action: none; /* the drag must not scroll the page */
  }
  .imgwrap.drawing img {
    -webkit-user-drag: none;
    user-select: none;
  }
  .draw-rect {
    border-style: dashed;
  }
  .draw-hint {
    position: absolute;
    left: 50%;
    bottom: 0.6rem;
    translate: -50% 0;
    font: 600 0.75rem/1 var(--font-ui);
    color: var(--accent-ink);
    background: color-mix(in srgb, var(--accent) 88%, transparent);
    padding: 0.4rem 0.7rem;
    border-radius: var(--radius-pill);
    pointer-events: none;
    white-space: nowrap;
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
  .retry-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
    margin: 0.5rem 0 0;
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
    color: var(--gold-text); /* --gold is only 3.6:1 on gold-soft in light */
  }
  .flag.error {
    background: var(--err-soft);
    color: var(--err);
  }
  /* Field-adjacent flags: same vocabulary, tighter fit under an input. */
  .flag.inline {
    font-size: 0.82rem;
    padding: 0.35rem 0.55rem;
  }
  .provenance {
    font-size: 0.8rem;
    margin: 0;
  }

  /* Phone fit, any orientation: the dialog must never push its own header,
     footer or close button off-screen. The body is the only scroll region;
     the footer wraps instead of overflowing, and the keyboard hint (useless
     on touch) gives way first. */
  .m-foot {
    flex-wrap: wrap;
  }
  @media (max-width: 640px), (max-height: 500px) {
    .scrim {
      padding: 0.5rem;
    }
    .m-head,
    .m-foot {
      padding: 0.6rem 0.8rem;
      gap: 0.5rem;
    }
    .m-body {
      padding: 0.8rem;
      gap: 0.8rem;
    }
    .m-foot .kbd {
      display: none;
    }
  }
  @media (max-height: 500px) {
    .modal {
      max-height: 100%;
    }
  }
</style>
