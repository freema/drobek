/**
 * /workspaces/:slug/activity — client half of the workspace Activity view
 * (governance v1, PHY-85): the append-only audit trail as a table (time, action,
 * actor + agent/user/end-user badge, subject), newest-first, with an app +
 * action + actor-kind + time-range FILTER
 * (GET, round-tripped through the loader), keyset "Next page" pagination, and a
 * CSV export of the current filter. Admin/super-admin only (the server gates it).
 * Each row reads as a sentence, links the objects that still exist (a deleted
 * one is plain text with a note) and keeps the stored record under
 * "Technical details".
 *
 * All values arrive pre-shaped from the loader — this file stays client-safe
 * (imports only react-router + the server-free ../view.js).
 */
import { Form, Link, useLoaderData } from 'react-router';
import { WorkspacePage, controls } from '@drobek/tenancy/layout';
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

/** Build the current filter search string (app + action + actor + range), sans cursor. */
function filterSearch(filter: {
  action: string | null;
  app: string | null;
  actor: string | null;
  from: string | null;
  to: string | null;
}): string {
  const sp = new URLSearchParams();
  if (filter.action) sp.set('action', filter.action);
  if (filter.app) sp.set('app', filter.app);
  if (filter.actor) sp.set('actor', filter.actor);
  if (filter.from) sp.set('from', filter.from);
  if (filter.to) sp.set('to', filter.to);
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
  hint: { color: '#555', margin: '1.25rem 0 0', fontSize: '0.95rem' },
  toolbar: {
    ...controls.row,
    margin: '1.25rem 0 0.75rem',
    padding: '0.75rem',
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
    background: '#fafafa',
  },
  field: controls.field,
  label: controls.label,
  input: controls.select,
  date: { ...controls.input, width: '9.5rem' },
  applyBtn: controls.button,
  clearLink: controls.link,
  csvLink: { ...controls.link, color: '#1e3a8a', marginLeft: 'auto' },
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
  summary: { fontWeight: 600, overflowWrap: 'anywhere' },
  code: { fontFamily: 'ui-monospace, monospace', fontSize: '0.72rem', color: '#71717a' },
  links: { display: 'flex', flexWrap: 'wrap', gap: '0.15rem 0.7rem' },
  link: { color: '#1e3a8a', overflowWrap: 'anywhere' },
  gone: { color: '#52525b', overflowWrap: 'anywhere' },
  note: { color: '#71717a', fontSize: '0.75rem' },
  detailsSummary: { cursor: 'pointer', color: '#52525b', fontSize: '0.75rem', marginTop: '0.2rem' },
  pre: {
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    background: '#fafafa',
    border: '1px solid #f0f0f2',
    borderRadius: '6px',
    padding: '0.4rem 0.55rem',
    margin: '0.3rem 0 0',
    fontSize: '0.75rem',
    maxWidth: '36rem',
  },
  exportNote: { color: '#71717a', fontSize: '0.8rem', margin: '-0.25rem 0 0.75rem' },
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
  endUserBadge: {
    display: 'inline-block',
    padding: '0.1rem 0.5rem',
    fontSize: '0.68rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    borderRadius: '999px',
    color: '#92400e',
    background: '#fef3c7',
    border: '1px solid #fde68a',
    marginRight: '0.4rem',
  },
  pager: { display: 'flex', gap: '1rem', margin: '1rem 0', fontSize: '0.88rem' },
  empty: { color: '#555', fontStyle: 'italic', padding: '1rem 0' },
} as const;

export default function WorkspaceActivityRoute() {
  const { nav, workspace, items, nextCursor, filter, actionOptions, actorOptions, appOptions } =
    useLoaderData<typeof loader>();

  const base = `/workspaces/${workspace.slug}/activity`;
  const search = filterSearch(filter);

  return (
    <WorkspacePage workspace={nav} section="activity">
      <p style={styles.hint}>
        Changes and actions in {workspace.name}, including publishing, settings and access changes.
        Each entry shows who performed the action and when.
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
        <div style={styles.field}>
          <label style={styles.label} htmlFor="actor">
            Actor
          </label>
          <select
            id="actor"
            name="actor"
            defaultValue={filter.actor ?? ''}
            style={styles.input}
            data-testid="filter-actor"
          >
            <option value="">— all actors —</option>
            {actorOptions.map((k) => (
              <option key={k} value={k}>
                {k === 'end_user' ? 'end user' : k}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="from">
            From (UTC)
          </label>
          <input
            id="from"
            name="from"
            type="date"
            defaultValue={filter.from ?? ''}
            max={filter.to ?? undefined}
            style={styles.date}
            data-testid="filter-from"
          />
        </div>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="to">
            To (UTC)
          </label>
          <input
            id="to"
            name="to"
            type="date"
            defaultValue={filter.to ?? ''}
            min={filter.from ?? undefined}
            style={styles.date}
            data-testid="filter-to"
          />
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
      <p style={styles.exportNote} data-testid="csv-export-note">
        {search
          ? 'Export CSV downloads every entry that matches these filters, not only this page. Clear resets the filters for both.'
          : 'Export CSV downloads every entry of this workspace, not only this page.'}
      </p>

      {items.length === 0 ? (
        <p style={styles.empty} data-testid="activity-empty">
          {search ? 'No activity matches these filters. Clear the filters to see more.' : 'No activity to show.'}
        </p>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table} data-testid="activity-table">
            <thead>
              <tr>
                <th style={styles.th}>time</th>
                <th style={styles.th}>what happened</th>
                <th style={styles.th}>actor</th>
                <th style={styles.th}>about</th>
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
                  <td style={{ ...styles.td, whiteSpace: 'nowrap' }} data-testid="activity-time">
                    <time dateTime={it.at}>{it.time}</time>
                  </td>
                  <td style={styles.td}>
                    <div style={styles.summary} data-testid="activity-summary">
                      {it.summary}
                    </div>
                    <div style={styles.code} data-testid="activity-action">
                      {it.action}
                    </div>
                    <details data-testid="activity-details">
                      <summary style={styles.detailsSummary}>Technical details</summary>
                      <pre style={styles.pre}>
                        {[
                          `event   ${it.id}`,
                          `time    ${it.at}`,
                          `action  ${it.action}`,
                          `actor   ${it.actorKind}${it.actorLabel ? ` · ${it.actorLabel}` : ''}`,
                          `subject ${it.subjectType ?? '—'}${it.subject ? `: ${it.subject}` : ''}`,
                        ].join('\n')}
                        {it.details ? `\ncontext ${it.details}` : ''}
                      </pre>
                    </details>
                  </td>
                  <td style={styles.td} data-testid="activity-actor">
                    <span
                      style={
                        it.actorBadge === 'agent'
                          ? styles.agentBadge
                          : it.actorBadge === 'end_user'
                            ? styles.endUserBadge
                            : styles.userBadge
                      }
                      data-testid="actor-badge"
                    >
                      {it.actorBadge === 'end_user' ? 'end user' : it.actorBadge}
                    </span>
                    {it.actorLabel}
                  </td>
                  <td style={styles.td} data-testid="activity-subject">
                    {it.links.length > 0 ? (
                      <div style={styles.links}>
                        {it.links.map((l, i) =>
                          l.href ? (
                            <Link key={i} to={l.href} style={styles.link} data-testid="activity-link">
                              {l.label}
                            </Link>
                          ) : (
                            <span key={i} style={styles.gone} data-testid="activity-unlinked">
                              {l.label}
                              {l.note ? <span style={styles.note}> ({l.note})</span> : null}
                            </span>
                          )
                        )}
                      </div>
                    ) : it.subjectType === 'workspace' ? (
                      'this workspace'
                    ) : it.subject ? (
                      <span style={styles.mono}>{it.subject}</span>
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
    </WorkspacePage>
  );
}
