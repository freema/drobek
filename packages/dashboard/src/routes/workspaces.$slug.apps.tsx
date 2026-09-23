/**
 * /workspaces/:slug/apps — client half (U8, PHY-74 slice; filters NSO-288):
 * the workspace's apps with name / status / visibility / published state /
 * latest version, a search + published filter + sort (a plain GET form, so
 * the filtered list is a shareable URL). Each app links to its page. Server
 * code lives in ./workspaces.$slug.apps.server.ts.
 */
import { Form, Link, useLoaderData } from 'react-router';
import type { loader } from './workspaces.$slug.apps.server.js';
import { formatTimestamp } from '../view.js';

export function meta({
  data,
}: {
  data?: Awaited<ReturnType<typeof loader>>;
}) {
  return [{ title: `Apps — ${data?.workspace.name ?? 'Workspace'} — drobek` }];
}

const styles = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: '46rem',
    margin: '0 auto',
    padding: '4rem 1.5rem',
    color: '#1a1a1a',
    lineHeight: 1.6,
  },
  h1: { fontSize: '1.75rem', marginBottom: '0.25rem' },
  headRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    flexWrap: 'wrap',
  },
  nav: {
    margin: '0 0 1.5rem',
    fontSize: '0.9rem',
    color: '#555',
    display: 'flex',
    gap: '0.9rem',
    flexWrap: 'wrap',
  },
  navLink: { color: '#1a1a1a', fontWeight: 600 },
  hint: { color: '#555', marginTop: 0, fontSize: '0.95rem' },
  list: { listStyle: 'none', padding: 0, margin: '1.25rem 0' },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    padding: '0.75rem 0.9rem',
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
    marginBottom: '0.6rem',
    flexWrap: 'wrap',
  },
  appLink: { fontWeight: 600, color: '#1a1a1a', textDecoration: 'none' },
  meta: { color: '#8a8a8e', fontSize: '0.85rem' },
  badge: {
    display: 'inline-block',
    padding: '0.1rem 0.55rem',
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    borderRadius: '999px',
    border: '1px solid #d4d4d8',
    color: '#3f3f46',
    background: '#fafafa',
  },
  liveBadge: {
    display: 'inline-block',
    padding: '0.1rem 0.55rem',
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    borderRadius: '999px',
    color: '#166534',
    background: '#dcfce7',
    border: '1px solid #bbf7d0',
  },
  hibBadge: {
    display: 'inline-block',
    padding: '0.1rem 0.55rem',
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    borderRadius: '999px',
    color: '#92400e',
    background: '#fef3c7',
    border: '1px solid #fde68a',
  },
  empty: {
    color: '#555',
    fontStyle: 'italic',
    padding: '1rem 0',
  },
  back: { fontSize: '0.9rem', color: '#555', marginTop: '2rem' },
  filters: {
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'center',
    flexWrap: 'wrap',
    margin: '1.25rem 0 0',
    fontSize: '0.9rem',
  },
  input: {
    padding: '0.35rem 0.5rem',
    fontSize: '0.9rem',
    fontFamily: 'inherit',
    border: '1px solid #d4d4d8',
    borderRadius: '7px',
    minWidth: '12rem',
  },
  select: { padding: '0.3rem 0.4rem', fontSize: '0.9rem', fontFamily: 'inherit' },
  button: {
    padding: '0.35rem 0.75rem',
    fontSize: '0.85rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#fff',
    background: '#1a1a1a',
    border: 'none',
    borderRadius: '7px',
    cursor: 'pointer',
  },
  notice: {
    background: '#f4f4f5',
    border: '1px solid #e4e4e7',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    marginTop: '1rem',
  },
  name: { color: '#8a8a8e', fontSize: '0.85rem' },
} as const;

export default function WorkspaceAppsRoute() {
  const { workspace, apps, total, filters, deletedSlug, slugReleaseDays } = useLoaderData<typeof loader>();
  const filtered = filters.q !== '' || filters.status !== 'all';

  return (
    <main style={styles.main}>
      <p style={styles.nav}>
        <Link to="/workspaces" style={styles.navLink}>
          ← Workspaces
        </Link>
        <Link to={`/workspaces/${workspace.slug}`} style={styles.navLink}>
          Members &amp; roles
        </Link>
      </p>

      <div style={styles.headRow}>
        <h1 style={styles.h1}>{workspace.name}</h1>
        <span style={styles.badge}>{workspace.kind}</span>
      </div>
      <p style={styles.hint}>Apps in this workspace.</p>

      {deletedSlug ? (
        <p style={styles.notice} role="status" data-testid="apps-deleted-notice">
          <strong>{deletedSlug}</strong> was deleted. Its address stays reserved for {slugReleaseDays} days.
        </p>
      ) : null}

      {total > 0 ? (
        <Form method="get" style={styles.filters} data-testid="apps-filters">
          <input
            type="search"
            name="q"
            defaultValue={filters.q}
            placeholder="Search name or address"
            aria-label="Search apps"
            style={styles.input}
            data-testid="apps-filter-q"
          />
          <select
            name="status"
            defaultValue={filters.status}
            aria-label="Published state"
            style={styles.select}
            data-testid="apps-filter-status"
          >
            <option value="all">All apps</option>
            <option value="published">Published</option>
            <option value="unpublished">Not published</option>
          </select>
          <select name="sort" defaultValue={filters.sort} aria-label="Sort" style={styles.select} data-testid="apps-filter-sort">
            <option value="updated">Recently changed</option>
            <option value="created">Newest</option>
            <option value="name">Name</option>
          </select>
          <button type="submit" style={styles.button} data-testid="apps-filter-apply">
            Filter
          </button>
          {filtered ? (
            <span style={styles.meta} data-testid="apps-filter-count">
              {apps.length} of {total}
            </span>
          ) : null}
        </Form>
      ) : null}

      {total === 0 ? (
        <p style={styles.empty} data-testid="apps-empty">
          No apps yet — ask your agent to create one with the drobek MCP tools.
        </p>
      ) : apps.length === 0 ? (
        <p style={styles.empty} data-testid="apps-no-match">
          No app matches the filter.
        </p>
      ) : (
        <ul style={styles.list} data-testid="apps-list">
          {apps.map((app) => (
            <li
              key={app.slug}
              style={styles.item}
              data-testid="app-row"
              data-app-slug={app.slug}
            >
              <Link
                to={`/workspaces/${workspace.slug}/apps/${app.slug}`}
                style={styles.appLink}
                data-testid="app-detail-link"
              >
                {app.slug}
              </Link>
              {app.name && app.name !== app.slug ? <span style={styles.name}>{app.name}</span> : null}
              {app.published ? (
                <span style={styles.liveBadge}>published</span>
              ) : (
                <span style={styles.badge}>not published</span>
              )}
              {app.status === 'hibernated' ? (
                <span style={styles.hibBadge}>hibernated</span>
              ) : null}
              <span style={styles.badge}>{app.visibility}</span>
              {app.latestVersion !== null && app.lastChangeAt ? (
                <span style={styles.meta} data-testid="app-latest-version">
                  v{app.latestVersion} · {formatTimestamp(app.lastChangeAt)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <p style={styles.back}>
        <Link to={`/workspaces/${workspace.slug}`}>← {workspace.name}</Link>
      </p>
    </main>
  );
}
