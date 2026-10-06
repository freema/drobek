/**
 * /workspaces/:slug/apps/:appSlug/analytics — client half of the Analytics
 * tab: page views and estimated visitors per day (chart + table), totals, the
 * bot share, top pages and top referrer hosts for the chosen range, with a
 * short privacy note. Read-only.
 */
import { Form, useLoaderData, useNavigation } from 'react-router';
import type { loader } from './workspaces.$slug.apps.$appSlug.analytics.server.js';
import { ui } from '../owner-ui.js';
import { AppPage } from '../app-header.js';
import { TrafficChart } from '../analytics-chart.js';
import { formatShare, shortDay, topKeyLabel } from '../analytics-view.js';

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  return [{ title: `Analytics — ${data?.appSlug ?? 'App'} — drobek` }];
}

const h2 = { fontSize: '1.05rem', margin: '1.5rem 0 0.4rem' } as const;
const stats = { display: 'flex', flexWrap: 'wrap', gap: '1.5rem', margin: '1rem 0 0.25rem' } as const;
const statNum = { display: 'block', fontSize: '1.5rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' } as const;
const statLabel = { color: '#555', fontSize: '0.8rem' } as const;
const columns = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1.5rem' } as const;

function Stat({ value, label, testId }: { value: string | number; label: string; testId: string }) {
  return (
    <div>
      <span style={statNum} data-testid={testId}>
        {value}
      </span>
      <span style={statLabel}>{label}</span>
    </div>
  );
}

function TopTable({ rows, kind, testId, keyLabel }: { rows: { key: string; views: number }[]; kind: 'path' | 'referrer'; testId: string; keyLabel: string }) {
  if (rows.length === 0) {
    return (
      <p style={ui.empty} data-testid={`${testId}-empty`}>
        {kind === 'path' ? 'No page views in this range.' : 'No visits came from another site in this range — visitors opened the address directly or their browser sent no referrer.'}
      </p>
    );
  }
  return (
    <div style={ui.tableWrap}>
      <table style={ui.table} data-testid={testId}>
        <thead>
          <tr>
            <th style={ui.th}>{keyLabel}</th>
            <th style={{ ...ui.th, textAlign: 'right' }}>Views</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} data-testid={`${testId}-row`}>
              <td style={{ ...ui.td, ...ui.mono, wordBreak: 'break-all' }}>{topKeyLabel(r.key, kind)}</td>
              <td style={{ ...ui.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.views}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AppAnalyticsRoute() {
  const d = useLoaderData<typeof loader>();
  const busy = useNavigation().state !== 'idle';
  const t = d.traffic;
  const noVisits = t !== null && t.totals.views === 0 && t.totals.bot_views === 0;

  return (
    <AppPage header={d.header}>
      <h2 style={ui.title}>Analytics</h2>
      <p style={ui.hint}>
        Who opens <strong>{d.appSlug}</strong> on its production address and custom domains. Preview and version addresses are not counted.
      </p>

      {!d.enabled ? (
        <p style={ui.empty} data-testid="analytics-disabled">
          Analytics is turned off on this server (ANALYTICS_ENABLED=0), so no visits are counted. The server operator can turn it on.
        </p>
      ) : (
        <>
          <Form method="get" style={ui.toolbar} data-testid="analytics-filter">
            <div style={ui.field}>
              <label style={ui.label} htmlFor="days">
                Time range
              </label>
              <select id="days" name="days" defaultValue={String(d.days)} style={ui.input} data-testid="analytics-days">
                {d.ranges.map((r) => (
                  <option key={r} value={r}>
                    last {r} days
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" style={ui.button} disabled={busy} data-testid="analytics-refresh">
              {busy ? 'Loading…' : 'Show'}
            </button>
          </Form>

          {d.error ? (
            <div style={ui.error} role="alert" data-testid="analytics-error">
              {d.error}
            </div>
          ) : null}

          {t ? (
            <>
              <div style={stats}>
                <Stat value={t.totals.views} label="page views" testId="analytics-views" />
                <Stat value={t.totals.visitors} label="visitors (daily estimates, summed)" testId="analytics-visitors" />
                <Stat value={formatShare(t.totals.bot_share)} label={`bot traffic (${t.totals.bot_views} views)`} testId="analytics-bot-share" />
              </div>

              {noVisits ? (
                <p style={ui.empty} data-testid="analytics-empty">
                  {d.published
                    ? 'No visits yet — share the app’s address, and the first visits show here within seconds.'
                    : 'No visits yet — publish the app and share its address.'}
                </p>
              ) : (
                <>
                  <TrafficChart series={t.series} />
                  <details style={{ margin: '0 0 0.5rem' }}>
                    <summary style={{ cursor: 'pointer', fontSize: '0.85rem' }}>Numbers per day</summary>
                    <div style={ui.tableWrap}>
                      <table style={ui.table} data-testid="analytics-days-table">
                        <thead>
                          <tr>
                            <th style={ui.th}>Day (UTC)</th>
                            <th style={{ ...ui.th, textAlign: 'right' }}>Page views</th>
                            <th style={{ ...ui.th, textAlign: 'right' }}>Visitors</th>
                            <th style={{ ...ui.th, textAlign: 'right' }}>Bot views</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...t.series].reverse().map((s) => (
                            <tr key={s.day}>
                              <td style={ui.td}>{shortDay(s.day)}</td>
                              <td style={{ ...ui.td, textAlign: 'right' }}>{s.views}</td>
                              <td style={{ ...ui.td, textAlign: 'right' }}>{s.visitors}</td>
                              <td style={{ ...ui.td, textAlign: 'right' }}>{s.bot_views}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                  <div style={columns}>
                    <section>
                      <h3 style={h2}>Top pages</h3>
                      <TopTable rows={t.top_paths.map((p) => ({ key: p.path, views: p.views }))} kind="path" testId="analytics-paths" keyLabel="Page" />
                    </section>
                    <section>
                      <h3 style={h2}>Top referrers</h3>
                      <TopTable rows={t.top_referrers.map((r) => ({ key: r.host, views: r.views }))} kind="referrer" testId="analytics-referrers" keyLabel="Site" />
                    </section>
                  </div>
                </>
              )}
            </>
          ) : null}

          <h3 style={h2}>Privacy</h3>
          <p style={{ ...ui.hint, fontSize: '0.85rem' }} data-testid="analytics-privacy">
            drobek counts visits without cookies or anything stored in the visitor’s browser. A visitor is estimated per day from a
            one-way hash of their IP address and browser with a random value that changes every day and is never stored in the
            database; no IP address, browser string or hash is kept. Only page paths without their query string and the site a
            visitor came from (its host name, not the page) are recorded. Bots are counted apart; the counts of days older than{' '}
            {d.retentionDays} days are deleted.
          </p>
        </>
      )}
    </AppPage>
  );
}
