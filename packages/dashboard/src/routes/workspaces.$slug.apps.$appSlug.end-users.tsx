/**
 * /workspaces/:slug/apps/:appSlug/end-users — client half of the Users tab
 * (M2-03): the app's end users (the auth module), an address search, and for
 * editors+: change a role, block / unblock, and "sign everyone out" (behind
 * a confirm step). Viewers see the list only.
 */
import { Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { action, loader } from './workspaces.$slug.apps.$appSlug.end-users.server.js';
import { ModuleMissing, ui } from '../owner-ui.js';
import { AppPage } from '../app-header.js';
import { formatTimestamp } from '../view.js';

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  return [{ title: `Users — ${data?.appSlug ?? 'App'} — drobek` }];
}

const STATUS_TEXT = { active: 'active', disabled: 'blocked', not_allowed: 'not allowed' } as const;

export default function AppEndUsersRoute() {
  const d = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const busy = useNavigation().state !== 'idle';
  const base = `/workspaces/${d.workspace.slug}/apps/${d.appSlug}/end-users`;
  const qs = d.q ? `?q=${encodeURIComponent(d.q)}` : '';

  return (
    <AppPage header={d.header}>
      <h2 style={ui.title}>Users</h2>
      <p style={ui.hint}>
        People who signed in to <strong>{d.appSlug}</strong> (the auth module). A role or block applies to their next request;
        editors of this workspace are always admins.
      </p>

      {!d.enabled ? (
        <ModuleMissing does="signs end users in" />
      ) : (
        <>
          {actionData && 'error' in actionData ? (
            <div style={ui.error} role="alert" data-testid="users-error">
              {actionData.error}
            </div>
          ) : null}
          {d.error ? (
            <div style={ui.error} role="alert" data-testid="users-error">
              {d.error}
            </div>
          ) : null}
          {d.revoked ? (
            <div style={ui.notice} role="status" data-testid="users-revoked">
              Everyone was signed out. Users sign in again with a new code.
            </div>
          ) : null}

          <div style={ui.toolbar}>
            <Form method="get" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }} data-testid="users-search">
              <div style={ui.field}>
                <label style={ui.label} htmlFor="q">
                  E-mail contains
                </label>
                <input id="q" name="q" defaultValue={d.q} style={ui.input} data-testid="users-search-input" />
              </div>
              <button type="submit" style={ui.button}>
                Search
              </button>
            </Form>
            {d.canManage ? (
              d.confirmRevoke ? (
                <Form method="post" style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', alignItems: 'center' }} data-testid="revoke-form">
                  <input type="hidden" name="intent" value="revoke-all" />
                  <input type="hidden" name="q" value={d.q} />
                  <span style={{ fontSize: '0.85rem' }}>Sign every user of this app out, on every host?</span>
                  <button type="submit" style={ui.dangerButton} disabled={busy} data-testid="revoke-confirm">
                    Sign everyone out
                  </button>
                  <Link to={`${base}${qs}`} style={ui.link}>
                    Cancel
                  </Link>
                </Form>
              ) : (
                <Link to={`${base}?${new URLSearchParams({ ...(d.q ? { q: d.q } : {}), confirm: 'revoke' })}`} style={{ ...ui.dangerLink, marginLeft: 'auto', alignSelf: 'center' }} data-testid="revoke-link">
                  Sign everyone out…
                </Link>
              )
            ) : null}
          </div>

          <p style={ui.muted} data-testid="users-total">
            {d.total} {d.total === 1 ? 'user' : 'users'}
          </p>

          {d.users.length === 0 ? (
            <p style={ui.empty} data-testid="users-empty">
              No users yet — they appear after their first sign-in.
            </p>
          ) : (
            <div style={ui.tableWrap}>
              <table style={ui.table} data-testid="users-table">
                <thead>
                  <tr>
                    <th style={ui.th}>E-mail</th>
                    <th style={ui.th}>Role</th>
                    <th style={ui.th}>Status</th>
                    <th style={ui.th}>Last sign-in</th>
                    <th style={ui.th} />
                  </tr>
                </thead>
                <tbody>
                  {d.users.map((u) => (
                    <tr key={u.id} data-testid="user-row" data-user-id={u.id} data-email={u.email}>
                      <td style={ui.td}>
                        {u.email}
                        <div style={{ ...ui.muted, ...ui.mono }}>{u.id}</div>
                      </td>
                      <td style={ui.td} data-testid="user-role">
                        {u.role}
                        {u.roleSource === 'workspace' ? <div style={ui.muted}>workspace editor</div> : null}
                      </td>
                      <td style={ui.td} data-testid="user-status">
                        <span style={u.status === 'active' ? ui.okBadge : u.status === 'disabled' ? ui.badBadge : ui.badge}>{STATUS_TEXT[u.status]}</span>
                      </td>
                      <td style={{ ...ui.td, whiteSpace: 'nowrap' }}>{formatTimestamp(u.last_sign_in_at)}</td>
                      <td style={{ ...ui.td, whiteSpace: 'nowrap' }}>
                        {d.canManage ? (
                          <>
                            {u.roleSource !== 'workspace' ? (
                              <Form method="post" style={{ display: 'inline' }} data-testid="role-form">
                                <input type="hidden" name="intent" value="role" />
                                <input type="hidden" name="id" value={u.id} />
                                <input type="hidden" name="q" value={d.q} />
                                <input type="hidden" name="role" value={u.role === 'admin' ? 'user' : 'admin'} />
                                <button type="submit" style={ui.smallButton} disabled={busy} data-testid="role-toggle">
                                  {u.role === 'admin' ? 'Make user' : 'Make admin'}
                                </button>
                              </Form>
                            ) : null}{' '}
                            <Form method="post" style={{ display: 'inline' }} data-testid="block-form">
                              <input type="hidden" name="intent" value={u.status === 'disabled' ? 'enable' : 'disable'} />
                              <input type="hidden" name="id" value={u.id} />
                              <input type="hidden" name="q" value={d.q} />
                              <button type="submit" style={u.status === 'disabled' ? ui.smallButton : ui.dangerButton} disabled={busy} data-testid="block-toggle">
                                {u.status === 'disabled' ? 'Unblock' : 'Block'}
                              </button>
                            </Form>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={ui.pager}>
            {d.nextCursor ? (
              <>
                <Link to={`${base}${qs}`}>« First page</Link>
                <Link to={`${base}?${new URLSearchParams({ ...(d.q ? { q: d.q } : {}), cursor: d.nextCursor })}`} data-testid="users-next">
                  Next page »
                </Link>
              </>
            ) : null}
          </div>
        </>
      )}
    </AppPage>
  );
}
