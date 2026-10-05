/**
 * /workspaces/:slug/apps/:appSlug — the app page's Overview tab:
 * the shared header (production / preview URLs, compile state, the agent
 * lock + Unlock, Unpublish), "Before you publish" (the newest version's
 * publish readiness report), the version history (version-history-section:
 * pinned versions, a page of the history, keep / unkeep, the clean-up), the
 * public gallery section (when the server runs one) and the health panels
 * (recent errors, traffic / 404s). The ErrorBoundary explains a page that
 * could not load. Server code lives in the .server.ts.
 */
import { isRouteErrorResponse, Link, useActionData, useLoaderData, useNavigation, useRouteError } from 'react-router';
import { DashboardPage } from '@drobek/tenancy/layout';
import type { action, loader } from './workspaces.$slug.apps.$appSlug.server.js';
import { ActionError, AppPage } from '../app-header.js';
import { DuplicateResult } from '../duplicate-result.js';
import { GallerySection } from '../gallery-section.js';
import { PendingBanner } from '../pending-banner.js';
import { ReadinessSection } from '../readiness-section.js';
import { SyncBanner } from '../sync-banner.js';
import { VersionHistorySection } from '../version-history-section.js';
import { formatTimestamp } from '../view.js';

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  return [{ title: `${data?.header.name ?? data?.header.slug ?? 'App'} — drobek` }];
}

const styles = {
  h2: { fontSize: '1.15rem', marginTop: '2.25rem', marginBottom: '0.5rem' },
  mono: { fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem' },
  muted: { color: '#8a8a8e' },
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

export default function AppDetailRoute() {
  const data = useLoaderData<typeof loader>();
  const { header, errors, logs, readiness, pendingBanner, syncBanner, duplicateResult, gallery } = data;
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state !== 'idle';

  return (
    <AppPage header={header}>
      <ActionError actionData={actionData} />
      <DuplicateResult result={duplicateResult} />
      <PendingBanner banner={pendingBanner} />
      <SyncBanner banner={syncBanner} />

      <ReadinessSection readiness={readiness} />

      <VersionHistorySection data={data} />

      {gallery ? (
        <GallerySection
          gallery={gallery}
          canEdit={header.canEdit}
          busy={submitting}
          settingsHref={`${header.basePath}/settings`}
        />
      ) : null}

      <h2 style={styles.h2}>Health</h2>
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
                  {e.module ? ` · ${e.module} job ${e.job ?? ''}` : ''}
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
    </AppPage>
  );
}

/** A page that could not load: an unknown app, no access, or a server error. */
export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message =
    status === 404
      ? 'This app does not exist in this workspace, or it was deleted. Pick an app from the workspace’s list.'
      : status === 403
        ? 'Your role in this workspace does not allow this. Ask a workspace admin for the editor role.'
        : 'The app page could not be loaded, so its versions are not shown. Reload the page; if it keeps failing, the server log says why.';
  return (
    <DashboardPage crumbs={[{ label: 'Workspaces', to: '/workspaces' }]}>
      <h1 style={{ fontSize: '1.4rem', margin: '0 0 0.5rem' }}>{status === 404 ? 'App not found' : 'Something went wrong'}</h1>
      <p role="alert" data-testid="app-page-error" data-status={status}>
        {message}
      </p>
      <p>
        <Link to="/workspaces">Back to your workspaces</Link>
      </p>
    </DashboardPage>
  );
}
