<script lang="ts">
  import { app } from "./state.svelte.ts";
  import { LIMITS } from "../config/constants.ts";

  let { compact = false }: { compact?: boolean } = $props();

  let dragOver = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);
  let cameraInput = $state<HTMLInputElement | null>(null);

  const accept = LIMITS.acceptedExtensions.join(",");

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragOver = false;
    const files = e.dataTransfer?.files;
    if (files?.length) void app.addFiles(files);
  }

  function onPicked(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    // Copy the live FileList before clearing the input — resetting `value`
    // empties it while the async addFiles loop is still reading, silently
    // dropping every file after the first on a multi-select.
    const files = input.files ? Array.from(input.files) : [];
    input.value = "";
    if (files.length) void app.addFiles(files);
  }
</script>

<input type="file" bind:this={fileInput} onchange={onPicked} {accept} multiple class="sr-only" aria-hidden="true" tabindex="-1" />
<input type="file" bind:this={cameraInput} onchange={onPicked} accept="image/*" capture="environment" class="sr-only" aria-hidden="true" tabindex="-1" />

<div
  class="zone card"
  class:compact
  class:over={dragOver}
  role="button"
  tabindex="0"
  aria-label="Add receipts"
  ondragover={(e) => {
    e.preventDefault();
    dragOver = true;
  }}
  ondragleave={() => (dragOver = false)}
  ondrop={onDrop}
  onclick={() => fileInput?.click()}
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput?.click();
    }
  }}
>
  <svg class="zone-icon" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 16V4m0 0 4.5 4.5M12 4 7.5 8.5M4 16.5v2A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-2" />
  </svg>
  <div class="zone-text">
    <strong>Drop receipts here</strong>
    <span class="muted">or click to browse — photos, scans, PDFs</span>
  </div>
  <button
    class="btn btn-sm camera"
    onclick={(e) => {
      e.stopPropagation();
      cameraInput?.click();
    }}
  >
    📷 Camera
  </button>
</div>

<style>
  .zone {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1.5rem 1.4rem;
    border-style: dashed;
    border-width: 1.5px;
    border-color: var(--line-strong);
    cursor: pointer;
    transition:
      border-color 120ms ease,
      background 120ms ease;
  }
  .zone:hover,
  .zone.over {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .zone.compact {
    padding: 0.9rem 1.1rem;
  }
  .zone-icon {
    color: var(--accent);
    flex-shrink: 0;
  }
  .zone-text {
    display: grid;
    gap: 0.1rem;
    line-height: 1.3;
  }
  .zone-text .muted {
    font-size: 0.88rem;
  }
  .camera {
    margin-left: auto;
  }
  @media (hover: hover) and (pointer: fine) {
    /* Desktop: camera capture is rarely useful; keep it subtle. */
    .camera {
      opacity: 0.75;
    }
  }
</style>
