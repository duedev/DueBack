import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The Settings dialog is mounted ONCE, in App.svelte outside the landing ⇄
// workspace swap, and both headers open it through the shared gear
// (SettingsButton.svelte). A second mount — easy to re-add in a merge that
// touches Workspace.svelte — would render two stacked dialogs; a mount
// inside a surface would close under a swap and leave app.settingsOpen
// stale. Source-text guard, comments stripped.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/ui/${rel}`, import.meta.url)), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const count = (src: string, needle: string): number => src.split(needle).length - 1;

test("App.svelte mounts <Settings /> exactly once", () => {
  assert.equal(count(read("App.svelte"), "<Settings />"), 1);
});

test("neither surface mounts Settings; both headers use the shared gear", () => {
  for (const file of ["Workspace.svelte", "Landing.svelte"]) {
    const src = read(file);
    assert.doesNotMatch(src, /<Settings[\s/>]/, `${file} must not mount Settings`);
    assert.equal(count(src, "<SettingsButton />"), 1, `${file} renders the gear once`);
  }
});

test("the landing gear is hidden when boot couldn't open storage", () => {
  // A storage-blocked embed lands on the landing, and Settings can save
  // nothing there (its sections read kv and localStorage).
  assert.match(read("Landing.svelte"), /\{#if !app\.storageError\}\s*<SettingsButton \/>\s*\{\/if\}/);
});

test("the gear carries the focus-restore hook Settings falls back to", () => {
  assert.match(read("SettingsButton.svelte"), /data-settings-btn/);
  assert.match(read("Settings.svelte"), /\[data-settings-btn\]/);
});
