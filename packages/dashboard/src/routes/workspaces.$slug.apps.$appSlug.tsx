/**
 * /workspaces/:slug/apps/:appSlug — client half (PHY-74 slice): the app's
 * status / visibility / published version, plus its VERSION HISTORY. Each
 * version that compiled and is not published shows a "Publish" button — but
 * ONLY when the viewer may publish (editor+); publishing an older version is
 * the rollback. The button posts to this route's action, which re-enforces
 * the role server-side. Server code lives in the .server.ts.
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
import { PendingBanner } from '../pending-banner.js';

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
  panelGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(18rem, 1fr))',
    gap: '1rem',
    marginTop: '0.5rem',
  },
  panel: {
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
    padding: '0.9rem 1rem',
    background: '#fcfcfd',
  },
  panelHead: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '0.5rem',
    marginBottom: '0.6rem',
  },
  panelTitle: { fontSize: '0.95rem', fontWeight: 700, margin: 0 },
  errItem: {
    borderBottom: '1px solid #f0f0f2',
    padding: '0.5rem 0',
  },
  errMsg: {
    fontFamily: 'ui-monospace, monospace',
    fontSize: '0.82rem',
    color: '#7f1d1d',
    wordBreak: 'break-word',
  },
  errMeta: { fontSize: '0.74rem', color: '#71717a', marginTop: '0.2rem' },
  countPill: {
    display: 'inline-block',
    minWidth: '1.4rem',
    textAlign: 'center',
    padding: '0.05rem 0.4rem',
    fontSize: '0.72rem',
    fontWeight: 700,
    borderRadius: '999px',
    background: '#fee2e2',
    color: '#991b1b',
    border: '1px solid #fecaca',
  },
  statRow: {
    display: 'flex',
    gap: '1.5rem',
    marginBottom: '0.6rem',
    fontSize: '0.85rem',
  },
  statNum: { fontSize: '1.3rem', fontWeight: 700, display: 'block' },
  statLabel: {
    fontSize: '0.7rem',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: '#71717a',
  },
  pathRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '0.6rem',
    padding: '0.3rem 0',
    borderBottom: '1px solid #f0f0f2',
    fontSize: '0.82rem',
  },
  pathText: {
    fontFamily: 'ui-monospace, monospace',
    wordBreak: 'break-word',
    color: '#3f3f46',
  },
} as const;

const COMPILE_LABEL: Record<string, string> = {
  ok: 'compiled ✓',
  error: 'errors ✗',
  pending: 'not compiled',
};

export default function AppDetailRoute() {
  const { workspace, app, versions, errors, logs, canPublish, pendingBanner } =
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
        <Link
          to={`/workspaces/${workspace.slug}/apps/${app.slug}/data`}
          style={styles.navLink}
          data-testid="app-data-link"
        >
          Data
        </Link>
        <Link to={`/workspaces/${workspace.slug}/apps/${app.slug}/modules`} style={styles.navLink} data-testid="app-modules-link">Modules</Link>
        <Link to={`/workspaces/${workspace.slug}`} style={styles.navLink}>
          Members &amp; roles
        </Link>
      </p>

      <div style={styles.headRow}>
        <h1 style={styles.h1}>{app.slug}</h1>
        {app.publishedVersion !== null ? (
          <span style={styles.activeBadge}>published</span>
        ) : (
          <span style={styles.badge}>not published</span>
        )}
        <span style={styles.badge}>{app.status}</span>
        <span style={styles.badge}>{app.visibility}</span>
      </div>

      <PendingBanner banner={pendingBanner} />

      <p style={styles.urlRow} data-testid="app-published-version">
        Published version:{' '}
        {app.publishedVersion !== null ? (
          <code style={styles.mono}>v{app.publishedVersion}</code>
        ) : (
          <span style={styles.muted}>none</span>
        )}
      </p>

      <h2 style={styles.h2}>Overview</h2>
      <div style={styles.panelGrid}>
        <section
          style={styles.panel}
          data-testid="errors-panel"
          aria-label="Recent errors"
        >
          <div style={styles.panelHead}>
            <p style={styles.panelTitle}>Recent errors</p>
            <span style={styles.muted} data-testid="errors-total">
              {errors.totalEvents} event{errors.totalEvents === 1 ? '' : 's'}
            </span>
          </div>
          {errors.errors.length === 0 ? (
            <p style={styles.muted}>No errors reported yet.</p>
          ) : (
            errors.errors.map((e) => (
              <div
                key={e.dedupKey}
                style={styles.errItem}
                data-testid="error-row"
              >
                <div
                  style={{
                    display: 'flex',
                    gap: '0.5rem',
                    alignItems: 'flex-start',
                  }}
                >
                  <span style={styles.countPill} data-testid="error-count">
                    {e.count}×
                  </span>
                  {/* React escapes stored text — no stored XSS. */}
                  <span style={styles.errMsg} data-testid="error-message">
                    {e.message}
                  </span>
                </div>
                <div style={styles.errMeta}>
                  {e.type}
                  {e.fileHint ? ` · ${e.fileHint}` : ''} · last{' '}
                  {formatTimestamp(e.lastSeen)}
                </div>
              </div>
            ))
          )}
        </section>

        <section
          style={styles.panel}
          data-testid="logs-panel"
          aria-label="Traffic and 404s"
        >
          <div style={styles.panelHead}>
            <p style={styles.panelTitle}>Traffic &amp; 404s</p>
          </div>
          <div style={styles.statRow}>
            <span>
              <span style={styles.statNum} data-testid="logs-requests">
                {logs.requests}
              </span>
              <span style={styles.statLabel}>requests</span>
            </span>
            <span>
              <span style={styles.statNum} data-testid="logs-5xx">
                {logs.count5xx}
              </span>
              <span style={styles.statLabel}>5xx</span>
            </span>
            <span>
              <span style={styles.statNum} data-testid="logs-404-distinct">
                {logs.top404Paths.length}
              </span>
              <span style={styles.statLabel}>404 paths</span>
            </span>
          </div>
          <p style={{ ...styles.statLabel, marginBottom: '0.3rem' }}>
            Top missing paths
          </p>
          {logs.top404Paths.length === 0 ? (
            <p style={styles.muted}>No 404s recorded.</p>
          ) : (
            logs.top404Paths.map((p) => (
              <div key={p.path} style={styles.pathRow} data-testid="top404-row">
                {/* React escapes the stored path. */}
                <span style={styles.pathText} data-testid="top404-path">
                  {p.path}
                </span>
                <span style={styles.mono}>{p.count}</span>
              </div>
            ))
          )}
        </section>
      </div>

      <h2 style={styles.h2}>Versions</h2>
      {actionData?.error ? (
        <div style={styles.error} role="alert" data-testid="publish-error">
          {actionData.error}
        </div>
      ) : null}

      {versions.length === 0 ? (
        <p style={styles.muted}>No versions yet — your agent writes the first one.</p>
      ) : (
        <table style={styles.table} data-testid="version-history">
          <thead>
            <tr>
              <th style={styles.th}>Version</th>
              <th style={styles.th}>By</th>
              <th style={styles.th}>Compile</th>
              <th style={styles.th}>Note</th>
              <th style={styles.th}>Created</th>
              <th style={styles.th} />
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id} data-testid="version-row" data-version={v.number}>
                <td style={styles.td}>
                  <code style={styles.mono}>v{v.number}</code>{' '}
                  {v.published ? (
                    <span style={styles.activeBadge} data-testid="version-published">
                      published
                    </span>
                  ) : null}
                </td>
                <td style={styles.td}>{v.actorKind}</td>
                <td style={styles.td}>{COMPILE_LABEL[v.compileStatus]}</td>
                {/* React escapes the agent-supplied reasoning. */}
                <td style={styles.td}>{v.reasoning ?? <span style={styles.muted}>—</span>}</td>
                <td style={styles.td}>{formatTimestamp(v.createdAt)}</td>
                <td style={styles.td}>
                  {canPublish && v.publishable ? (
                    <Form method="post">
                      <input type="hidden" name="versionId" value={v.id} />
                      <button
                        type="submit"
                        style={styles.rbButton}
                        disabled={submitting}
                        data-testid="publish-button"
                        data-version={v.number}
                      >
                        Publish
                      </button>
                    </Form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p style={styles.back}>
        <Link to={`/workspaces/${workspace.slug}/apps`}>← All apps</Link>
      </p>
    </main>
  );
}
