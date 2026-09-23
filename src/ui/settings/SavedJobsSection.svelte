<script lang="ts">
  import { app } from "../state.svelte.ts";
  import { listSavedJobs, forgetJob, type SavedJob } from "../../store/jobs.ts";

  let savedJobs = $state<SavedJob[]>([]);
  $effect(() => {
    // Re-read on every open: the report bar's "Save job" adds pairs while
    // this panel isn't looking.
    if (app.settingsOpen) void listSavedJobs().then((j) => (savedJobs = j));
  });

  async function remove(name: string): Promise<void> {
    savedJobs = await forgetJob(name);
  }
</script>

<section>
  <h3>Saved jobs</h3>
  <p class="muted small">
    Job names and numbers travel as a pair: in the report bar, typing
    (or picking) a saved one autofills the other. Save a pair with the
    "☆ Save job" button next to the fields; forget pairs here.
  </p>
  {#if savedJobs.length}
    <ul class="item-list">
      {#each savedJobs as j (j.name)}
        <li>
          <span class="chip">{j.name}</span>
          <span class="muted small">#{j.number}</span>
          <button
            class="btn btn-ghost btn-sm btn-danger"
            onclick={() => void remove(j.name)}
            aria-label={`Forget job ${j.name}`}
          >
            forget
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="muted small">No saved jobs yet.</p>
  {/if}
</section>
