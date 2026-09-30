/**
 * The sources of a scheduled-import module (the one that declares `sync`)
 * on its module page: per source what it fetches and where it
 * writes, its schedule, the last and the next run, Run now and Pause /
 * Resume; below, the latest runs. Values arrive pre-shaped from the loader.
 */
import { Form } from 'react-router';
import { formatTimestamp } from '../view.js';
import { ui } from './styles.js';

export interface SyncSourceView {
  name: string;
  upstream: string;
  path: string;
  collection: string;
  mode: 'replace' | 'upsert';
  every: string;
  paused: 'owner' | 'failures' | 'limit' | null;
  failures: number;
  last_run_at: string | null;
  last_status: 'ok' | 'failed' | null;
  last_records: number | null;
  last_error: string | null;
  next_run_at: string | null;
}

interface SyncRunView {
  source: string;
  trigger: 'schedule' | 'manual';
  started_at: string;
  duration_ms: number;
  status: 'ok' | 'failed';
  records: number | null;
  inserted?: number;
  updated?: number;
  deleted?: number;
  error: string | null;
}

export interface SyncPanelData {
  /** null: the sources could not be loaded. */
  sources: SyncSourceView[] | null;
  runs: SyncRunView[];
}

function statusBadge(s: SyncSourceView) {
  if (s.paused === 'failures') return <span style={ui.warnBadge}>paused after {s.failures} failed runs</span>;
  if (s.paused === 'owner') return <span style={ui.badge}>paused</span>;
  if (s.paused === 'limit') return <span style={ui.warnBadge}>over the source limit</span>;
  if (s.last_status === 'ok') return <span style={ui.okBadge}>ok</span>;
  if (s.last_status === 'failed') return <span style={ui.warnBadge}>last run failed</span>;
  return <span style={ui.badge}>not run yet</span>;
}

function outcome(r: { status: 'ok' | 'failed'; records: number | null; inserted?: number; updated?: number; deleted?: number; error: string | null }): string {
  if (r.status === 'failed') return r.error ?? 'failed';
  const parts = [`${r.records ?? 0} records`];
  const counts = [
    r.inserted ? `${r.inserted} added` : null,
    r.updated ? `${r.updated} updated` : null,
    r.deleted ? `${r.deleted} removed` : null,
  ].filter(Boolean);
  if (counts.length > 0) parts.push(`(${counts.join(', ')})`);
  return parts.join(' ');
}

function SourceActions({ s, busy }: { s: SyncSourceView; busy: boolean }) {
  return (
    <div style={ui.row}>
      {s.paused !== 'limit' ? (
        <Form method="post">
          <input type="hidden" name="intent" value="sync-run" />
          <input type="hidden" name="source" value={s.name} />
          <button type="submit" style={ui.button} disabled={busy} data-testid={`sync-run-${s.name}`}>
            Run now
          </button>
        </Form>
      ) : null}
      {s.paused === 'owner' || s.paused === 'failures' ? (
        <Form method="post">
          <input type="hidden" name="intent" value="sync-resume" />
          <input type="hidden" name="source" value={s.name} />
          <button type="submit" style={ui.secondaryButton} disabled={busy} data-testid={`sync-resume-${s.name}`}>
            Resume schedule
          </button>
        </Form>
      ) : s.paused === null ? (
        <Form method="post">
          <input type="hidden" name="intent" value="sync-pause" />
          <input type="hidden" name="source" value={s.name} />
          <button type="submit" style={ui.secondaryButton} disabled={busy} data-testid={`sync-pause-${s.name}`}>
            Pause schedule
          </button>
        </Form>
      ) : null}
    </div>
  );
}

export function SyncSourcesPanel({
  data,
  canEdit,
  busy,
  error,
}: {
  data: SyncPanelData;
  canEdit: boolean;
  busy: boolean;
  error: { target?: string; general: string[] } | null;
}) {
  if (data.sources === null) {
    return (
      <div style={ui.error} role="alert" data-testid="sync-load-error">
        The sources could not be loaded. Reload the page; if it keeps failing, the server log names the cause.
      </div>
    );
  }
  return (
    <>
      <p style={ui.hint}>
        Each source fetches JSON from one of the app’s upstreams on its schedule and writes the records into a data
        collection. A failed run changes nothing — the app keeps the records of the last successful run. Run now fetches at
        once (also while paused); pausing stops only the schedule.
      </p>
      {error && !error.target ? (
        <div style={ui.error} role="alert" data-testid="sync-error">
          {error.general.join(' ')}
        </div>
      ) : null}
      {data.sources.length === 0 ? (
        <p style={ui.muted} data-testid="sync-empty">
          No sources yet. Your agent adds one with configure_module(&apos;sync&apos;, …) and you confirm it here; the upstream
          must be assigned to this app in the proxy module and the collection declared in the data module first.
        </p>
      ) : (
        data.sources.map((s) => (
          <div key={s.name} style={ui.panel} data-testid={`sync-source-${s.name}`} data-paused={s.paused ?? ''} data-status={s.last_status ?? ''}>
            <div style={{ ...ui.row, justifyContent: 'space-between' }}>
              <strong style={ui.mono}>{s.name}</strong>
              {statusBadge(s)}
            </div>
            <dl style={ui.facts}>
              <dt style={ui.factKey}>Fetches</dt>
              <dd style={{ margin: 0 }}>
                <span style={ui.mono}>
                  {s.upstream} {s.path}
                </span>{' '}
                every {s.every}
              </dd>
              <dt style={ui.factKey}>Writes</dt>
              <dd style={{ margin: 0 }}>
                collection <span style={ui.mono}>{s.collection}</span> —{' '}
                {s.mode === 'replace' ? 'replaces every record' : 'updates records by key, adds new ones'}
              </dd>
              <dt style={ui.factKey}>Last run</dt>
              <dd style={{ margin: 0 }} data-testid={`sync-last-${s.name}`}>
                {s.last_run_at
                  ? `${formatTimestamp(s.last_run_at)} — ${s.last_status === 'failed' ? (s.last_error ?? 'failed') : `${s.last_records ?? 0} records`}`
                  : 'never'}
              </dd>
              <dt style={ui.factKey}>Next run</dt>
              <dd style={{ margin: 0 }}>
                {s.paused === 'owner'
                  ? 'paused — resume the schedule to run it again'
                  : s.paused === 'failures'
                    ? 'paused after failed runs — fix the cause, then resume or run it now'
                    : s.paused === 'limit'
                      ? 'never — the app has more sources than SYNC_MAX_SOURCES_PER_APP allows; remove one'
                      : formatTimestamp(s.next_run_at)}
              </dd>
            </dl>
            {error && error.target === s.name ? (
              <div style={ui.error} role="alert" data-testid={`sync-error-${s.name}`}>
                {error.general.join(' ')}
              </div>
            ) : null}
            {canEdit ? <SourceActions s={s} busy={busy} /> : null}
          </div>
        ))
      )}

      <h3 style={{ fontSize: '1rem', margin: '1.25rem 0 0.25rem' }}>Latest runs</h3>
      {data.runs.length === 0 ? (
        <p style={ui.muted} data-testid="sync-runs-empty">
          No runs yet — a confirmed source runs within a minute, or use Run now.
        </p>
      ) : (
        <div style={ui.tableWrap}>
          <table style={ui.table} data-testid="sync-runs">
            <thead>
              <tr>
                <th style={ui.th}>Started</th>
                <th style={ui.th}>Source</th>
                <th style={ui.th}>By</th>
                <th style={ui.th}>Result</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r, i) => (
                <tr key={`${r.started_at}-${r.source}-${i}`} data-status={r.status}>
                  <td style={ui.td}>{formatTimestamp(r.started_at)}</td>
                  <td style={{ ...ui.td, ...ui.mono }}>{r.source}</td>
                  <td style={ui.td}>{r.trigger === 'manual' ? 'by hand' : 'schedule'}</td>
                  <td style={ui.td}>
                    {r.status === 'ok' ? <span style={ui.okBadge}>ok</span> : <span style={ui.warnBadge}>failed</span>} {outcome(r)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
