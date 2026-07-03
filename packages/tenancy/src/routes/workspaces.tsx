/**
 * /workspaces — client half (U4, PHY-54): my workspaces with role badges,
 * create-team form, and (super-admin only) the all-workspaces section.
 * Server code lives in ./workspaces.server.ts.
 */
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from 'react-router';
import type { action, loader } from './workspaces.server.js';

export function meta() {
  return [{ title: 'Workspaces — drobek' }];
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
  h2: { fontSize: '1.15rem', marginTop: '2.5rem', marginBottom: '0.5rem' },
  hint: { color: '#555', marginTop: 0, fontSize: '0.95rem' },
  list: { listStyle: 'none', padding: 0, margin: '1rem 0' },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    padding: '0.7rem 0.9rem',
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
    marginBottom: '0.5rem',
    flexWrap: 'wrap',
  },
  wsLink: { fontWeight: 600, color: '#1a1a1a', textDecoration: 'none' },
  slug: { color: '#8a8a8e', fontSize: '0.85rem' },
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
    marginLeft: 'auto',
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
  error: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#991b1b',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    marginTop: '1rem',
  },
  back: { fontSize: '0.9rem', color: '#555' },
} as const;

export default function WorkspacesRoute() {
  const { workspaces, superAdmin, allWorkspaces } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state !== 'idle';

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>Workspaces</h1>
      <p style={styles.hint}>
        Your workspaces and your role in each of them.
      </p>

      <ul style={styles.list} data-testid="my-workspaces">
        {workspaces.map((ws) => (
          <li key={ws.slug} style={styles.item} data-testid="workspace-item">
            <Link to={`/workspaces/${ws.slug}`} style={styles.wsLink}>
              {ws.name}
            </Link>
            <span style={styles.slug}>/{ws.slug}</span>
            <span style={styles.badge}>{ws.kind}</span>
            <span style={styles.roleBadge} data-testid="role-badge">
              {ws.role}
            </span>
          </li>
        ))}
      </ul>

      <h2 style={styles.h2}>Create a team workspace</h2>
      {actionData?.error ? (
        <div style={styles.error} role="alert">
          {actionData.error}
        </div>
      ) : null}
      <Form method="post">
        <label htmlFor="team-name" style={styles.label}>
          Team name
        </label>
        <input
          id="team-name"
          name="name"
          type="text"
          required
          maxLength={80}
          placeholder="Acme Crew"
          style={styles.input}
        />
        <label htmlFor="team-slug" style={styles.label}>
          Slug
        </label>
        <input
          id="team-slug"
          name="slug"
          type="text"
          required
          minLength={3}
          maxLength={40}
          pattern="[a-z0-9-]+"
          placeholder="acme-crew"
          style={styles.input}
        />
        <button type="submit" disabled={submitting} style={styles.button}>
          {submitting ? 'Creating…' : 'Create team'}
        </button>
      </Form>

      {superAdmin && allWorkspaces ? (
        <>
          <h2 style={styles.h2}>All workspaces (super-admin)</h2>
          <ul style={styles.list} data-testid="all-workspaces">
            {allWorkspaces.map((ws) => (
              <li key={ws.slug} style={styles.item}>
                <Link to={`/workspaces/${ws.slug}`} style={styles.wsLink}>
                  {ws.name}
                </Link>
                <span style={styles.slug}>/{ws.slug}</span>
                <span style={styles.badge}>{ws.kind}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <p style={styles.back}>
        <Link to="/me">← Your account</Link>
      </p>
    </main>
  );
}
