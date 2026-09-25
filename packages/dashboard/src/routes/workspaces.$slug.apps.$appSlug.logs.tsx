/**
 * /workspaces/:slug/apps/:appSlug/logs — client half of the Logs tab (M2-03):
 * the same three kinds as `get_logs` (runtime errors, compiles, requests) for
 * a chosen window, with a Refresh button. Read-only; no realtime.
 */
import { Form, useLoaderData, useNavigation } from 'react-router';
import type { loader } from './workspaces.$slug.apps.$appSlug.logs.server.js';
import { ui } from '../owner-ui.js';
import { AppPage } from '../app-header.js';
import { formatTimestamp } from '../view.js';

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  return [{ title: `Logs — ${data?.appSlug ?? 'App'} — drobek` }];
}

const h2 = { fontSize: '1.05rem', margin: '1.5rem 0 0.4rem' } as const;

function SectionError({ error, testId }: { error: string | null; testId: string }) {
  if (!error) return null;
  return (
    <div style={ui.error} role="alert" data-testid={testId}>
      {error}
    </div>
  );
}

export default function AppLogsRoute() {
  const d = useLoaderData<typeof loader>();
  const busy = useNavigation().state !== 'idle';

  return (
    <AppPage header={d.header}>
      <h2 style={ui.title}>Logs</h2>
      <p style={ui.hint}>
        What <strong>{d.appSlug}</strong> reported — the same data the agent reads with <code>get_logs</code>. Loaded{' '}
        <span data-testid="logs-loaded-at">{formatTimestamp(d.loadedAt)}</span>.
      </p>

      <Form method="get" style={ui.toolbar} data-testid="logs-filter">
        <div style={ui.field}>
          <label style={ui.label} htmlFor="since">
            Since
          </label>
          <select id="since" name="since" defaultValue={d.since} style={ui.input} data-testid="logs-since">
            {d.sinceOptions.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" style={ui.button} disabled={busy} data-testid="logs-refresh">
          {busy ? 'Loading…' : 'Refresh'}
        </button>
      </Form>

      <h2 style={h2}>Runtime errors</h2>
      <SectionError error={d.runtime.error} testId="runtime-error" />
      {d.runtime.entries.length === 0 && !d.runtime.error ? (
        <p style={ui.empty} data-testid="runtime-empty">
          No browser errors in this window.
        </p>
      ) : (
        <div style={ui.tableWrap}>
          <table style={ui.table} data-testid="runtime-table">
            <thead>
              <tr>
                <th style={ui.th}>Error</th>
                <th style={ui.th}>Count</th>
                <th style={ui.th}>Last seen</th>
                <th style={ui.th}>Page</th>
              </tr>
            </thead>
            <tbody>
              {d.runtime.entries.map((e, i) => (
                <tr key={`${e.type}:${e.message}:${i}`} data-testid="runtime-row">
                  <td style={ui.td}>
                    <strong>{e.type}</strong>: <span data-testid="runtime-message">{e.message}</span>
                    {e.file_hint ? <div style={{ ...ui.muted, ...ui.mono }}>{e.file_hint}</div> : null}
                    {e.stack ? <pre style={ui.pre}>{e.stack}</pre> : null}
                  </td>
                  <td style={ui.td}>{e.count}</td>
                  <td style={{ ...ui.td, whiteSpace: 'nowrap' }}>{formatTimestamp(e.last_seen)}</td>
                  <td style={{ ...ui.td, ...ui.mono, wordBreak: 'break-all' }}>{e.url}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={h2}>Compiles</h2>
      <SectionError error={d.compile.error} testId="compile-error" />
      {d.compile.entries.length === 0 && !d.compile.error ? (
        <p style={ui.empty} data-testid="compile-empty">
          No compiles in this window.
        </p>
      ) : (
        <div style={ui.tableWrap}>
          <table style={ui.table} data-testid="compile-table">
            <thead>
              <tr>
                <th style={ui.th}>When</th>
                <th style={ui.th}>Version</th>
                <th style={ui.th}>Result</th>
                <th style={ui.th}>Trigger</th>
                <th style={ui.th}>Duration</th>
              </tr>
            </thead>
            <tbody>
              {d.compile.entries.map((c, i) => (
                <tr key={`${c.at}:${i}`} data-testid="compile-row">
                  <td style={{ ...ui.td, whiteSpace: 'nowrap' }}>{formatTimestamp(c.at)}</td>
                  <td style={ui.td}>{c.version === null ? <span style={ui.muted}>not stored</span> : `v${c.version}`}</td>
                  <td style={ui.td}>
                    <span style={c.ok ? ui.okBadge : ui.badBadge}>{c.ok ? 'ok' : 'failed'}</span>
                    {c.warning_count > 0 ? <span style={ui.muted}> · {c.warning_count} warnings</span> : null}
                    {c.errors.map((e, j) => (
                      <div key={j} style={ui.mono}>
                        {e.file ? `${e.file}${e.line !== null ? `:${e.line}` : ''} ` : ''}
                        {e.text}
                      </div>
                    ))}
                  </td>
                  <td style={ui.td}>{c.trigger}</td>
                  <td style={ui.td}>{c.duration_ms} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={h2}>Requests</h2>
      <SectionError error={d.requests.error} testId="requests-error" />
      {d.requests.entries.length === 0 && !d.requests.error ? (
        <p style={ui.empty} data-testid="requests-empty">
          No requests in this window.
        </p>
      ) : (
        <div style={ui.tableWrap}>
          <table style={ui.table} data-testid="requests-table">
            <thead>
              <tr>
                <th style={ui.th}>Day (UTC)</th>
                <th style={ui.th}>Requests</th>
                <th style={ui.th}>5xx</th>
                <th style={ui.th}>404</th>
                <th style={ui.th}>Module calls (2xx / 3xx / 4xx / 5xx)</th>
              </tr>
            </thead>
            <tbody>
              {d.requests.entries.map((r) => (
                <tr key={r.day} data-testid="requests-row">
                  <td style={{ ...ui.td, whiteSpace: 'nowrap' }}>{r.day}</td>
                  <td style={ui.td}>{r.requests}</td>
                  <td style={ui.td}>{r.count_5xx}</td>
                  <td style={ui.td}>{r.count_404}</td>
                  <td style={ui.td}>
                    {Object.entries(r.modules).length === 0 ? (
                      <span style={ui.muted}>—</span>
                    ) : (
                      Object.entries(r.modules).map(([m, c]) => (
                        <div key={m} style={ui.mono}>
                          {m}: {c['2xx']} / {c['3xx']} / {c['4xx']} / {c['5xx']}
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppPage>
  );
}
