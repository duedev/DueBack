import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The Playwright scripts only run under `npm run e2e` (real Chromium, real
// OCR, minutes) — nothing in `npm test` imports them, so a parse error there
// hid behind a green unit run (two e2e steps built in parallel once
// redeclared the same consts in one scope). `node --check` parses without
// executing: no browser, no server, milliseconds.
for (const script of ["e2e.mjs", "screenshots.mjs"]) {
  test(`tests/${script} parses`, () => {
    const path = fileURLToPath(new URL(`./${script}`, import.meta.url));
    const r = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
    assert.equal(r.error, undefined, `could not run node --check: ${r.error?.message}`);
    assert.equal(r.status, 0, `node --check ${script} failed:\n${r.stderr}`);
  });
}
