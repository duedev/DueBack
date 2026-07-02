import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  // Lets <script lang="ts"> blocks in .svelte files use TypeScript.
  preprocess: vitePreprocess(),
};
