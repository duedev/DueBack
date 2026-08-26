// Nerd mode's entrance: a brief rain of green binary bits over the window
// when the toggle turns ON. One throwaway canvas, ~1.8s, then gone — a nod,
// not a screensaver. No-op under prefers-reduced-motion.

export function binaryBurst(): void {
  if (typeof document === "undefined") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:98";
  canvas.setAttribute("aria-hidden", "true");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  document.body.appendChild(canvas);

  const accent =
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() ||
    "#147246";
  const W = window.innerWidth;
  const H = window.innerHeight;
  const CELL = 18;
  const cols = Math.ceil(W / CELL);
  // Each column is a falling stream of 0/1 glyphs with its own speed/start.
  const streams = Array.from({ length: cols }, (_, i) => ({
    x: i * CELL + 4,
    y: -Math.random() * H,
    speed: 260 + Math.random() * 420,
    glyphs: Array.from({ length: 26 }, () => (Math.random() < 0.5 ? "0" : "1")),
  }));

  const started = performance.now();
  const DURATION = 1800;
  let last = started;
  const tick = (now: number): void => {
    const t = now - started;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, W, H);
    const fade = t < 250 ? t / 250 : t > DURATION - 500 ? Math.max(0, (DURATION - t) / 500) : 1;
    ctx.font = `700 13px ui-monospace, Menlo, monospace`;
    for (const s of streams) {
      s.y += s.speed * dt;
      for (let g = 0; g < s.glyphs.length; g++) {
        const gy = s.y - g * CELL;
        if (gy < -CELL || gy > H + CELL) continue;
        // The stream head is brightest; the tail decays behind it.
        const tail = Math.max(0, 1 - g / s.glyphs.length);
        ctx.globalAlpha = fade * (g === 0 ? 0.9 : 0.55 * tail);
        ctx.fillStyle = accent;
        ctx.fillText(s.glyphs[g]!, s.x, gy);
      }
      // Occasionally flip a bit so the streams shimmer.
      if (Math.random() < 0.2) {
        const k = Math.floor(Math.random() * s.glyphs.length);
        s.glyphs[k] = s.glyphs[k] === "0" ? "1" : "0";
      }
    }
    ctx.globalAlpha = 1;
    if (t < DURATION) requestAnimationFrame(tick);
    else canvas.remove();
  };
  requestAnimationFrame(tick);
}
