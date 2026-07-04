/**
 * /workspaces/:slug/activity — client half of the workspace Activity view
 * (governance v1, PHY-85): the append-only audit trail as a table (time, action,
 * actor + agent/user badge, subject), newest-first, with an app + action FILTER
 * (GET, round-tripped through the loader), keyset "Next page" pagination, and a
 * CSV export of the current filter. Admin/super-admin only (the server gates it).
 *
 * All values arrive pre-shaped from the loader — this file stays client-safe
 * (imports only react-router + the server-free ../view.js).
 */
import { Form, Link, useLoaderData } from 'react-router';
import type { loader } from './workspaces.$slug.activity.server.js';

export function meta({
  data,
}: {
  data?: Awaited<ReturnType<typeof loader>>;
}) {
  return [
    { title: `Activity — ${data?.workspace.name ?? 'Workspace'} — drobek` },
  ];
}

/** Build the current filter search string (app + action), sans cursor. */
function filterSearch(filter: { action: string | null; app: string | null }): string {
  const sp = new URLSearchParams();
  if (filter.action) sp.set('action', filter.action);
  if (filter.app) sp.set('app', filter.app);
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Append/override params onto a base search string. */
function withParam(base: string, key: string, value: string): string {
  const sp = new URLSearchParams(base.startsWith('?') ? base.slice(1) : base);
  sp.set(key, value);
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const styles = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: '60rem',
    margin: '0 auto',
    padding: '3rem 1.5rem',
    color: '#1a1a1a',
    lineHeight: 1.6,
  },
  nav: {
    margin: '0 0 1.5rem',
    fontSize: '0.9rem',
    display: 'flex',
    gap: '0.9rem',
    flexWrap: 'wrap',
  },
  navLink: { color: '#1a1a1a', fontWeight: 600 },
  h1: { fontSize: '1.6rem', margin: 0 },
  hint: { color: '#555', marginTop: '0.25rem', fontSize: '0.95rem' },
  toolbar: {
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    margin: '1.25rem 0 0.75rem',
    padding: '0.75rem',
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
    background: '#fafafa',
  },
  field: { display: 'flex', flexDirection: 'column', gap: '0.2rem' },
  label: {
    fontSize: '0.68rem',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: '#71717a',
    fontWeight: 700,
  },
  input: {
    fontFamily: 'inherit',
    fontSize: '0.85rem',
    padding: '0.3rem 0.45rem',
    border: '1px solid #d4d4d8',
    borderRadius: '6px',
  },
  applyBtn: {
    padding: '0.4rem 0.85rem',
    fontSize: '0.85rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#fff',
    background: '#1a1a1a',
    border: 'none',
    borderRadius: '7px',
    cursor: 'pointer',
  },
  clearLink: { fontSize: '0.85rem', color: '#555', alignSelf: 'center' },
  csvLink: {
    fontSize: '0.85rem',
    color: '#1e3a8a',
    marginLeft: 'auto',
    alignSelf: 'center',
  },
  tableWrap: { overflowX: 'auto', margin: '0.5rem 0' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' },
  th: {
    textAlign: 'left',
    borderBottom: '1px solid #e4e4e7',
    padding: '0.45rem 0.6rem 0.45rem 0',
    color: '#555',
    fontSize: '0.72rem',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
  },
  td: {
    borderBottom: '1px solid #f0f0f2',
    padding: '0.5rem 0.6rem 0.5rem 0',
    verticalAlign: 'top',
  },
  mono: { fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' },
  agentBadge: {
    display: 'inline-block',
    padding: '0.1rem 0.5rem',
    fontSize: '0.68rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    borderRadius: '999px',
    color: '#5b21b6',
    background: '#ede9fe',
    border: '1px solid #ddd6fe',
    marginRight: '0.4rem',
  },
  userBadge: {
    display: 'inline-block',
    padding: '0.1rem 0.5rem',
    fontSize: '0.68rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    borderRadius: '999px',
    color: '#166534',
    background: '#dcfce7',
    border: '1px solid #bbf7d0',
    marginRight: '0.4rem',
  },
  pager: { display: 'flex', gap: '1rem', margin: '1rem 0', fontSize: '0.88rem' },
  empty: { color: '#555', fontStyle: 'italic', padding: '1rem 0' },
  back: { fontSize: '0.9rem', color: '#555', marginTop: '2rem' },
} as const;

export default function WorkspaceActivityRoute() {
  const { workspace, items, nextCursor, filter, actionOptions, appOptions } =
    useLoaderData<typeof loader>();

  const base = `/workspaces/${workspace.slug}/activity`;
  const search = filterSearch(filter);

  return (
    <main style={styles.main}>
      <p style={styles.nav}>
        <Link to="/workspaces" style={styles.navLink}>
          ← Workspaces
        </Link>
        <Link to={`/workspaces/${workspace.slug}`} style={styles.navLink}>
          Members &amp; roles
        </Link>
        <Link to={`/workspaces/${workspace.slug}/apps`} style={styles.navLink}>
          Apps
        </Link>
      </p>

      <h1 style={styles.h1}>Activity</h1>
      <p style={styles.hint}>
        Who deployed what, when — and whether it was you or your agent. Append-only
        audit trail for {workspace.name}.
      </p>

      {/* FILTER — GET form, round-tripped through the loader. */}
      <Form method="get" style={styles.toolbar} data-testid="activity-filter-form">
        <div style={styles.field}>
          <label style={styles.label} htmlFor="app">
            App
          </label>
          <select
            id="app"
            name="app"
            defaultValue={filter.app ?? ''}
            style={styles.input}
            data-testid="filter-app"
          >
            <option value="">— all apps —</option>
            {appOptions.map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="action">
            Action
          </label>
          <select
            id="action"
            name="action"
            defaultValue={filter.action ?? ''}
            style={styles.input}
            data-testid="filter-action"
          >
            <option value="">— all actions —</option>
            {actionOptions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" style={styles.applyBtn} data-testid="filter-apply">
          Apply
        </button>
        <Link to={base} style={styles.clearLink} data-testid="filter-clear">
          Clear
        </Link>
        <a
          href={`${base}/export.csv${search}`}
          style={styles.csvLink}
          data-testid="csv-export"
        >
          ↓ Export CSV
        </a>
      </Form>

      {items.length === 0 ? (
        <p style={styles.empty} data-testid="activity-empty">
          No activity yet.
        </p>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table} data-testid="activity-table">
            <thead>
              <tr>
                <th style={styles.th}>time</th>
                <th style={styles.th}>action</th>
                <th style={styles.th}>actor</th>
                <th style={styles.th}>subject</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr
                  key={it.id}
                  data-testid="activity-row"
                  data-action={it.action}
                  data-actor-kind={it.actorKind}
                  data-subject={it.subject ?? ''}
                >
                  <td style={styles.td} data-testid="activity-time">
                    {it.time}
                  </td>
                  <td style={styles.td} data-testid="activity-action">
                    <span style={styles.mono}>{it.action}</span>
                  </td>
                  <td style={styles.td} data-testid="activity-actor">
                    <span
                      style={
                        it.actorBadge === 'agent'
                          ? styles.agentBadge
                          : styles.userBadge
                      }
                      data-testid="actor-badge"
                    >
                      {it.actorBadge}
                    </span>
                    {it.actorLabel}
                  </td>
                  <td style={styles.td} data-testid="activity-subject">
                    {it.subjectType ? (
                      <span style={styles.mono}>
                        {it.subjectType}
                        {it.subject ? `: ${it.subject}` : ''}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={styles.pager}>
        {search || nextCursor ? (
          <Link to={`${base}${search}`} data-testid="first-page">
            « First page
          </Link>
        ) : null}
        {nextCursor ? (
          <Link
            to={`${base}${withParam(search, 'cursor', nextCursor)}`}
            data-testid="next-page"
          >
            Next page »
          </Link>
        ) : null}
      </div>

      <p style={styles.back}>
        <Link to={`/workspaces/${workspace.slug}`}>← {workspace.name}</Link>
      </p>
    </main>
  );
}
