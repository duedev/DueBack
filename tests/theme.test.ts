import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Design-system invariants that no runtime test can see: the dark palette is
// duplicated in theme.css (explicit block + prefers-color-scheme fallback) and
// must stay identical, and small-copy colors must actually meet WCAG AA.

const read = (p: string): string =>
  readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// Comments carry prose ("never small copy", "border-radius") — strip them.
const themeCss = read("src/ui/theme.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** `--token: value;` pairs inside the first `{...}` after the selector. */
function tokens(css: string, selector: RegExp): Map<string, string> {
  const m = css.match(selector);
  assert.ok(m?.[1] !== undefined, `selector not found: ${selector}`);
  const out = new Map<string, string>();
  for (const t of m[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    out.set(t[1]!, t[2]!.trim());
  }
  return out;
}

const root = tokens(themeCss, /:root\s*\{([^}]*)\}/);
const dark = tokens(themeCss, /\[data-theme="dark"\]\s*\{([^}]*)\}/);
const darkAuto = tokens(
  themeCss,
  /:root:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\)\s*\{([^}]*)\}/,
);

// ── WCAG math ────────────────────────────────────────────────────────────────

type Rgb = [number, number, number];

function hex(s: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(s.trim());
  assert.ok(m, `not a 6-digit hex color: ${s}`);
  const h = m![1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** `rgb(r g b / a)` composited over an opaque background. */
function composite(rgbA: string, bg: Rgb): Rgb {
  const m = /rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/.exec(rgbA);
  assert.ok(m, `not an rgb(r g b / a) value: ${rgbA}`);
  const a = Number(m![4]);
  return [1, 2, 3].map((i) =>
    Math.round(Number(m![i]) * a + bg[i - 1]! * (1 - a)),
  ) as Rgb;
}

// ── the two dark palettes stay identical ─────────────────────────────────────

test("prefers-color-scheme fallback matches the [data-theme=dark] palette", () => {
  for (const [name, value] of darkAuto) {
    assert.equal(dark.get(name), value, `${name} differs between dark blocks`);
  }
});

test("--gold-text exists in all three palettes", () => {
  assert.ok(root.has("--gold-text"));
  assert.ok(dark.has("--gold-text"));
  assert.ok(darkAuto.has("--gold-text"));
});

// ── small-copy contrast (WCAG AA = 4.5:1) ────────────────────────────────────

test("light --gold-text meets AA everywhere the warn chips render", () => {
  const goldText = hex(root.get("--gold-text")!);
  const bg = hex(root.get("--bg")!);
  const raised = hex(root.get("--bg-raised")!);
  const chipBg = composite(root.get("--gold-soft")!, raised);
  assert.ok(contrast(goldText, bg) >= 4.5, "on --bg");
  assert.ok(contrast(goldText, raised) >= 4.5, "on --bg-raised");
  assert.ok(contrast(goldText, chipBg) >= 4.5, "on gold-soft chip fill");
});

test("light --ink-soft meets AA on both paper tones (fname, footer)", () => {
  const ink = hex(root.get("--ink-soft")!);
  assert.ok(contrast(ink, hex(root.get("--bg")!)) >= 4.5);
  assert.ok(contrast(ink, hex(root.get("--bg-raised")!)) >= 4.5);
});

test("dark --gold-text meets AA everywhere the warn chips render", () => {
  const goldText = hex(dark.get("--gold-text")!);
  const bg = hex(dark.get("--bg")!);
  const raised = hex(dark.get("--bg-raised")!);
  const chipBg = composite(dark.get("--gold-soft")!, raised);
  assert.ok(contrast(goldText, bg) >= 4.5, "on --bg");
  assert.ok(contrast(goldText, chipBg) >= 4.5, "on gold-soft chip fill");
});

test("marker ink partners exist in all three palettes", () => {
  // The identity test above only walks tokens present in the fallback block,
  // so presence in every block is asserted explicitly.
  for (const t of ["--cat-3-ink", "--err-ink"]) {
    assert.ok(root.has(t), `${t} in :root`);
    assert.ok(dark.has(t), `${t} in [data-theme=dark]`);
    assert.ok(darkAuto.has(t), `${t} in the prefers-color-scheme fallback`);
  }
});

test("light marker inks meet AA on their fills (review VENDOR/DATE tags)", () => {
  assert.ok(
    contrast(hex(root.get("--cat-3-ink")!), hex(root.get("--cat-3")!)) >= 4.5,
    "vendor tag",
  );
  assert.ok(
    contrast(hex(root.get("--err-ink")!), hex(root.get("--err")!)) >= 4.5,
    "date tag",
  );
});

test("dark marker inks meet AA on their fills (review VENDOR/DATE tags)", () => {
  assert.ok(
    contrast(hex(dark.get("--cat-3-ink")!), hex(dark.get("--cat-3")!)) >= 4.5,
    "vendor tag",
  );
  assert.ok(
    contrast(hex(dark.get("--err-ink")!), hex(dark.get("--err")!)) >= 4.5,
    "date tag",
  );
});

// ── rules, not just tokens ───────────────────────────────────────────────────

test(".chip-warn text uses the small-copy gold, not --gold", () => {
  const m = themeCss.match(/\.chip-warn\s*\{([^}]*)\}/);
  assert.match(m![1]!, /color:\s*var\(--gold-text\)/);
});

test("the global focus ring doesn't reshape the focused element", () => {
  const m = themeCss.match(/^:focus-visible\s*\{([^}]*)\}/m);
  assert.ok(m, "global :focus-visible rule exists");
  assert.doesNotMatch(m![1]!, /border-radius/);
});

// ── pre-paint theme stamp + manifest ─────────────────────────────────────────

test("index.html stamps the saved theme with state.svelte.ts's key", () => {
  const key = read("src/ui/state.svelte.ts").match(
    /const THEME_KEY = "([^"]+)"/,
  )?.[1];
  assert.ok(key, "THEME_KEY found in state.svelte.ts");
  const html = read("index.html");
  assert.ok(
    html.includes(`localStorage.getItem("${key}")`),
    "inline stamp reads the same localStorage key",
  );
  assert.match(html, /document\.documentElement\.dataset\.theme/);
});

test("the PWA manifest doesn't lock orientation (WCAG 1.3.4)", () => {
  assert.doesNotMatch(
    read("vite.config.ts"),
    /orientation:\s*"(?!any")/,
    "manifest orientation must be unset or \"any\"",
  );
});
