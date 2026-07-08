import { Chart } from "chart.js/auto";
import type { ChartConfiguration } from "chart.js";
import { CATEGORY_META } from "../config/categories.ts";
import type { Category } from "../types.ts";
import type { Insights } from "./insights.ts";

// Chart.js → PNG for the workbook's Insights sheet (ExcelJS can embed images
// but not draw native charts well). Rendered on a hidden canvas against the
// sheet's white surface. These are static exports, so the usual hover layer
// doesn't apply; identity is carried by axis labels (never color alone), marks
// are thin with rounded data-ends, the grid is recessive, and values are
// direct-labeled since each chart is a short ranked list.
//
// In non-DOM contexts (the Node test runner) canvas creation fails; callers
// treat a null result as "no chart" so the workbook still builds.

export interface ChartImage {
  buffer: ArrayBuffer;
  width: number;
  height: number;
  ext: "png";
}

const INK_SOFT = "#55524d";
const GRID = "rgba(85, 82, 77, 0.14)";
const ACCENT = "#147246";
const FONT = { family: "Inter, system-ui, sans-serif", size: 16 };

function argbToCss(argb: string): string {
  // "FFRRGGBB" → "#RRGGBB"
  return `#${argb.slice(2)}`;
}

async function renderToPng(
  config: ChartConfiguration,
  width: number,
  height: number,
): Promise<ChartImage | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const dpr = 2; // crisp when scaled into the sheet
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  let chart: Chart | null = null;
  try {
    chart = new Chart(canvas, {
      ...config,
      options: {
        ...config.options,
        responsive: false,
        animation: false,
        devicePixelRatio: dpr,
      },
    });
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/png"),
    );
    if (!blob) return null;
    return { buffer: await blob.arrayBuffer(), width, height, ext: "png" };
  } catch {
    return null;
  } finally {
    chart?.destroy();
  }
}

/** Spend by category — ranked horizontal bars; identity via axis labels. */
export async function categoryChartImage(
  insights: Insights,
): Promise<ChartImage | null> {
  const rows = insights.byCategory.filter((c) => c.total > 0).slice(0, 8);
  if (rows.length === 0) return null;
  const colors = rows.map((c) =>
    argbToCss(CATEGORY_META[c.category as Category]?.color ?? "FF94A3B8"),
  );
  const height = 90 + rows.length * 52;
  return renderToPng(
    {
      type: "bar",
      data: {
        labels: rows.map((c) => c.category),
        datasets: [
          {
            data: rows.map((c) => c.total),
            backgroundColor: colors,
            borderRadius: { topRight: 4, bottomRight: 4 },
            borderSkipped: "start",
            barThickness: 30,
          },
        ],
      },
      options: {
        indexAxis: "y",
        layout: { padding: { right: 96, top: 10, bottom: 6 } },
        plugins: {
          legend: { display: false },
          title: {
            display: true,
            text: "Spend by category",
            align: "start",
            color: "#1c1917",
            font: { ...FONT, size: 20, weight: "bold" },
            padding: { bottom: 10 },
          },
          tooltip: { enabled: false },
          // Direct value labels at the bar ends.
        },
        scales: {
          x: {
            grid: { color: GRID },
            border: { display: false },
            ticks: { color: INK_SOFT, font: FONT, maxTicksLimit: 5 },
          },
          y: {
            grid: { display: false },
            border: { display: false },
            ticks: { color: "#1c1917", font: FONT },
          },
        },
      },
      plugins: [barEndLabels("y")],
    },
    900,
    height,
  );
}

/** Daily spend — single-hue columns over time. */
export async function dailyChartImage(
  insights: Insights,
): Promise<ChartImage | null> {
  const rows = insights.timeline;
  if (rows.length < 2) return null;
  return renderToPng(
    {
      type: "bar",
      data: {
        labels: rows.map((d) => d.date.slice(5)), // mm-dd
        datasets: [
          {
            data: rows.map((d) => d.total),
            backgroundColor: ACCENT,
            borderRadius: { topLeft: 4, topRight: 4 },
            borderSkipped: "bottom",
            maxBarThickness: 40,
          },
        ],
      },
      options: {
        layout: { padding: { top: 20, bottom: 4 } },
        plugins: {
          legend: { display: false },
          title: {
            display: true,
            text: "Daily spend",
            align: "start",
            color: "#1c1917",
            font: { ...FONT, size: 20, weight: "bold" },
            padding: { bottom: 10 },
          },
          tooltip: { enabled: false },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: { color: INK_SOFT, font: FONT, maxRotation: 0, autoSkip: true },
          },
          y: {
            grid: { color: GRID },
            border: { display: false },
            ticks: { color: INK_SOFT, font: FONT, maxTicksLimit: 5 },
          },
        },
      },
      plugins: [barEndLabels("x")],
    },
    900,
    400,
  );
}

/** Chart.js inline plugin: direct value labels at the data end of each bar. */
function barEndLabels(indexAxis: "x" | "y") {
  return {
    id: "barEndLabels",
    afterDatasetsDraw(chart: Chart) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      const data = chart.data.datasets[0]?.data as number[] | undefined;
      if (!data) return;
      ctx.save();
      ctx.fillStyle = INK_SOFT;
      ctx.font = `600 15px ${FONT.family}`;
      meta.data.forEach((el, i) => {
        const v = data[i];
        if (v === undefined || v <= 0) return;
        const label = `$${v >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toFixed(0)}`;
        const pos = el.tooltipPosition(false);
        const ex = (el as unknown as { x: number | null }).x ?? 0;
        const ey = (el as unknown as { y: number | null }).y ?? 0;
        if (indexAxis === "y") {
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(label, ex + 8, pos.y ?? 0);
        } else {
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(label, pos.x ?? 0, ey - 6);
        }
      });
      ctx.restore();
    },
  };
}
