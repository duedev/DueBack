// A short, dependency-free confetti burst for the moment every receipt is
// approved. One throwaway canvas over the page, ~1.8s of particles from two
// bottom-corner cannons in the app's own palette, then everything is removed.
// No-op under prefers-reduced-motion.

export function celebrate(): void {
  if (typeof document === "undefined") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:99";
  canvas.setAttribute("aria-hidden", "true");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  document.body.appendChild(canvas);

  const styles = getComputedStyle(document.documentElement);
  const colors = ["--accent", "--gold", "--cat-3", "--cat-4", "--cat-6"]
    .map((t) => styles.getPropertyValue(t).trim())
    .filter(Boolean);

  interface P {
    x: number;
    y: number;
    vx: number;
    vy: number;
    w: number;
    h: number;
    rot: number;
    vr: number;
    color: string;
  }
  const W = window.innerWidth;
  const H = window.innerHeight;
  const parts: P[] = [];
  const cannon = (x: number, dir: number): void => {
    for (let i = 0; i < 110; i++) {
      const angle = (-Math.PI / 2) + dir * (0.15 + Math.random() * 0.45);
      const speed = 10 + Math.random() * 10;
      parts.push({
        x,
        y: H + 8,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        w: 6 + Math.random() * 7,
        h: 9 + Math.random() * 9,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        color: colors[i % colors.length] ?? "#147246",
      });
    }
  };
  // Three volleys: both corners fire immediately, a center burst follows,
  // then the corners reload — a real celebration, not a polite sprinkle.
  cannon(W * 0.1, +1);
  cannon(W * 0.9, -1);
  const volleys: { at: number; fire: () => void; done?: boolean }[] = [
    { at: 650, fire: () => cannon(W * 0.5, Math.random() < 0.5 ? +1 : -1) },
    { at: 1300, fire: () => ((cannon(W * 0.16, +1)), cannon(W * 0.84, -1)) },
  ];

  const started = performance.now();
  const DURATION = 4200;
  const tick = (now: number): void => {
    const t = now - started;
    for (const v of volleys) {
      if (!v.done && t >= v.at) {
        v.done = true;
        v.fire();
      }
    }
    ctx.clearRect(0, 0, W, H);
    const fade = t > DURATION - 600 ? Math.max(0, (DURATION - t) / 600) : 1;
    for (const p of parts) {
      p.vy += 0.32; // gravity
      p.vx *= 0.992;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t < DURATION) requestAnimationFrame(tick);
    else canvas.remove();
  };
  requestAnimationFrame(tick);
}
