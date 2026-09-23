<script lang="ts">
  import { app } from "../state.svelte.ts";
  import { repo } from "../../store/repo.ts";
  import { CATEGORIES } from "../../config/categories.ts";
  import { addBrandFromImage } from "../../pipeline/logo/index.ts";
  import type { Category, StoredBrand } from "../../types.ts";

  let brands = $state<StoredBrand[]>([]);
  let brandName = $state("");
  let brandCategory = $state<Category>("Other");
  let busy = $state(false);
  let brandFile = $state<HTMLInputElement | null>(null);

  async function loadBrands(): Promise<void> {
    brands = await repo.listBrands();
  }
  void loadBrands();

  async function addBrand(): Promise<void> {
    const file = brandFile?.files?.[0];
    if (!brandName.trim() || !file) {
      app.toast("Give the brand a name and pick a logo image.", "warn");
      return;
    }
    busy = true;
    try {
      await addBrandFromImage(brandName.trim(), brandCategory, file);
      app.toast(
        `Learned "${brandName.trim()}". Receipts showing this logo will now be recognized.`,
        "ok",
      );
      brandName = "";
      if (brandFile) brandFile.value = "";
      await loadBrands();
    } catch (err) {
      app.toast(
        `Couldn't learn the brand: ${err instanceof Error ? err.message : String(err)}`,
        "err",
      );
    } finally {
      busy = false;
    }
  }

  async function removeBrand(id: string): Promise<void> {
    await repo.deleteBrand(id);
    await loadBrands();
  }
</script>

<section>
  <h3>Teach a brand (logo recognition)</h3>
  <p class="muted small">
    When a merchant prints its name only as a logo, the text reader
    can't spell it. Upload one clear image of the logo and the app will
    recognize it visually on future receipts. No retraining, works
    offline after the first model download (~40&nbsp;MB, cached).
  </p>
  <div class="grid3">
    <div>
      <label for="st-bname">Brand name</label>
      <input id="st-bname" type="text" placeholder="e.g. Maple St. Hardware" bind:value={brandName} />
    </div>
    <div>
      <label for="st-bcat">Category</label>
      <select id="st-bcat" bind:value={brandCategory}>
        {#each CATEGORIES as c (c)}
          <option value={c}>{c}</option>
        {/each}
      </select>
    </div>
    <div>
      <label for="st-bfile">Logo image</label>
      <input id="st-bfile" type="file" accept="image/*" bind:this={brandFile} />
    </div>
  </div>
  <button class="btn btn-primary btn-sm" onclick={addBrand} disabled={busy}>
    {busy ? "Learning…" : "Add brand"}
  </button>

  {#if brands.length}
    <ul class="item-list">
      {#each brands as b (b.id)}
        <li>
          <span class="chip">{b.name}</span>
          <span class="muted small">{b.category}</span>
          <button
            class="btn btn-ghost btn-sm btn-danger"
            onclick={() => void removeBrand(b.id)}
            aria-label={`Forget ${b.name}`}
          >
            forget
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>
