/**
 * /workspaces/:slug/apps/:appSlug — client half (U8, PHY-74 slice): the app's
 * live URL / status / visibility / active deploy, plus its DEPLOY HISTORY. Each
 * prior READY deploy shows a "Roll back to this" button — but ONLY when the
 * viewer may roll back (editor+). The button posts to this route's action,
 * which re-enforces the role server-side. Server code lives in the .server.ts.
 */
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from 'react-router';
import type {
  action,
  loader,
} from './workspaces.$slug.apps.$appSlug.server.js';
import { formatTimestamp } from '../view.js';

export function meta({
  data,
}: {
  data?: Awaited<ReturnType<typeof loader>>;
}) {
  return [{ title: `${data?.app.slug ?? 'App'} — drobek` }];
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
  h2: { fontSize: '1.15rem', marginTop: '2.25rem', marginBottom: '0.5rem' },
  nav: {
    margin: '0 0 1.5rem',
    fontSize: '0.9rem',
    display: 'flex',
    gap: '0.9rem',
    flexWrap: 'wrap',
  },
  navLink: { color: '#1a1a1a', fontWeight: 600 },
  headRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    flexWrap: 'wrap',
  },
  urlRow: { margin: '0.75rem 0', fontSize: '0.95rem' },
  urlLink: { color: '#1e3a8a' },
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
  activeBadge: {
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
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.9rem',
  },
  th: {
    textAlign: 'left',
    borderBottom: '1px solid #e4e4e7',
    padding: '0.45rem 0.5rem 0.45rem 0',
    color: '#555',
    fontSize: '0.78rem',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  td: {
    borderBottom: '1px solid #f0f0f2',
    padding: '0.55rem 0.5rem 0.55rem 0',
    verticalAlign: 'middle',
  },
  mono: { fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem' },
  rbButton: {
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
  error: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#991b1b',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    marginTop: '1rem',
  },
  muted: { color: '#8a8a8e' },
  back: { fontSize: '0.9rem', color: '#555', marginTop: '2rem' },
} as const;

const LINT_LABEL: Record<string, string> = {
  clean: 'lint ✓',
  blocked: 'lint ✗',
  unknown: 'lint —',
};

export default function AppDetailRoute() {
  const { workspace, app, deploys, canRollback } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state !== 'idle';

  return (
    <main style={styles.main}>
      <p style={styles.nav}>
        <Link
          to={`/workspaces/${workspace.slug}/apps`}
          style={styles.navLink}
        >
          ← Apps
        </Link>
        <Link to={`/workspaces/${workspace.slug}`} style={styles.navLink}>
          Members &amp; roles
        </Link>
      </p>

      <div style={styles.headRow}>
        <h1 style={styles.h1}>{app.slug}</h1>
        {app.activeDeployId ? (
          <span style={styles.activeBadge}>live</span>
        ) : (
          <span style={styles.badge}>no deploy</span>
        )}
        <span style={styles.badge}>{app.status}</span>
        <span style={styles.badge}>{app.visibility}</span>
      </div>

      <p style={styles.urlRow}>
        <a
          href={app.url}
          style={styles.urlLink}
          data-testid="app-live-url"
          target="_blank"
          rel="noreferrer"
        >
          {app.url}
        </a>
      </p>
      <p style={styles.urlRow} data-testid="app-active-deploy">
        Active deploy:{' '}
        {app.activeShortId ? (
          <code style={styles.mono}>{app.activeShortId}</code>
        ) : (
          <span style={styles.muted}>none</span>
        )}
      </p>

      <h2 style={styles.h2}>Deploy history</h2>
      {actionData?.error ? (
        <div style={styles.error} role="alert" data-testid="rollback-error">
          {actionData.error}
        </div>
      ) : null}

      <table style={styles.table} data-testid="deploy-history">
        <thead>
          <tr>
            <th style={styles.th}>Deploy</th>
            <th style={styles.th}>State</th>
            <th style={styles.th}>Lint</th>
            <th style={styles.th}>Created</th>
            <th style={styles.th}>Activated</th>
            <th style={styles.th} />
          </tr>
        </thead>
        <tbody>
          {deploys.map((d) => (
            <tr key={d.id} data-testid="deploy-row" data-deploy-id={d.id}>
              <td style={styles.td}>
                <code style={styles.mono}>{d.shortId}</code>{' '}
                {d.active ? (
                  <span style={styles.activeBadge} data-testid="deploy-active">
                    active
                  </span>
                ) : null}
              </td>
              <td style={styles.td}>{d.state}</td>
              <td style={styles.td}>{LINT_LABEL[d.lintStatus]}</td>
              <td style={styles.td}>{formatTimestamp(d.createdAt)}</td>
              <td style={styles.td}>
                {d.activatedAt ? (
                  formatTimestamp(d.activatedAt)
                ) : (
                  <span style={styles.muted}>—</span>
                )}
              </td>
              <td style={styles.td}>
                {canRollback && d.rollbackTarget ? (
                  <Form method="post">
                    <input type="hidden" name="toDeployId" value={d.id} />
                    <button
                      type="submit"
                      style={styles.rbButton}
                      disabled={submitting}
                      data-testid="rollback-button"
                      data-deploy-id={d.id}
                    >
                      Roll back to this
                    </button>
                  </Form>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={styles.back}>
        <Link to={`/workspaces/${workspace.slug}/apps`}>← All apps</Link>
      </p>
    </main>
  );
}
