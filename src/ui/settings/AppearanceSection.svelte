<script lang="ts">
  import { app, type ThemePref } from "../state.svelte.ts";

  const THEMES: [ThemePref, string][] = [
    ["auto", "Match system"],
    ["light", "Light"],
    ["dark", "Dark"],
  ];
</script>

<section>
  <h3>Appearance</h3>
  <!-- The header button only flips light/dark; "Match system" is
       reachable here (it used to be unreachable once toggled). -->
  <div class="theme-row" role="radiogroup" aria-label="Theme">
    {#each THEMES as [v, label] (v)}
      <label class="theme-opt">
        <input type="radio" name="theme" value={v} checked={app.theme === v} onchange={() => app.applyTheme(v)} />
        {label}
      </label>
    {/each}
  </div>
</section>

<style>
  .theme-row {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }
  .theme-opt {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
  }
</style>
