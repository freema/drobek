/**
 * /workspaces/:slug/apps — client half (U8, PHY-74 slice): the workspace's
 * apps with status / visibility / live URL / last-deploy time. Each app links
 * to its detail page (deploy history + rollback). Server code lives in
 * ./workspaces.$slug.apps.server.ts.
 */
import { Link, useLoaderData } from 'react-router';
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
  urlLink: { color: '#1e3a8a', fontSize: '0.85rem', marginLeft: 'auto' },
  empty: {
    color: '#555',
    fontStyle: 'italic',
    padding: '1rem 0',
  },
  back: { fontSize: '0.9rem', color: '#555', marginTop: '2rem' },
} as const;

export default function WorkspaceAppsRoute() {
  const { workspace, apps } = useLoaderData<typeof loader>();

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
      <p style={styles.hint}>Apps deployed in this workspace.</p>

      {apps.length === 0 ? (
        <p style={styles.empty} data-testid="apps-empty">
          No apps yet — deploy one with the drobek MCP tools.
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
              {app.live ? (
                <span style={styles.liveBadge}>live</span>
              ) : (
                <span style={styles.badge}>no deploy</span>
              )}
              {app.status === 'hibernated' ? (
                <span style={styles.hibBadge}>hibernated</span>
              ) : null}
              <span style={styles.badge}>{app.visibility}</span>
              {app.lastDeployAt ? (
                <span style={styles.meta}>
                  deployed {formatTimestamp(app.lastDeployAt)}
                </span>
              ) : null}
              <a
                href={app.url}
                style={styles.urlLink}
                data-testid="app-live-url"
                target="_blank"
                rel="noreferrer"
              >
                {app.url}
              </a>
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
