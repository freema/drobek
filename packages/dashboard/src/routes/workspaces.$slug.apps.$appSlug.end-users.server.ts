/**
 * GET/POST /workspaces/:slug/apps/:appSlug/end-users — server half of the
 * Users tab (M2-03): the people who signed in to the app, through the auth
 * module's `endUsers` authority (never its tables directly).
 *
 * GET (viewer+): one page (50, newest first) with an address search: email,
 * role (and why: the config or the workspace), status (active / blocked /
 * no longer allowed by the config), created, last sign-in.
 *
 * POST (editor+), by `intent`:
 *   - `role`       user ↔ admin. The role follows the auth config, so this
 *                  writes the config (adminEmails / allow.emails) under the
 *                  config lock — no confirmation, the owner is the one who
 *                  confirms — audited `end_users.role`. Core asks the auth
 *                  module about the user on EVERY module request, so the new
 *                  role applies to the very next one;
 *   - `disable` / `enable`  block / unblock (a blocked user is anonymous — and
 *                  their sessions end — on the next request) → end_users.disable|enable;
 *   - `revoke-all` sign EVERY user out (the app's session epoch), the same code
 *                  as `POST /api/apps/:id/end-user-sessions/revoke` →
 *                  end_users.sessions_revoke.
 * There is no per-user sign-out: sessions are not indexed per user (blocking
 * someone ends their sessions at once; unblocking lets them sign in again).
 */
import { data, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { AUDIT_ACTIONS } from '@drobek/audit';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { appHeaderFor } from '../app-page.server.js';
import { revokeAllEndUserSessions } from '../end-user-sessions.server.js';
import { auditOwner, endUsersOf, ownerApp, ownerError } from '../owner-http.server.js';

export const END_USERS_PAGE = 50;

function searchOf(url: URL): string {
  return (url.searchParams.get('q') ?? '').trim().slice(0, 254);
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const app = await ownerApp(access, String(params.appSlug ?? ''));
  const url = new URL(request.url);
  const q = searchOf(url);
  const base = {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    appSlug: app.slug,
    /** NSO-342: the app header + tabs on every app sub-page. */
    header: await appHeaderFor(access, app.slug),
    q,
    canManage: access.effectiveRole !== 'viewer',
    confirmRevoke: url.searchParams.get('confirm') === 'revoke',
    revoked: url.searchParams.get('revoked') === '1',
  };
  const endUsers = await endUsersOf(app);
  if (!endUsers) return { ...base, enabled: false as const, users: [], total: 0, nextCursor: null, error: null };
  try {
    const page = await endUsers.list({ search: q || undefined, limit: END_USERS_PAGE, cursor: url.searchParams.get('cursor') || null });
    return { ...base, enabled: true as const, users: page.users, total: page.total, nextCursor: page.next_cursor, error: null };
  } catch (err) {
    return { ...base, enabled: true as const, users: [], total: 0, nextCursor: null, error: ownerError(err).message };
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'editor');
  const app = await ownerApp(access, String(params.appSlug ?? ''));
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const q = String(form.get('q') ?? '').trim().slice(0, 254);
  const back = `/workspaces/${access.workspace.slug}/apps/${app.slug}/end-users`;
  const backWith = (extra: Record<string, string> = {}) => {
    const sp = new URLSearchParams();
    if (q) sp.set('q', q);
    for (const [k, v] of Object.entries(extra)) sp.set(k, v);
    const s = sp.toString();
    return redirect(`${back}${s ? `?${s}` : ''}`);
  };

  if (intent === 'revoke-all') {
    await revokeAllEndUserSessions(app, access.user.id);
    return backWith({ revoked: '1' });
  }

  const endUsers = await endUsersOf(app);
  if (!endUsers) throw data({ message: 'Not found' }, { status: 404 });
  const id = String(form.get('id') ?? '').trim();
  if (!id) return data({ error: 'Missing user id.' }, { status: 400 });

  try {
    if (intent === 'role') {
      const role = String(form.get('role') ?? '');
      if (role !== 'user' && role !== 'admin') return data({ error: 'Pick the role user or admin.' }, { status: 400 });
      await endUsers.setRole(id, role, access.user.id);
      return backWith();
    }
    if (intent === 'disable' || intent === 'enable') {
      const user = await endUsers.setDisabled(id, intent === 'disable');
      if (!user) throw data({ message: 'Not found' }, { status: 404 });
      await auditOwner(access, app, intent === 'disable' ? AUDIT_ACTIONS.endUserDisable : AUDIT_ACTIONS.endUserEnable, {
        module: endUsers.module,
        end_user: id,
      });
      return backWith();
    }
  } catch (err) {
    if (err instanceof Response || !(err instanceof Error)) throw err;
    const e = ownerError(err);
    if (e.status === 404) throw data({ message: 'Not found' }, { status: 404 });
    return data({ error: e.message }, { status: e.status });
  }
  return data({ error: 'Unsupported action.' }, { status: 400 });
}
