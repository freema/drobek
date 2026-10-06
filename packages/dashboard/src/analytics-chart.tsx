/**
 * The Analytics tab's chart: page views per day as bars and estimated
 * visitors as a line on ONE count axis, inline SVG (no chart library). It
 * paints its own surface and switches to dark colours with the viewer's
 * colour scheme; every bar has a tooltip with the day's numbers, and the
 * legend names both series (the table under the chart has the same numbers).
 */
import { chartGeometry, shortDay, type ChartDay } from './analytics-view.js';

const CHART_CSS = `
.drobek-traffic-chart { --surface:#fcfcfb; --ink:#0b0b0b; --muted:#898781; --grid:#e1e0d9; --axis:#c3c2b7; --views:#2a78d6; --visitors:#eb6834; }
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .drobek-traffic-chart { --surface:#1a1a19; --ink:#ffffff; --muted:#898781; --grid:#2c2c2a; --axis:#383835; --views:#3987e5; --visitors:#d95926; }
}
:root[data-theme="dark"] .drobek-traffic-chart { --surface:#1a1a19; --ink:#ffffff; --muted:#898781; --grid:#2c2c2a; --axis:#383835; --views:#3987e5; --visitors:#d95926; }
.drobek-traffic-chart .bar:hover { opacity: 0.8; }
`;

const legendSwatch = (color: string, line = false) => ({
  display: 'inline-block',
  width: line ? 14 : 10,
  height: line ? 2 : 10,
  borderRadius: line ? 1 : 2,
  background: color,
  marginRight: 6,
  verticalAlign: 'middle',
});

export function TrafficChart({ series }: { series: readonly ChartDay[] }) {
  const g = chartGeometry(series);
  return (
    <figure
      className="drobek-traffic-chart"
      style={{ margin: '0.75rem 0', padding: '0.75rem', borderRadius: 10, background: 'var(--surface)', color: 'var(--ink)', border: '1px solid rgba(128,128,128,0.2)' }}
      data-testid="analytics-chart"
    >
      <style>{CHART_CSS}</style>
      <figcaption style={{ fontSize: '0.8rem', marginBottom: '0.4rem', color: 'var(--ink)' }}>
        <span style={{ marginRight: '1rem' }}>
          <span style={legendSwatch('var(--views)')} aria-hidden="true" />
          Page views
        </span>
        <span>
          <span style={legendSwatch('var(--visitors)', true)} aria-hidden="true" />
          Visitors (estimate)
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${g.width} ${g.height}`} width="100%" role="img" aria-label={`Page views and visitors per day, ${shortDay(series[0]?.day ?? '')} to ${shortDay(series.at(-1)?.day ?? '')}`} style={{ display: 'block' }}>
        {g.ticks.map((t) => (
          <g key={t.value}>
            <line x1={g.plot.left} x2={g.plot.right} y1={t.y} y2={t.y} stroke={t.value === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth={1} />
            <text x={g.plot.left - 6} y={t.y + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
              {Number.isInteger(t.value) ? t.value : t.value.toFixed(1)}
            </text>
          </g>
        ))}
        {g.bars.map((b) => (
          <g key={b.day} className="bar">
            <rect x={b.x} y={g.plot.top} width={b.width} height={g.plot.bottom - g.plot.top} fill="transparent">
              <title>{`${shortDay(b.day)}: ${b.views} page view${b.views === 1 ? '' : 's'}, ${b.visitors} visitor${b.visitors === 1 ? '' : 's'}`}</title>
            </rect>
            {b.height > 0 ? (
              <rect x={b.x} y={b.y} width={b.width} height={b.height} rx={Math.min(4, b.width / 2)} fill="var(--views)" pointerEvents="none" />
            ) : null}
          </g>
        ))}
        {series.length > 1 ? (
          <polyline points={g.line} fill="none" stroke="var(--visitors)" strokeWidth={2} strokeLinejoin="round" pointerEvents="none" />
        ) : null}
        {g.labels.map((l) => (
          <text key={l.x} x={l.x} y={g.height - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">
            {l.text}
          </text>
        ))}
      </svg>
    </figure>
  );
}
