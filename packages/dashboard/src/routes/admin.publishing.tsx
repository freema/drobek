/**
 * /admin/publishing — client half (NSO-366): the super-admin's publish
 * approvals. Workspaces with their state (waiting request, not approved,
 * approved) and Approve / Revoke. The server gate (super-admin only) is the
 * source of truth.
 */
import { Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import { DashboardPage, controls } from '@drobek/tenancy/layout';
import type { action, loader } from './admin.publishing.server.js';

export function meta() {
  return [{ title: 'Publish approvals — drobek' }];
}

const STATE_LABEL: Record<string, string> = {
  requested: 'Waiting requests',
  not_approved: 'Not approved',
  approved: 'Approved',
  all: 'All workspaces',
};

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
  okBadge: {
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
  waitBadge: {
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
  actions: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.6rem' },
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

export default function PublishApprovalsRoute() {
  const { state, states, mode, contact, workspaces } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== 'idle';

  return (
    <DashboardPage crumbs={[{ label: 'Workspaces', to: '/workspaces' }, { label: 'Publish approvals' }]}>
      <p style={styles.nav} data-testid="publishing-states">
        {states.map((s) => (
          <Link
            key={s}
            to={s === 'requested' ? '/admin/publishing' : `/admin/publishing?state=${s}`}
            style={s === state ? styles.navActive : styles.navLink}
            aria-current={s === state ? 'page' : undefined}
            data-testid="publishing-state"
            data-state={s}
          >
            {STATE_LABEL[s]}
          </Link>
        ))}
        <Link to="/admin/abuse" style={styles.navLink}>
          Moderation queue
        </Link>
      </p>
      <h1 style={styles.h1}>Publish approvals</h1>
      <p style={styles.hint}>
        Anyone can sign up, create workspaces and build and preview apps. With <code>PUBLISH_APPROVAL=approval</code> a
        workspace publishes only after you approve it here (or when a super-admin is its member). A blocked publish
        e-mails {contact ?? 'the operator'} an approval request, at most once a day per workspace. Revoking stops new
        publishes; apps already live keep serving.
      </p>
      {mode === 'open' ? (
        <p style={styles.modeNote} data-testid="publishing-mode-open">
          This server runs <code>PUBLISH_APPROVAL=open</code>: every workspace may publish. Approvals made here apply
          once the server switches to <code>approval</code>.
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
              style={styles.item}
              data-testid="publishing-workspace"
              data-slug={w.slug}
              data-approved={w.approvedAt ? '1' : '0'}
            >
              <div style={styles.head}>
                <Link to={`/workspaces/${w.slug}/apps`} style={styles.name}>
                  {w.name}
                </Link>
                <span style={styles.meta}>/{w.slug}</span>
                <span style={styles.badge}>{w.kind}</span>
                {w.approvedAt ? (
                  <span style={styles.okBadge} data-testid="publishing-badge">
                    approved
                  </span>
                ) : w.requestedAt ? (
                  <span style={styles.waitBadge} data-testid="publishing-badge">
                    waiting
                  </span>
                ) : (
                  <span style={styles.badge} data-testid="publishing-badge">
                    not approved
                  </span>
                )}
                {w.superAdminMember ? <span style={styles.badge}>super-admin member</span> : null}
              </div>
              <div style={styles.meta}>
                Admins: {w.admins.length > 0 ? w.admins.join(', ') : '—'} · {w.apps} app{w.apps === 1 ? '' : 's'},{' '}
                {w.publishedApps} published · created {when(w.createdAt)}
              </div>
              {w.requestedAt && !w.approvedAt ? (
                <div style={styles.meta} data-testid="publishing-requested">
                  Requested {when(w.requestedAt)} by {w.requestedBy ?? 'a removed user'}
                </div>
              ) : null}
              {w.approvedAt ? (
                <div style={styles.meta}>
                  Approved {when(w.approvedAt)}
                  {w.approvedBy ? ` by ${w.approvedBy}` : ' — no approver recorded (the upgrade approved workspaces that already had a published app)'}
                </div>
              ) : null}
              <div style={styles.actions}>
                <Form method="post">
                  <input type="hidden" name="workspaceId" value={w.id} />
                  {w.approvedAt ? (
                    <button
                      type="submit"
                      name="intent"
                      value="revoke"
                      style={controls.secondaryButton}
                      disabled={busy}
                      data-testid="publishing-revoke"
                    >
                      Revoke
                    </button>
                  ) : (
                    <button type="submit" name="intent" value="approve" style={controls.button} disabled={busy} data-testid="publishing-approve">
                      Approve
                    </button>
                  )}
                </Form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </DashboardPage>
  );
}
