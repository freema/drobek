/**
 * /workspaces/:slug — client half (U4, PHY-54): the workspace's Members tab
 * (NSO-342: inside the shared workspace layout — breadcrumb, name + kind +
 * your role, the workspace tabs), the members list, and the invite form
 * (workspace-admins/super-admins on team workspaces only). The invite form
 * posts to /workspaces/:slug/invite.
 */
import { Form, useLoaderData } from 'react-router';
import { WorkspacePage, controls } from '../layout.js';
import type { loader } from './workspaces.$slug.server.js';

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
} as const;

export default function WorkspaceDetailRoute() {
  const { nav, members, canInvite } = useLoaderData<typeof loader>();

  return (
    <WorkspacePage workspace={nav} section="members">
      <h2 style={styles.h2}>Members</h2>
      <table style={styles.table} data-testid="members">
        <thead>
          <tr>
            <th style={styles.th}>Email</th>
            <th style={styles.th}>Role</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.email} data-testid="member-row">
              <td style={styles.td}>{m.email}</td>
              <td style={styles.td}>{m.role}</td>
            </tr>
          ))}
        </tbody>
      </table>

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
    </WorkspacePage>
  );
}
