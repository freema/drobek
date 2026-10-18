/**
 * /workspaces — client half: my workspaces with role badges,
 * create-team form, and (super-admin only) the all-workspaces section: a
 * search, quick filters, a sort and a page of workspaces, each saying when it
 * was created, who owns it, its members, apps and last activity.
 * Server code lives in ./workspaces.server.ts.
 */
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from 'react-router';
import { AdminChips, AdminFilterBar, AdminListCount, AdminPager, type AdminChipGroup } from '../admin-list-ui.js';
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
  wsLink: { fontWeight: 600, color: '#1a1a1a', textDecoration: 'none', overflowWrap: 'anywhere', minWidth: 0 },
  slug: { color: '#71717a', fontSize: '0.85rem', overflowWrap: 'anywhere', minWidth: 0 },
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
  superBadge: {
    display: 'inline-block',
    padding: '0.1rem 0.55rem',
    fontSize: '0.72rem',
    fontWeight: 700,
    borderRadius: '999px',
    color: '#7c2d12',
    background: '#ffedd5',
    border: '1px solid #fdba74',
    marginLeft: 'auto',
  },
  facts: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.15rem 0.9rem',
    flexBasis: '100%',
    color: '#52525b',
    fontSize: '0.85rem',
    overflowWrap: 'anywhere',
    minWidth: 0,
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
  ok: {
    background: '#f0fdf4',
    border: '1px solid #bbf7d0',
    color: '#166534',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    margin: '1rem 0',
  },
} as const;

type AllWorkspacesData = NonNullable<Awaited<ReturnType<typeof loader>>['allWorkspaces']>;

const WORKSPACE_SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name', label: 'Name' },
  { value: 'apps', label: 'Most apps' },
  { value: 'activity', label: 'Recent activity' },
] as const;

const WORKSPACE_CHIPS: readonly AdminChipGroup[] = [
  { param: 'kind', label: 'Kind', allLabel: 'Any', options: [{ value: 'personal', label: 'Personal' }, { value: 'team', label: 'Team' }] },
  {
    param: 'apps',
    label: 'Apps',
    allLabel: 'Any',
    options: [
      { value: 'none', label: 'No apps' },
      { value: 'some', label: 'Has apps' },
      { value: 'published', label: 'Has published' },
    ],
  },
  {
    param: 'publishing',
    label: 'Publishing',
    allLabel: 'Any',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'approved', label: 'Approved' },
      { value: 'blocked', label: 'Blocked' },
    ],
  },
];

const ALL_WORKSPACES_PATH = '/workspaces';

function appCountLabel(apps: number, published: number): string {
  if (apps === 0) return 'No apps';
  return `${apps} app${apps === 1 ? '' : 's'} · ${published} published`;
}

function AllWorkspaces({ data }: { data: AllWorkspacesData }) {
  const { params, rows } = data;
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
      <h2 style={styles.h2} id="all-workspaces">
        All workspaces
      </h2>
      <AdminFilterBar
        path={ALL_WORKSPACES_PATH}
        params={params}
        label="Search name, slug or admin e-mail"
        placeholder="acme"
        sorts={WORKSPACE_SORTS}
        testId="all-workspaces-filter"
      />
      <AdminChips path={ALL_WORKSPACES_PATH} params={params} groups={WORKSPACE_CHIPS} testId="all-workspaces-chips" />
      {data.error ? (
        <p style={styles.error} role="alert" data-testid="all-workspaces-error">
          The list of all workspaces could not be loaded, so none is shown. Reload the page; if it keeps failing, the
          server log says why.
        </p>
      ) : (
        <>
          <AdminListCount
            total={data.total}
            matching={data.matching}
            filtered={data.filtered}
            noun={['workspace', 'workspaces']}
            testId="all-workspaces-count"
          />
          {data.total === 0 ? (
            <p style={styles.empty} data-testid="all-workspaces-empty">
              No workspace exists on this server yet. Each person gets a personal workspace when they first sign in.
            </p>
          ) : rows.length === 0 ? (
            <p style={styles.empty} data-testid="all-workspaces-none">
              No workspace matches {params.q ? `“${params.q}”` : 'these filters'}. Try part of the slug or an e-mail, or
              choose Clear to see every workspace.
            </p>
          ) : (
            <ul style={styles.list} data-testid="all-workspaces">
              {rows.map((ws) => (
                <li key={ws.slug} style={styles.item} data-testid="all-workspace-item" data-slug={ws.slug}>
                  <Link to={workspaceHref(ws.slug)} style={styles.wsLink}>
                    {ws.name}
                  </Link>
                  <span style={styles.slug}>/{ws.slug}</span>
                  <span style={styles.badge}>{ws.kind}</span>
                  {ws.publishing !== 'default' ? (
                    <span style={styles.badge} data-testid="workspace-publishing">
                      publishing {ws.publishing}
                    </span>
                  ) : null}
                  {ws.myRole ? (
                    <span style={styles.roleBadge} data-testid="all-workspace-access">
                      {ws.myRole}
                    </span>
                  ) : (
                    <span style={styles.superBadge} data-testid="all-workspace-access">
                      Superadmin access — not a member
                    </span>
                  )}
                  <span style={styles.facts}>
                    <span title={ws.created.at} data-testid="workspace-created">
                      created {ws.created.ago}
                    </span>
                    {ws.adminEmail ? (
                      <span data-testid="workspace-owner">
                        {ws.kind === 'personal' ? 'owner' : 'admin'} {ws.adminEmail}
                      </span>
                    ) : null}
                    <span data-testid="workspace-members">
                      {ws.members} member{ws.members === 1 ? '' : 's'}
                    </span>
                    <span data-testid="workspace-app-count">{appCountLabel(ws.apps, ws.publishedApps)}</span>
                    <span title={ws.lastActivity?.at} data-testid="workspace-last-activity">
                      {ws.lastActivity ? `last activity ${ws.lastActivity.ago}` : 'no activity yet'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <AdminPager
            path={ALL_WORKSPACES_PATH}
            params={params}
            page={data.page}
            pageSize={data.pageSize}
            matching={data.matching}
            testId="all-workspaces-pager"
          />
        </>
      )}
    </section>
  );
}

export default function WorkspacesRoute() {
  const { workspaces, superAdmin, allWorkspaces, left, deleted } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state !== 'idle';

  return (
    <DashboardPage>
      <h1 style={styles.h1}>Workspaces</h1>
      {left ? (
        <p style={styles.ok} role="status" data-testid="workspace-left">
          You left the workspace /{left}. Its apps are no longer listed for you; to come back, a workspace admin has
          to invite you again.
        </p>
      ) : null}
      {deleted ? (
        <p style={styles.ok} role="status" data-testid="workspace-deleted">
          The workspace /{deleted} was deleted with its apps, their data and its upstreams. Its members lost access,
          its pending invites stopped working, and its apps&apos; addresses no longer answer.
        </p>
      ) : null}
      <p style={styles.hint}>
        Your workspaces and your role in each of them. The slug after the name tells apart workspaces with the same
        name; your agent picks a workspace by its slug and uses your personal one when you name none.
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

      {superAdmin && allWorkspaces ? <AllWorkspaces data={allWorkspaces} /> : null}

      <p style={styles.back}>
        <Link to="/me">Your account</Link>
      </p>
    </DashboardPage>
  );
}
