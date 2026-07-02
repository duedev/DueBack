/// <reference types="vite/client" />

// Lets plain `tsc --noEmit` resolve .svelte imports (component *contents* are
// type-checked by svelte-check, which understands Svelte files natively).
declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component;
  export default component;
}
