/**
 * /workspaces/:slug — client half (U4, PHY-54): workspace name + kind,
 * members list, and the invite form (workspace-admins/super-admins on team
 * workspaces only). The invite form posts to /workspaces/:slug/invite.
 */
import { Form, Link, useLoaderData } from 'react-router';
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
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: '42rem',
    margin: '0 auto',
    padding: '4rem 1.5rem',
    color: '#1a1a1a',
    lineHeight: 1.6,
  },
  h1: { fontSize: '1.75rem', marginBottom: '0.25rem' },
  h2: { fontSize: '1.15rem', marginTop: '2.25rem', marginBottom: '0.5rem' },
  headRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    flexWrap: 'wrap',
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
  roleBadge: {
    display: 'inline-block',
    padding: '0.1rem 0.55rem',
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    borderRadius: '999px',
    color: '#1e3a8a',
    background: '#dbeafe',
    border: '1px solid #bfdbfe',
  },
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
  },
  label: {
    display: 'block',
    fontSize: '0.85rem',
    fontWeight: 600,
    marginBottom: '0.35rem',
    marginTop: '0.9rem',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '0.6rem 0.75rem',
    fontSize: '1rem',
    fontFamily: 'inherit',
    border: '1px solid #d4d4d8',
    borderRadius: '8px',
  },
  select: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '0.6rem 0.75rem',
    fontSize: '1rem',
    fontFamily: 'inherit',
    border: '1px solid #d4d4d8',
    borderRadius: '8px',
    background: '#fff',
  },
  button: {
    marginTop: '0.9rem',
    padding: '0.6rem 1.1rem',
    fontSize: '1rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#fff',
    background: '#1a1a1a',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  hint: { color: '#555', marginTop: 0, fontSize: '0.9rem' },
  back: { fontSize: '0.9rem', color: '#555', marginTop: '2rem' },
} as const;

export default function WorkspaceDetailRoute() {
  const { workspace, members, role, canInvite } =
    useLoaderData<typeof loader>();

  return (
    <main style={styles.main}>
      <div style={styles.headRow}>
        <h1 style={styles.h1}>{workspace.name}</h1>
        <span style={styles.badge}>{workspace.kind}</span>
        <span style={styles.roleBadge} data-testid="my-role">
          {role}
        </span>
      </div>

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
          <Form method="post" action={`/workspaces/${workspace.slug}/invite`}>
            <label htmlFor="invite-email" style={styles.label}>
              Email (optional)
            </label>
            <input
              id="invite-email"
              name="email"
              type="email"
              autoComplete="off"
              placeholder="teammate@example.com"
              style={styles.input}
            />
            <label htmlFor="invite-role" style={styles.label}>
              Role
            </label>
            <select
              id="invite-role"
              name="role"
              defaultValue="editor"
              style={styles.select}
            >
              <option value="viewer">viewer</option>
              <option value="editor">editor</option>
              <option value="workspace-admin">workspace-admin</option>
            </select>
            <button type="submit" style={styles.button}>
              Create invite
            </button>
          </Form>
        </section>
      ) : null}

      <p style={styles.back}>
        <Link to="/workspaces">← Workspaces</Link>
      </p>
    </main>
  );
}
