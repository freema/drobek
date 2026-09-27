/**
 * /admin/publishing — client half (NSO-366): the super-admin's switch for
 * who may publish. Workspaces with their state (blocked, allowed, waiting,
 * default) and mode-aware actions — `open`: Block / Unblock first;
 * `approval`: Approve / Revoke / Block — plus each workspace's live apps
 * with the moderation queue's takedown form. The server gate (super-admin
 * only) is the source of truth.
 */
import { Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import { DashboardPage, controls } from '@drobek/tenancy/layout';
import type { action, loader } from './admin.publishing.server.js';

export function meta() {
  return [{ title: 'Publishing — drobek' }];
}

function stateLabel(state: string, mode: string): string {
  if (state === 'requested') return 'Waiting requests';
  if (state === 'default') return mode === 'approval' ? 'Not approved' : 'Default';
  if (state === 'allowed') return 'Allowed';
  if (state === 'blocked') return 'Blocked';
  return 'All workspaces';
}

const pill = {
  display: 'inline-block',
  padding: '0.1rem 0.55rem',
  fontSize: '0.72rem',
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  borderRadius: '999px',
} as const;

const styles = {
  h1: { fontSize: '1.75rem', marginBottom: '0.25rem' },
  nav: { margin: '0 0 1.5rem', fontSize: '0.9rem', color: '#555', display: 'flex', gap: '0.9rem', flexWrap: 'wrap' },
  navLink: { color: '#1a1a1a' },
  navActive: { color: '#1a1a1a', fontWeight: 700, textDecoration: 'none' },
  hint: { color: '#555', marginTop: 0, fontSize: '0.95rem' },
  list: { listStyle: 'none', padding: 0, margin: '1rem 0' },
  item: { padding: '0.8rem 0.95rem', border: '1px solid #e4e4e7', borderRadius: '10px', marginBottom: '0.7rem' },
  head: { display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' },
  name: { fontWeight: 700, wordBreak: 'break-all' },
  meta: { color: '#555', fontSize: '0.82rem', marginTop: '0.25rem', wordBreak: 'break-word' },
  badge: { ...pill, border: '1px solid #d4d4d8', color: '#3f3f46', background: '#fafafa' },
  okBadge: { ...pill, color: '#166534', background: '#dcfce7', border: '1px solid #bbf7d0' },
  waitBadge: { ...pill, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a' },
  blockBadge: { ...pill, color: '#991b1b', background: '#fee2e2', border: '1px solid #fecaca' },
  actions: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.6rem' },
  apps: { listStyle: 'none', padding: 0, margin: '0.6rem 0 0', display: 'grid', gap: '0.4rem' },
  appRow: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', fontSize: '0.88rem' },
  appLink: { wordBreak: 'break-all', color: '#1a1a1a' },
  modeNote: {
    background: '#f4f4f5',
    border: '1px solid #e4e4e7',
    padding: '0.6rem 0.9rem',
    borderRadius: '8px',
    fontSize: '0.9rem',
    margin: '1rem 0',
  },
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

type Intent = 'approve' | 'revoke' | 'block' | 'unblock';

const INTENT_UI: Record<Intent, { label: string; style: object; testId: string }> = {
  approve: { label: 'Approve', style: controls.button, testId: 'publishing-approve' },
  revoke: { label: 'Revoke approval', style: controls.secondaryButton, testId: 'publishing-revoke' },
  block: { label: 'Block publishing', style: controls.dangerButton, testId: 'publishing-block' },
  unblock: { label: 'Unblock', style: controls.button, testId: 'publishing-unblock' },
};

/** The actions for one workspace — `open` puts Block / Unblock first, `approval` Approve / Revoke. */
function intentsFor(publishing: string, mode: string): Intent[] {
  if (publishing === 'blocked') return mode === 'approval' ? ['unblock', 'approve'] : ['unblock'];
  if (publishing === 'allowed') return mode === 'approval' ? ['revoke', 'block'] : ['block', 'revoke'];
  return mode === 'approval' ? ['approve', 'block'] : ['block', 'approve'];
}

export default function PublishingRoute() {
  const { state, defaultState, states, workspace, mode, contact, reasons, workspaces } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== 'idle';

  return (
    <DashboardPage crumbs={[{ label: 'Workspaces', to: '/workspaces' }, { label: 'Publishing' }]}>
      <p style={styles.nav} data-testid="publishing-states">
        {states.map((s) => (
          <Link
            key={s}
            to={s === defaultState ? '/admin/publishing' : `/admin/publishing?state=${s}`}
            style={!workspace && s === state ? styles.navActive : styles.navLink}
            aria-current={!workspace && s === state ? 'page' : undefined}
            data-testid="publishing-state"
            data-state={s}
          >
            {stateLabel(s, mode)}
          </Link>
        ))}
        <Link to="/admin/abuse" style={styles.navLink}>
          Moderation queue
        </Link>
      </p>
      <h1 style={styles.h1}>Publishing</h1>
      <p style={styles.hint}>
        Anyone can sign up, create workspaces and build and preview apps. Here you decide who may put an app on its
        public address: <strong>Block publishing</strong> turns it off for a workspace in every mode (its editors and
        admins get an e-mail; live apps keep serving — take one down below);{' '}
        <strong>Approve</strong> lets a workspace publish even when the server requires approval. A refused user is
        shown {contact ?? 'the operator'} as the contact.
      </p>
      {mode === 'open' ? (
        <p style={styles.modeNote} data-testid="publishing-mode-open">
          This server runs <code>PUBLISH_APPROVAL=open</code>: every workspace may publish unless you block it.
        </p>
      ) : (
        <p style={styles.modeNote} data-testid="publishing-mode-approval">
          This server runs <code>PUBLISH_APPROVAL=approval</code>: a workspace publishes only once approved (or with a
          super-admin member). A refused publish e-mails you an approval request, at most once a day per workspace.
        </p>
      )}
      {workspace ? (
        <p style={styles.hint} data-testid="publishing-one">
          Showing workspace <strong>{workspace}</strong> · <Link to="/admin/publishing">all workspaces</Link>
        </p>
      ) : null}
      {result ? (
        result.ok ? (
          <p style={styles.ok} role="status" data-testid="publishing-result">
            {result.message}
          </p>
        ) : (
          <p style={styles.error} role="alert" data-testid="publishing-error">
            {result.error}
          </p>
        )
      ) : null}

      {workspaces.length === 0 ? (
        <p style={styles.empty} data-testid="publishing-empty">
          Nothing here.
        </p>
      ) : (
        <ul style={styles.list} data-testid="publishing-workspaces">
          {workspaces.map((w) => (
            <li
              key={w.id}
              id={`workspace-${w.slug}`}
              style={styles.item}
              data-testid="publishing-workspace"
              data-slug={w.slug}
              data-publishing={w.publishing}
              data-approved={w.publishing === 'allowed' ? '1' : '0'}
            >
              <div style={styles.head}>
                <Link to={`/workspaces/${w.slug}/apps`} style={styles.name}>
                  {w.name}
                </Link>
                <span style={styles.meta}>/{w.slug}</span>
                <span style={styles.badge}>{w.kind}</span>
                {w.publishing === 'blocked' ? (
                  <span style={styles.blockBadge} data-testid="publishing-badge">
                    blocked
                  </span>
                ) : w.publishing === 'allowed' ? (
                  <span style={styles.okBadge} data-testid="publishing-badge">
                    allowed
                  </span>
                ) : w.requestedAt && mode === 'approval' ? (
                  <span style={styles.waitBadge} data-testid="publishing-badge">
                    waiting
                  </span>
                ) : (
                  <span style={styles.badge} data-testid="publishing-badge">
                    {mode === 'approval' ? 'not approved' : 'default'}
                  </span>
                )}
                {w.superAdminMember ? <span style={styles.badge}>super-admin member</span> : null}
              </div>
              <div style={styles.meta}>
                Admins: {w.admins.length > 0 ? w.admins.join(', ') : '—'} · {w.apps} app{w.apps === 1 ? '' : 's'},{' '}
                {w.publishedApps} published · created {when(w.createdAt)}
              </div>
              {w.requestedAt && w.publishing === 'default' ? (
                <div style={styles.meta} data-testid="publishing-requested">
                  Approval requested {when(w.requestedAt)} by {w.requestedBy ?? 'a removed user'}
                </div>
              ) : null}
              {w.blockedAt ? (
                <div style={styles.meta} data-testid="publishing-blocked">
                  Blocked {when(w.blockedAt)}
                  {w.blockedBy ? ` by ${w.blockedBy}` : ''}
                </div>
              ) : null}
              {w.approvedAt ? (
                <div style={styles.meta}>
                  Allowed {when(w.approvedAt)}
                  {w.approvedBy ? ` by ${w.approvedBy}` : ' — no approver recorded (the upgrade allowed workspaces that already had a published app)'}
                </div>
              ) : null}
              <div style={styles.actions}>
                {intentsFor(w.publishing, mode).map((intent) => (
                  <Form method="post" key={intent}>
                    <input type="hidden" name="workspaceId" value={w.id} />
                    <button
                      type="submit"
                      name="intent"
                      value={intent}
                      style={INTENT_UI[intent].style}
                      disabled={busy}
                      data-testid={INTENT_UI[intent].testId}
                    >
                      {INTENT_UI[intent].label}
                    </button>
                  </Form>
                ))}
              </div>
              {w.liveApps.length > 0 ? (
                <ul style={styles.apps} data-testid="publishing-live-apps">
                  {w.liveApps.map((a) => (
                    <li key={a.id} id={`app-${a.slug}`} style={styles.appRow} data-testid="publishing-live-app" data-app={a.slug}>
                      <a href={a.url} target="_blank" rel="noreferrer noopener" style={styles.appLink}>
                        {a.name}
                      </a>
                      <Form method="post" action="/admin/abuse" style={styles.appRow}>
                        <input type="hidden" name="intent" value="takedown" />
                        <input type="hidden" name="appId" value={a.id} />
                        <select name="reason" defaultValue="other" style={controls.select} aria-label={`Takedown reason for ${a.slug}`}>
                          {reasons.map((x) => (
                            <option key={x.value} value={x.value}>
                              {x.label}
                            </option>
                          ))}
                        </select>
                        <button type="submit" style={controls.dangerButton} disabled={busy} data-testid="publishing-takedown">
                          Take down
                        </button>
                      </Form>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </DashboardPage>
  );
}
