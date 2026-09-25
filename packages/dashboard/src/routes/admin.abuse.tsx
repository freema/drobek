/**
 * /admin/abuse — client half (M4-02, NSO-293): the super-admin moderation
 * queue. Open reports (host → app, workspace, reason, details, created) with
 * Take down / Mark resolved, and the list of taken-down apps with Restore.
 * The server gate (super-admin only) is the source of truth.
 */
import { Form, Link, useActionData, useLoaderData } from 'react-router';
import { DashboardPage, controls } from '@drobek/tenancy/layout';
import type { action, loader } from './admin.abuse.server.js';

export function meta() {
  return [{ title: 'Moderation queue — drobek' }];
}

const styles = {
  h1: { fontSize: '1.75rem', marginBottom: '0.25rem' },
  h2: { fontSize: '1.15rem', marginTop: '2.25rem', marginBottom: '0.5rem' },
  nav: { margin: '0 0 1.5rem', fontSize: '0.9rem', color: '#555', display: 'flex', gap: '0.9rem', flexWrap: 'wrap' },
  navLink: { color: '#1a1a1a', fontWeight: 600 },
  hint: { color: '#555', marginTop: 0, fontSize: '0.95rem' },
  list: { listStyle: 'none', padding: 0, margin: '1rem 0' },
  item: { padding: '0.8rem 0.95rem', border: '1px solid #e4e4e7', borderRadius: '10px', marginBottom: '0.7rem' },
  head: { display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' },
  host: { fontWeight: 700, wordBreak: 'break-all' },
  meta: { color: '#555', fontSize: '0.82rem', marginTop: '0.25rem' },
  details: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    background: '#fafafa',
    border: '1px solid #f0f0f2',
    borderRadius: '8px',
    padding: '0.5rem 0.7rem',
    fontSize: '0.9rem',
    marginTop: '0.5rem',
  },
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
  lockedBadge: {
    display: 'inline-block',
    padding: '0.1rem 0.55rem',
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    borderRadius: '999px',
    color: '#991b1b',
    background: '#fee2e2',
    border: '1px solid #fecaca',
  },
  actions: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.6rem' },
  select: controls.select,
  danger: controls.dangerButton,
  secondary: controls.secondaryButton,
  ok: {
    background: '#f0fdf4',
    border: '1px solid #bbf7d0',
    color: '#166534',
    padding: '0.6rem 0.9rem',
    borderRadius: '8px',
    marginTop: '1rem',
    fontSize: '0.9rem',
  },
  error: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#b91c1c',
    padding: '0.6rem 0.9rem',
    borderRadius: '8px',
    marginTop: '1rem',
    fontSize: '0.9rem',
  },
  empty: { color: '#555', fontStyle: 'italic', padding: '0.5rem 0' },
} as const;

function when(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export default function AbuseQueueRoute() {
  const { status, reasons, reports, locked } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();

  return (
    <DashboardPage crumbs={[{ label: 'Workspaces', to: '/workspaces' }, { label: 'Moderation queue' }]}>
      <p style={styles.nav}>
        <Link to={status === 'open' ? '/admin/abuse?status=resolved' : '/admin/abuse'} style={styles.navLink} data-testid="abuse-toggle">
          {status === 'open' ? 'Resolved reports' : 'Open reports'}
        </Link>
      </p>
      <h1 style={styles.h1}>Moderation queue</h1>
      <p style={styles.hint}>
        Reports from the public form and apps flagged by the publish check. Taking an app down unpublishes it, answers
        451 on every one of its addresses, blocks its agent and dashboard changes, and e-mails its owners. Restoring
        lifts the lock but does not republish.
      </p>
      {result ? (
        result.ok ? (
          <p style={styles.ok} role="status" data-testid="abuse-result">
            {result.message}
          </p>
        ) : (
          <p style={styles.error} role="alert" data-testid="abuse-error">
            {result.error}
          </p>
        )
      ) : null}

      <h2 style={styles.h2}>{status === 'open' ? 'Open reports' : 'Resolved reports'}</h2>
      {reports.length === 0 ? (
        <p style={styles.empty} data-testid="abuse-empty">
          Nothing here.
        </p>
      ) : (
        <ul style={styles.list} data-testid="abuse-reports">
          {reports.map((r) => (
            <li key={r.id} style={styles.item} data-testid="abuse-report" data-report-id={r.id} data-host={r.host} data-reason={r.reason}>
              <div style={styles.head}>
                <span style={styles.host}>{r.host}</span>
                <span style={styles.badge} data-testid="abuse-reason">
                  {r.reasonLabel}
                </span>
                {r.app?.locked ? (
                  <span style={styles.lockedBadge} data-testid="abuse-app-locked">
                    taken down
                  </span>
                ) : null}
              </div>
              <div style={styles.meta}>
                {r.app ? (
                  <>
                    app <strong data-testid="abuse-app">{r.app.slug}</strong> in workspace{' '}
                    <Link to={`/workspaces/${r.app.workspaceSlug}`}>{r.app.workspaceSlug}</Link>
                  </>
                ) : (
                  'no app on this server matches the host'
                )}{' '}
                · {when(r.createdAt)} · reporter {r.reporterEmail ?? 'anonymous'}
                {r.resolvedAt ? ` · resolved ${when(r.resolvedAt)}${r.resolvedBy ? ` by ${r.resolvedBy}` : ''}` : ''}
              </div>
              {r.details ? (
                <div style={styles.details} data-testid="abuse-details">
                  {r.details}
                </div>
              ) : null}
              {status === 'open' ? (
                <div style={styles.actions}>
                  {r.app && !r.app.locked ? (
                    <Form method="post" style={styles.actions}>
                      <input type="hidden" name="intent" value="takedown" />
                      <input type="hidden" name="appId" value={r.app.id} />
                      <select
                        name="reason"
                        defaultValue={r.reason === 'heuristic' ? 'phishing' : r.reason}
                        style={styles.select}
                        aria-label="Takedown reason"
                        data-testid="takedown-reason"
                      >
                        {reasons.map((x) => (
                          <option key={x.value} value={x.value}>
                            {x.label}
                          </option>
                        ))}
                      </select>
                      <button type="submit" style={styles.danger} data-testid="takedown">
                        Take down
                      </button>
                    </Form>
                  ) : null}
                  <Form method="post">
                    <input type="hidden" name="intent" value="resolve" />
                    <input type="hidden" name="reportId" value={r.id} />
                    <button type="submit" style={styles.secondary} data-testid="resolve">
                      Mark resolved
                    </button>
                  </Form>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h2 style={styles.h2}>Taken-down apps</h2>
      {locked.length === 0 ? (
        <p style={styles.empty} data-testid="locked-empty">
          None.
        </p>
      ) : (
        <ul style={styles.list} data-testid="locked-apps">
          {locked.map((a) => (
            <li key={a.id} style={styles.item} data-testid="locked-app" data-app-slug={a.slug}>
              <div style={styles.head}>
                <span style={styles.host}>{a.slug}</span>
                <span style={styles.lockedBadge}>{a.reasonLabel}</span>
                <Form method="post" style={{ marginLeft: 'auto' }}>
                  <input type="hidden" name="intent" value="restore" />
                  <input type="hidden" name="appId" value={a.id} />
                  <button type="submit" style={styles.secondary} data-testid="restore">
                    Restore
                  </button>
                </Form>
              </div>
              <div style={styles.meta}>
                workspace <Link to={`/workspaces/${a.workspaceSlug}`}>{a.workspaceSlug}</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </DashboardPage>
  );
}
