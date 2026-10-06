/**
 * The Analytics tab's pure helpers (client-safe): which ranges the server
 * offers, the `?days=` value, the chart's geometry (one count axis: page views
 * as bars, visitors as a line) and the labels of the top lists.
 */

/** The ranges the tab offers within the server's retention (always at least one). */
export function analyticsRanges(all: readonly number[], retentionDays: number): number[] {
  const within = all.filter((d) => d <= retentionDays);
  return within.length > 0 ? within : [retentionDays];
}

/** `?days=` → one of the offered ranges (default 30 when offered, else the longest). */
export function analyticsDays(raw: string | null | undefined, ranges: readonly number[]): number {
  const n = Number(raw);
  if (ranges.includes(n)) return n;
  return ranges.includes(30) ? 30 : ranges[ranges.length - 1];
}

/** A round axis maximum ≥ `max` (1, 2, 5 × 10^n); at least 1. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

export interface ChartDay {
  day: string;
  views: number;
  visitors: number;
}

interface ChartBar {
  day: string;
  x: number;
  y: number;
  width: number;
  height: number;
  views: number;
  visitors: number;
}

export interface ChartGeometry {
  width: number;
  height: number;
  plot: { left: number; top: number; right: number; bottom: number };
  max: number;
  ticks: { value: number; y: number }[];
  bars: ChartBar[];
  /** The visitors line (`x,y x,y …`). */
  line: string;
  /** Day labels under the axis (first, last and a few between). */
  labels: { x: number; text: string }[];
}

/** Geometry of the views / visitors chart in a `width` × `height` viewBox. */
export function chartGeometry(series: readonly ChartDay[], width = 720, height = 220): ChartGeometry {
  const plot = { left: 40, top: 12, right: width - 8, bottom: height - 26 };
  const max = niceMax(Math.max(0, ...series.map((d) => Math.max(d.views, d.visitors))));
  const span = plot.bottom - plot.top;
  const y = (v: number) => plot.bottom - (v / max) * span;
  const n = Math.max(series.length, 1);
  const step = (plot.right - plot.left) / n;
  const gap = Math.min(2, step / 4);
  const bars = series.map((d, i) => {
    const h = (d.views / max) * span;
    return { day: d.day, x: plot.left + i * step + gap / 2, y: plot.bottom - h, width: Math.max(step - gap, 0.5), height: h, views: d.views, visitors: d.visitors };
  });
  const line = series.map((d, i) => `${round(plot.left + (i + 0.5) * step)},${round(y(d.visitors))}`).join(' ');
  const ticks = [0, max / 2, max].map((v) => ({ value: v, y: round(y(v)) }));
  const every = Math.max(1, Math.ceil(series.length / 6));
  const labels = series
    .map((d, i) => ({ i, d }))
    .filter(({ i }) => i % every === 0 || i === series.length - 1)
    .filter(({ i }, k, all) => !(k === all.length - 2 && series.length - 1 - i < every / 2))
    .map(({ i, d }) => ({ x: round(plot.left + (i + 0.5) * step), text: shortDay(d.day) }));
  return { width, height, plot, max, ticks, bars, line, labels };
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-10-06` → `6 Oct`. */
export function shortDay(day: string): string {
  const [, m, d] = day.split('-').map(Number);
  return m >= 1 && m <= 12 && d ? `${d} ${MONTHS[m - 1]}` : day;
}

/** The `__other__` bucket reads as words. */
export function topKeyLabel(key: string, kind: 'path' | 'referrer'): string {
  if (key !== '__other__') return key;
  return kind === 'path' ? 'Other pages (past 200 a day)' : 'Other sites (past 200 a day)';
}

/** 0.214 → "21 %"; null → "—". */
export function formatShare(share: number | null): string {
  if (share === null) return '—';
  return `${Math.round(share * 100)} %`;
}
