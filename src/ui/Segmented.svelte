<script lang="ts" generics="T extends string">
  // A small segmented toggle: a labelled group of buttons, one pressed.
  // `aria-pressed` carries the state (the forced-colors rule in theme.css
  // underlines pressed toggles), and the ring is drawn INSET because the
  // rounded group clips its children.

  interface Option {
    value: T;
    label: string;
    title?: string;
  }

  let {
    options,
    value = $bindable(),
    label,
    onchange,
  }: {
    options: Option[];
    value: T;
    /** Accessible name of the group. */
    label: string;
    onchange?: (value: T) => void;
  } = $props();

  function choose(v: T): void {
    if (v === value) return;
    value = v;
    onchange?.(v);
  }
</script>

<div class="seg" role="group" aria-label={label}>
  {#each options as o (o.value)}
    <button
      type="button"
      class="seg-btn"
      class:active={value === o.value}
      aria-pressed={value === o.value}
      title={o.title}
      onclick={() => choose(o.value)}
    >
      {o.label}
    </button>
  {/each}
</div>

<style>
  .seg {
    display: inline-flex;
    flex-wrap: wrap;
    border: 1px solid var(--line-strong);
    border-radius: 9px;
    overflow: hidden;
    width: fit-content;
  }
  .seg-btn {
    border: 0;
    background: transparent;
    color: var(--ink-soft);
    font: 600 0.85rem/1 var(--font-ui);
    padding: 0.5rem 0.9rem;
    cursor: pointer;
  }
  .seg-btn.active {
    background: var(--accent);
    color: var(--accent-ink);
  }
  /* .seg's overflow:hidden clips the global focus ring — draw it inset. */
  .seg-btn:focus-visible {
    outline: 2px solid transparent; /* painted by forced colors; negative offset keeps it inside the clip */
    outline-offset: -4px;
    box-shadow: inset 0 0 0 2px var(--bg), inset 0 0 0 4px var(--accent);
  }
</style>
