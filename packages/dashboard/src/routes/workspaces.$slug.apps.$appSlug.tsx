/**
 * /workspaces/:slug/apps/:appSlug — the app page's Overview tab (NSO-288):
 * the shared header (production / preview URLs, compile state, the agent
 * lock + Unlock, Unpublish), the VERSION HISTORY with its actions, the
 * public gallery section (NSO-340, when the server runs one) and the health
 * panels (recent errors, traffic / 404s).
 *
 * Per version: number, time, author (agent / user + e-mail), the agent's
 * reasoning, compile status (+ the first error), and — editor+ only —
 * "Publish" (a compiled, unpublished version; an older one IS the rollback)
 * and "Restore" (a NEW version with that version's files becomes the working
 * copy, i.e. the preview; production changes only on publish). "Open"
 * links to `<slug>--v<N>` on the apps origin (a link, never a frame — the
 * dashboard origin must not run app code). Server code lives in the .server.ts.
 */
import { Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { action, loader } from './workspaces.$slug.apps.$appSlug.server.js';
import { ActionError, AppPage, appStyles } from '../app-header.js';
import { GallerySection } from '../gallery-section.js';
import { PendingBanner } from '../pending-banner.js';
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

const COMPILE_LABEL: Record<string, string> = {
  ok: 'compiled ✓',
  error: 'errors ✗',
  pending: 'not compiled',
};

export default function AppDetailRoute() {
  const { header, versions, errors, logs, canPublish, pendingBanner, gallery } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state !== 'idle';
  const s = appStyles;

  return (
    <AppPage header={header}>
      <ActionError actionData={actionData} />
      <PendingBanner banner={pendingBanner} />

      <h2 style={styles.h2}>Versions</h2>
      {versions.length === 0 ? (
        <p style={styles.muted}>No versions yet — your agent writes the first one.</p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table} data-testid="version-history">
            <thead>
              <tr>
                <th style={s.th}>Version</th>
                <th style={s.th}>By</th>
                <th style={s.th}>Compile</th>
                <th style={s.th}>Note</th>
                <th style={s.th}>Created</th>
                <th style={s.th} />
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id} data-testid="version-row" data-version={v.number}>
                  <td style={s.td}>
                    <code style={styles.mono}>v{v.number}</code>{' '}
                    {v.published ? (
                      <span style={s.okBadge} data-testid="version-published">
                        published
                      </span>
                    ) : null}
                  </td>
                  <td style={s.td}>
                    {v.actorKind}
                    {v.author ? <div style={{ ...styles.muted, fontSize: '0.78rem' }}>{v.author}</div> : null}
                  </td>
                  <td style={s.td} data-testid="version-compile" data-status={v.compileStatus}>
                    {COMPILE_LABEL[v.compileStatus]}
                    {v.compileErrorCount > 0 ? ` (${v.compileErrorCount})` : ''}
                    {v.compileFirstError ? (
                      // React escapes the compiler's message (it quotes app source).
                      <div style={{ ...styles.mono, fontSize: '0.75rem', color: '#991b1b', wordBreak: 'break-word' }}>
                        {v.compileFirstError}
                      </div>
                    ) : null}
                  </td>
                  {/* React escapes the agent-supplied reasoning. */}
                  <td style={s.td}>{v.reasoning ?? <span style={styles.muted}>—</span>}</td>
                  <td style={s.td}>{formatTimestamp(v.createdAt)}</td>
                  <td style={s.td}>
                    <span style={{ ...s.inline, flexWrap: 'nowrap', overflowWrap: 'normal' }}>
                      {canPublish && v.publishable ? (
                        <Form method="post">
                          <input type="hidden" name="intent" value="publish" />
                          <input type="hidden" name="versionId" value={v.id} />
                          <button
                            type="submit"
                            style={s.button}
                            disabled={submitting}
                            data-testid="publish-button"
                            data-version={v.number}
                          >
                            Publish
                          </button>
                        </Form>
                      ) : null}
                      {canPublish && v.restorable ? (
                        <Form method="post">
                          <input type="hidden" name="intent" value="restore" />
                          <input type="hidden" name="version" value={v.number} />
                          <button
                            type="submit"
                            style={s.secondaryButton}
                            disabled={submitting}
                            title="Create a new version with these files as the working copy (the preview)"
                            data-testid="restore-button"
                            data-version={v.number}
                          >
                            Restore
                          </button>
                        </Form>
                      ) : null}
                      {v.openUrl ? (
                        <a
                          href={v.openUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid="version-open-link"
                          data-version={v.number}
                        >
                          Open
                        </a>
                      ) : null}
                      <Link
                        to={`${header.basePath}/files?version=${v.number}`}
                        data-testid="version-files-link"
                        data-version={v.number}
                      >
                        Files
                      </Link>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {gallery ? <GallerySection gallery={gallery} canEdit={header.canEdit} busy={submitting} /> : null}

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
