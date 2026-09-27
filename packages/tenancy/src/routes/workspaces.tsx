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
import { useState } from 'react';
import { DashboardPage, controls, mergeStyles, workspaceHref } from '../layout.js';
import type { action, loader } from './workspaces.server.js';

export function meta() {
  return [{ title: 'Workspaces — drobek' }];
}

const styles = {
  h1: { fontSize: '1.75rem', margin: 0, lineHeight: 1.25 },
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
  form: { display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '0.75rem' },
  field: { display: 'flex', flexDirection: 'column', gap: '0.2rem', flex: '1 1 12rem', minWidth: 0 },
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))', gap: '0.6rem' },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.2rem',
    padding: '0.8rem 0.95rem',
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
    color: '#1a1a1a',
    textDecoration: 'none',
    background: '#fafafa',
  },
  cardTitle: { fontWeight: 700 },
  cardText: { fontSize: '0.85rem', color: '#555', lineHeight: 1.45 },
  empty: { color: '#555', fontStyle: 'italic', padding: '0.5rem 0' },
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

function AllWorkspaces({ workspaces }: { workspaces: readonly { slug: string; name: string; kind: string }[] }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q ? workspaces.filter((ws) => ws.slug.includes(q) || ws.name.toLowerCase().includes(q)) : workspaces;
  return (
    <section>
      <h2 style={styles.h2}>Server administration</h2>
      <p style={styles.hint}>You are a super-admin: these pages act on every workspace of this server.</p>
      <div style={styles.cards} data-testid="super-admin-links">
        <Link to="/admin/publishing" style={styles.card}>
          <span style={styles.cardTitle}>Publishing</span>
          <span style={styles.cardText}>Block, approve or unblock who may put apps on their public address.</span>
        </Link>
        <Link to="/admin/abuse" style={styles.card}>
          <span style={styles.cardTitle}>Moderation queue</span>
          <span style={styles.cardText}>Review abuse reports, take apps down and restore them.</span>
        </Link>
      </div>
      <h2 style={styles.h2}>All workspaces</h2>
      <div style={controls.row}>
        <label style={controls.field}>
          <span style={controls.label}>Filter by name or slug</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="acme"
            style={mergeStyles(controls.input, { width: '18rem', maxWidth: '100%' })}
            data-testid="all-workspaces-filter"
          />
        </label>
        <span style={mergeStyles(controls.link, { color: '#71717a' })} data-testid="all-workspaces-count">
          {q ? `${shown.length} of ${workspaces.length}` : `${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}`}
        </span>
      </div>
      {shown.length === 0 ? (
        <p style={styles.empty} data-testid="all-workspaces-none">
          No workspace matches “{query.trim()}”. Try part of the slug, or clear the filter.
        </p>
      ) : (
        <ul style={styles.list} data-testid="all-workspaces">
          {shown.map((ws) => (
            <li key={ws.slug} style={styles.item}>
              <Link to={workspaceHref(ws.slug)} style={styles.wsLink}>
                {ws.name}
              </Link>
              <span style={styles.slug}>/{ws.slug}</span>
              <span style={styles.badge}>{ws.kind}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function WorkspacesRoute() {
  const { workspaces, superAdmin, allWorkspaces } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state !== 'idle';

  return (
    <DashboardPage>
      <h1 style={styles.h1}>Workspaces</h1>
      <p style={styles.hint}>
        Your workspaces and your role in each of them.
      </p>

      <ul style={styles.list} data-testid="my-workspaces">
        {workspaces.map((ws) => (
          <li key={ws.slug} style={styles.item} data-testid="workspace-item">
            <Link to={workspaceHref(ws.slug)} style={styles.wsLink}>
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
      <p style={styles.hint}>
        A team workspace holds apps several people build together; you become its admin and invite the others from
        its Members tab.
      </p>
      <Form method="post" style={styles.form}>
        <label style={styles.field}>
          <span style={controls.label}>Team name</span>
          <input
            id="team-name"
            name="name"
            type="text"
            required
            maxLength={80}
            placeholder="Acme Crew"
            style={mergeStyles(controls.input, { width: '100%' })}
          />
        </label>
        <label style={styles.field}>
          <span style={controls.label}>Slug</span>
          <input
            id="team-slug"
            name="slug"
            type="text"
            required
            minLength={3}
            maxLength={40}
            pattern="[a-z0-9-]+"
            placeholder="acme-crew"
            style={mergeStyles(controls.input, { width: '100%' })}
          />
        </label>
        <button type="submit" disabled={submitting} style={controls.button}>
          {submitting ? 'Creating…' : 'Create team'}
        </button>
      </Form>

      {superAdmin && allWorkspaces ? <AllWorkspaces workspaces={allWorkspaces} /> : null}

      <p style={styles.back}>
        <Link to="/me">Your account</Link>
      </p>
    </DashboardPage>
  );
}
