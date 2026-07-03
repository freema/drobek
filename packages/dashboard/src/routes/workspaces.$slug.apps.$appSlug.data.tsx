/**
 * /workspaces/:slug/apps/:appSlug/data — client half (M1b, PHY-121): the Data
 * tab's COLLECTIONS list. Each collection links to its table view. Read-only,
 * minimal style (mirrors the apps/app-detail pages). Server code lives in the
 * .server.ts; all values arrive pre-shaped so this file stays client-safe.
 */
import { Link, useLoaderData } from 'react-router';
import type { loader } from './workspaces.$slug.apps.$appSlug.data.server.js';

export function meta({
  data,
}: {
  data?: Awaited<ReturnType<typeof loader>>;
}) {
  return [{ title: `Data — ${data?.appSlug ?? 'App'} — drobek` }];
}

const styles = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: '48rem',
    margin: '0 auto',
    padding: '4rem 1.5rem',
    color: '#1a1a1a',
    lineHeight: 1.6,
  },
  h1: { fontSize: '1.75rem', marginBottom: '0.25rem' },
  nav: {
    margin: '0 0 1.5rem',
    fontSize: '0.9rem',
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
  collLink: { fontWeight: 600, color: '#1a1a1a', textDecoration: 'none' },
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
  count: { color: '#3f3f46', fontSize: '0.85rem', fontWeight: 600 },
  summary: {
    color: '#8a8a8e',
    fontSize: '0.82rem',
    fontFamily: 'ui-monospace, monospace',
    marginLeft: 'auto',
  },
  empty: { color: '#555', fontStyle: 'italic', padding: '1rem 0' },
  back: { fontSize: '0.9rem', color: '#555', marginTop: '2rem' },
} as const;

export default function AppDataRoute() {
  const { workspace, appSlug, collections } = useLoaderData<typeof loader>();

  return (
    <main style={styles.main}>
      <p style={styles.nav}>
        <Link
          to={`/workspaces/${workspace.slug}/apps/${appSlug}`}
          style={styles.navLink}
        >
          ← {appSlug}
        </Link>
        <Link
          to={`/workspaces/${workspace.slug}/apps`}
          style={styles.navLink}
        >
          Apps
        </Link>
      </p>

      <h1 style={styles.h1}>Data</h1>
      <p style={styles.hint}>
        Collections stored by <strong>{appSlug}</strong> via the drobek Data API.
      </p>

      {collections.length === 0 ? (
        <p style={styles.empty} data-testid="collections-empty">
          No collections yet — define one with the drobek MCP data tools.
        </p>
      ) : (
        <ul style={styles.list} data-testid="collections-list">
          {collections.map((c) => (
            <li
              key={c.name}
              style={styles.item}
              data-testid="collection-row"
              data-collection={c.name}
            >
              <Link
                to={`/workspaces/${workspace.slug}/apps/${appSlug}/data/${c.name}`}
                style={styles.collLink}
                data-testid="collection-link"
              >
                {c.name}
              </Link>
              <span style={styles.count} data-testid="collection-count">
                {c.recordCount} {c.recordCount === 1 ? 'record' : 'records'}
              </span>
              <span style={styles.badge} data-testid="collection-access">
                {c.accessMode}
              </span>
              <span style={styles.summary} title="schema fields">
                {c.schemaSummary}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p style={styles.back}>
        <Link to={`/workspaces/${workspace.slug}/apps/${appSlug}`}>
          ← Back to {appSlug}
        </Link>
      </p>
    </main>
  );
}
