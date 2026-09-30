/**
 * /admin/abuse — client half: the super-admin moderation
 * queue. Open reports (host → app, workspace, reason, details, created) with
 * Take down / Mark resolved, the list of taken-down apps with Restore, and
 * (when the server runs a gallery) the gallery entries with Hide /
 * Show again. Every app links to its dashboard overview and, when it is
 * published, to its public address, so it can be judged before acting.
 * Take down opens a confirm panel first (a GET, works without JavaScript);
 * only the panel's button takes the app down.
 * The server gate (super-admin only) is the source of truth.
 */
import { useEffect, useRef } from 'react';
import { Form, Link, useActionData, useLoaderData, useLocation, useNavigation } from 'react-router';
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
  actions: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end', marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid #f0f0f2' },
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
  appName: { fontWeight: 700, wordBreak: 'break-word', color: '#1a1a1a' },
  links: { display: 'flex', gap: '0.25rem 0.9rem', flexWrap: 'wrap', fontSize: '0.85rem', marginTop: '0.3rem' },
  link: { color: '#1e3a8a', wordBreak: 'break-all' },
  confirm: {
    border: '2px solid #b91c1c',
    borderRadius: '10px',
    padding: '0.9rem 1rem',
    margin: '1.25rem 0',
    background: '#fff',
  },
  confirmH: { fontSize: '1.1rem', margin: '0 0 0.4rem', overflowWrap: 'anywhere' },
  effects: { margin: '0.5rem 0 0.75rem', paddingLeft: '1.2rem', fontSize: '0.92rem', overflowWrap: 'anywhere' },
} as const;

function when(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/** The app's dashboard overview + its public address (when published), for judging it first. */
function AppLinks({ appPath, publicUrl, workspaceSlug }: { appPath: string; publicUrl: string | null; workspaceSlug: string }) {
  return (
    <div style={styles.links}>
      <Link to={appPath} style={styles.link} data-testid="moderation-app-overview">
        App overview
      </Link>
      {publicUrl ? (
        <a href={publicUrl} target="_blank" rel="noreferrer noopener" style={styles.link} data-testid="moderation-app-public">
          Open the public app ↗
        </a>
      ) : (
        <span style={{ color: '#71717a' }}>not published</span>
      )}
      <Link to={`/workspaces/${workspaceSlug}/apps`} style={styles.link} data-testid="moderation-workspace-apps">
        Apps in {workspaceSlug}
      </Link>
    </div>
  );
}

export default function AbuseQueueRoute() {
  const { status, confirm, confirmError, reasons, reports, locked, gallery } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== 'idle';
  const { pathname, search } = useLocation();
  const back = search.includes('confirm=') ? '/admin/abuse' : `${pathname}${search}`;
  const confirmRef = useRef<HTMLElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, [confirm?.appId]);

  return (
    <DashboardPage crumbs={[{ label: 'Workspaces', to: '/workspaces' }, { label: 'Moderation queue' }]}>
      <p style={styles.nav}>
        <Link to={status === 'open' ? '/admin/abuse?status=resolved' : '/admin/abuse'} style={styles.navLink} data-testid="abuse-toggle">
          {status === 'open' ? 'Resolved reports' : 'Open reports'}
        </Link>
        <Link to="/admin/publishing" style={styles.navLink} data-testid="abuse-publishing-link">
          Publishing
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
      {confirmError ? (
        <p style={styles.error} role="alert" data-testid="takedown-confirm-error">
          {confirmError}
        </p>
      ) : null}
      {confirm ? (
        <section
          ref={confirmRef}
          tabIndex={-1}
          style={styles.confirm}
          aria-labelledby="takedown-confirm-title"
          data-testid="takedown-confirm"
          data-app-slug={confirm.slug}
          data-reason={confirm.reason}
        >
          <h2 id="takedown-confirm-title" style={styles.confirmH}>
            Take down {confirm.name ? `${confirm.name} (${confirm.slug})` : confirm.slug}?
          </h2>
          <div style={styles.meta}>
            Workspace <strong>{confirm.workspaceName}</strong> (/{confirm.workspaceSlug}) · reason{' '}
            <strong data-testid="takedown-confirm-reason">{confirm.reasonLabel}</strong>
          </div>
          <AppLinks appPath={confirm.appPath} publicUrl={confirm.publicUrl} workspaceSlug={confirm.workspaceSlug} />
          <ul style={styles.effects} data-testid="takedown-confirm-effects">
            {confirm.effects.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          <div style={controls.row}>
            <Form method="post" action="/admin/abuse">
              <input type="hidden" name="intent" value="takedown" />
              <input type="hidden" name="appId" value={confirm.appId} />
              <input type="hidden" name="reason" value={confirm.reason} />
              <input type="hidden" name="confirmed" value="1" />
              <button type="submit" style={styles.danger} disabled={busy} data-testid="takedown-confirm-submit">
                {busy ? 'Working…' : `Take down ${confirm.slug}`}
              </button>
            </Form>
            <Link to={confirm.back} style={controls.link} data-testid="takedown-confirm-cancel">
              Cancel, keep it online
            </Link>
          </div>
        </section>
      ) : null}

      <h2 style={styles.h2}>{status === 'open' ? 'Open reports' : 'Resolved reports'}</h2>
      {reports.length === 0 ? (
        <p style={styles.empty} data-testid="abuse-empty">
          {status === 'open'
            ? 'No open reports. Reports from the public form and apps the publish check flags appear here.'
            : 'No resolved reports yet. A report you mark resolved or act on moves here.'}
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
                    app{' '}
                    <Link to={r.app.appPath} style={styles.appName} data-testid="abuse-app">
                      {r.app.slug}
                    </Link>{' '}
                    in workspace {r.app.workspaceSlug}
                  </>
                ) : (
                  'no app on this server matches the host'
                )}{' '}
                · {when(r.createdAt)} · reporter {r.reporterEmail ?? 'anonymous'}
                {r.resolvedAt ? ` · resolved ${when(r.resolvedAt)}${r.resolvedBy ? ` by ${r.resolvedBy}` : ''}` : ''}
              </div>
              {r.app ? <AppLinks appPath={r.app.appPath} publicUrl={r.app.publicUrl} workspaceSlug={r.app.workspaceSlug} /> : null}
              {r.details ? (
                <div style={styles.details} data-testid="abuse-details">
                  {r.details}
                </div>
              ) : null}
              {status === 'open' ? (
                <div style={styles.actions}>
                  {r.app && !r.app.locked ? (
                    <Form method="get" action="/admin/abuse" style={controls.row}>
                      <input type="hidden" name="confirm" value="takedown" />
                      <input type="hidden" name="app" value={r.app.id} />
                      <input type="hidden" name="back" value={back} />
                      <label style={controls.field}>
                        <span style={controls.label}>Takedown reason</span>
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
                      </label>
                      <button type="submit" style={styles.danger} data-testid="takedown">
                        Take down…
                      </button>
                    </Form>
                  ) : null}
                  <Form method="post" action="/admin/abuse" style={controls.row}>
                    <input type="hidden" name="intent" value="resolve" />
                    <input type="hidden" name="reportId" value={r.id} />
                    <button type="submit" style={styles.secondary} disabled={busy} data-testid="resolve">
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
          No app is taken down. An app you take down from a report appears here, with Restore to lift the lock.
        </p>
      ) : (
        <ul style={styles.list} data-testid="locked-apps">
          {locked.map((a) => (
            <li key={a.id} style={styles.item} data-testid="locked-app" data-app-slug={a.slug}>
              <div style={styles.head}>
                <Link to={a.appPath} style={styles.appName} data-testid="locked-app-overview">
                  {a.name ? `${a.name} (${a.slug})` : a.slug}
                </Link>
                <span style={styles.lockedBadge}>{a.reasonLabel}</span>
                <Form method="post" action="/admin/abuse" style={{ marginLeft: 'auto' }}>
                  <input type="hidden" name="intent" value="restore" />
                  <input type="hidden" name="appId" value={a.id} />
                  <button type="submit" style={styles.secondary} disabled={busy} data-testid="restore">
                    Restore
                  </button>
                </Form>
              </div>
              <div style={styles.meta}>
                workspace <Link to={`/workspaces/${a.workspaceSlug}/apps`}>{a.workspaceSlug}</Link> · every address of the app
                answers 451 until you restore it; a restore does not publish it again.
              </div>
            </li>
          ))}
        </ul>
      )}

      {gallery ? (
        <>
          <h2 style={styles.h2}>Gallery</h2>
          <p style={styles.hint}>
            Apps their owners listed in the public gallery. Hiding one takes it off the gallery at once; its owner cannot
            list it again until you show it again.
          </p>
          {gallery.length === 0 ? (
            <p style={styles.empty} data-testid="gallery-empty">
              No app is listed in the gallery yet. Owners list an app from its settings; it appears here once listed.
            </p>
          ) : (
            <ul style={styles.list} data-testid="gallery-entries">
              {gallery.map((g) => (
                <li key={g.id} style={styles.item} data-testid="gallery-entry" data-app-slug={g.slug}>
                  <div style={styles.head}>
                    <Link to={g.appPath} style={styles.appName} data-testid="gallery-entry-overview">
                      {g.name ?? g.slug}
                    </Link>
                    {g.hidden ? (
                      <span style={styles.lockedBadge} data-testid="gallery-entry-hidden">
                        hidden
                      </span>
                    ) : g.visible ? (
                      <span style={styles.badge}>shown</span>
                    ) : (
                      <span style={styles.badge}>not shown</span>
                    )}
                    <Form method="post" action="/admin/abuse" style={{ marginLeft: 'auto' }}>
                      <input type="hidden" name="intent" value={g.hidden ? 'gallery-show' : 'gallery-hide'} />
                      <input type="hidden" name="appId" value={g.id} />
                      <button
                        type="submit"
                        disabled={busy}
                        style={g.hidden ? styles.secondary : styles.danger}
                        data-testid={g.hidden ? 'gallery-show' : 'gallery-hide'}
                      >
                        {g.hidden ? 'Show again' : 'Hide from gallery'}
                      </button>
                    </Form>
                  </div>
                  {g.description ? <div style={styles.details}>{g.description}</div> : null}
                  <div style={styles.meta}>
                    app <strong>{g.slug}</strong> in workspace {g.workspaceSlug}
                  </div>
                  <AppLinks appPath={g.appPath} publicUrl={g.publicUrl} workspaceSlug={g.workspaceSlug} />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </DashboardPage>
  );
}
