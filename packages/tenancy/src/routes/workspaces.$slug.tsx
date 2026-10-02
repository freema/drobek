/**
 * /workspaces/:slug — client half: the workspace's Members tab
 * (inside the shared workspace layout — breadcrumb, name + kind +
 * your role, the workspace tabs). Everyone sees the members; a workspace
 * admin of a team workspace also changes roles, removes members, sees and
 * revokes the pending invites and creates new ones (the form posts to
 * /workspaces/:slug/invite); a member of a team workspace can leave it.
 */
import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import { WorkspacePage, controls } from '../layout.js';
import type { action, loader } from './workspaces.$slug.server.js';

export function meta({
  data,
}: {
  data?: Awaited<ReturnType<typeof loader>>;
}) {
  return [
    { title: `${data?.workspace.name ?? 'Workspace'} — drobek` },
  ];
}

const styles = {
  h2: { fontSize: '1.15rem', marginTop: '2rem', marginBottom: '0.5rem' },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.95rem',
  },
  th: {
    textAlign: 'left',
    borderBottom: '1px solid #e4e4e7',
    padding: '0.45rem 0.5rem 0.45rem 0',
    color: '#555',
    fontSize: '0.8rem',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  td: {
    borderBottom: '1px solid #f0f0f2',
    padding: '0.5rem 0.5rem 0.5rem 0',
    overflowWrap: 'anywhere',
    verticalAlign: 'middle',
  },
  label: {
    display: 'block',
    fontSize: '0.85rem',
    fontWeight: 600,
    marginBottom: '0.35rem',
    marginTop: '0.9rem',
  },
  form: { maxWidth: '28rem' },
  wide: { width: '100%' },
  hint: { color: '#555', marginTop: 0, fontSize: '0.9rem' },
  you: { color: '#71717a', fontSize: '0.85rem' },
  inline: { display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' },
  note: { color: '#71717a', fontSize: '0.85rem' },
  ok: {
    background: '#f0fdf4',
    border: '1px solid #bbf7d0',
    color: '#166534',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    margin: '1rem 0',
  },
  error: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#991b1b',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    margin: '1rem 0',
  },
} as const;

/** `2026-10-09 14:05 UTC` — the same text on the server and in the browser. */
function utc(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

export default function WorkspaceDetailRoute() {
  const { nav, workspace, members, adminCount, canInvite, canManageMembers, canLeave, invites } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== 'idle';
  const me = members.find((m) => m.you);
  const soleAdmin = (m: { role: string }) => m.role === 'workspace-admin' && adminCount <= 1;

  return (
    <WorkspacePage workspace={nav} section="members">
      <h2 style={styles.h2}>Members</h2>
      {result && 'notice' in result ? (
        <p style={styles.ok} role="status" data-testid="members-result">
          {result.notice}
        </p>
      ) : null}
      {result && 'error' in result ? (
        <p style={styles.error} role="alert" data-testid="members-error">
          {result.error}
        </p>
      ) : null}
      {canManageMembers ? (
        <p style={styles.hint}>
          Change a member&apos;s role or remove them. A removed member loses access at once — in the dashboard
          and through their agents — and the apps and versions they made stay in the workspace. A workspace always
          keeps at least one workspace-admin.
        </p>
      ) : null}
      {workspace.kind === 'personal' ? (
        <p style={styles.hint} data-testid="members-personal">
          A personal workspace has one member, its owner. To work with others, create a team workspace on the
          Workspaces page and invite them there.
        </p>
      ) : null}
      <table style={styles.table} data-testid="members">
        <thead>
          <tr>
            <th style={styles.th}>Email</th>
            <th style={styles.th}>Role</th>
            {canManageMembers ? <th style={styles.th}>Remove</th> : null}
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.userId} data-testid="member-row" data-email={m.email} data-role={m.role}>
              <td style={styles.td}>
                {m.email} {m.you ? <span style={styles.you}>(you)</span> : null}
              </td>
              <td style={styles.td}>
                {canManageMembers && !soleAdmin(m) ? (
                  <Form method="post" style={styles.inline}>
                    <input type="hidden" name="intent" value="role" />
                    <input type="hidden" name="userId" value={m.userId} />
                    <select
                      name="role"
                      defaultValue={m.role}
                      aria-label={`Role of ${m.email}`}
                      style={controls.select}
                      data-testid="member-role-select"
                    >
                      <option value="viewer">viewer</option>
                      <option value="editor">editor</option>
                      <option value="workspace-admin">workspace-admin</option>
                    </select>
                    <button type="submit" style={controls.secondaryButton} disabled={busy} data-testid="member-role-save">
                      Change role
                    </button>
                  </Form>
                ) : (
                  <span data-testid="member-role">{m.role}</span>
                )}
                {canManageMembers && soleAdmin(m) ? (
                  <span style={styles.note}> · the only workspace-admin</span>
                ) : null}
              </td>
              {canManageMembers ? (
                <td style={styles.td}>
                  {soleAdmin(m) ? (
                    <span style={styles.note}>Make another member a workspace-admin first</span>
                  ) : m.you ? (
                    <span style={styles.note}>Use Leave below</span>
                  ) : (
                    <Form
                      method="post"
                      onSubmit={(e) => {
                        if (
                          !window.confirm(
                            `Remove ${m.email} from ${nav.name}? They lose access to its apps right away, in the dashboard and through their agents. The apps they made stay here.`
                          )
                        ) {
                          e.preventDefault();
                        }
                      }}
                    >
                      <input type="hidden" name="intent" value="remove" />
                      <input type="hidden" name="userId" value={m.userId} />
                      <button type="submit" style={controls.dangerButton} disabled={busy} data-testid="member-remove">
                        Remove
                      </button>
                    </Form>
                  )}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>

      {canManageMembers ? (
        <section data-testid="pending-invites">
          <h2 style={styles.h2}>Pending invites</h2>
          {invites.length === 0 ? (
            <p style={styles.hint} data-testid="invites-empty">
              No pending invites. An invite you create is listed here until it is accepted, revoked or expires
              (7 days after it was created).
            </p>
          ) : (
            <>
              <p style={styles.hint}>
                Each invite link works once, until it expires. Revoking one stops its link at once.
              </p>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Sent to</th>
                    <th style={styles.th}>Role</th>
                    <th style={styles.th}>Invited by</th>
                    <th style={styles.th}>Expires</th>
                    <th style={styles.th}>Revoke</th>
                  </tr>
                </thead>
                <tbody>
                  {invites.map((i) => (
                    <tr key={i.id} data-testid="invite-row" data-role={i.role}>
                      <td style={styles.td}>{i.email ?? <span style={styles.note}>link only</span>}</td>
                      <td style={styles.td}>{i.role}</td>
                      <td style={styles.td}>{i.invitedBy ?? <span style={styles.note}>a former user</span>}</td>
                      <td style={styles.td}>{utc(i.expiresAt)}</td>
                      <td style={styles.td}>
                        <Form
                          method="post"
                          onSubmit={(e) => {
                            if (!window.confirm('Revoke this invite? Its link stops working at once.')) e.preventDefault();
                          }}
                        >
                          <input type="hidden" name="intent" value="revoke-invite" />
                          <input type="hidden" name="inviteId" value={i.id} />
                          <button type="submit" style={controls.secondaryButton} disabled={busy} data-testid="invite-revoke">
                            Revoke
                          </button>
                        </Form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      ) : null}

      {canInvite ? (
        <section data-testid="invite-form">
          <h2 style={styles.h2}>Invite someone</h2>
          <p style={styles.hint}>
            Leave the email empty to just get a shareable invite link.
          </p>
          <Form method="post" action={`/workspaces/${nav.slug}/invite`} style={styles.form}>
            <label htmlFor="invite-email" style={styles.label}>
              Email (optional)
            </label>
            <input
              id="invite-email"
              name="email"
              type="email"
              autoComplete="off"
              placeholder="teammate@example.com"
              style={{ ...controls.input, ...styles.wide }}
            />
            <label htmlFor="invite-role" style={styles.label}>
              Role
            </label>
            <select
              id="invite-role"
              name="role"
              defaultValue="editor"
              style={{ ...controls.select, ...styles.wide }}
            >
              <option value="viewer">viewer</option>
              <option value="editor">editor</option>
              <option value="workspace-admin">workspace-admin</option>
            </select>
            <button type="submit" style={{ ...controls.button, marginTop: '0.9rem' }}>
              Create invite
            </button>
          </Form>
        </section>
      ) : null}

      {canLeave && me ? (
        <section data-testid="leave-workspace">
          <h2 style={styles.h2}>Leave this workspace</h2>
          <p style={styles.hint}>
            You lose access to its apps at once, in the dashboard and through your agents. The apps and versions
            you made stay in the workspace. To come back, a workspace admin has to invite you again.
          </p>
          {soleAdmin(me) ? (
            <p style={styles.note} data-testid="leave-blocked">
              You are the only workspace-admin. Make another member a workspace-admin first, then you can leave.
            </p>
          ) : (
            <Form
              method="post"
              onSubmit={(e) => {
                if (!window.confirm(`Leave ${nav.name}? You lose access to its apps right away.`)) e.preventDefault();
              }}
            >
              <input type="hidden" name="intent" value="leave" />
              <button type="submit" style={controls.dangerButton} disabled={busy} data-testid="leave-button">
                Leave workspace
              </button>
            </Form>
          )}
        </section>
      ) : null}
    </WorkspacePage>
  );
}
