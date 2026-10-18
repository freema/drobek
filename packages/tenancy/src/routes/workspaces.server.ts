/**
 * GET/POST /workspaces — server half. GET lists the session
 * user's workspaces (and lazily ensures the personal one — this is how
 * existing prod users get theirs on the next visit, no backfill migration);
 * super-admins additionally get the ALL-workspaces list — one page of it
 * (ADMIN_LIST_PAGE rows) for `?q=` (name, slug or a workspace admin's
 * e-mail), the chips `?kind=` personal | team, `?apps=` none | some |
 * published and `?publishing=` default | approved | blocked, `?sort=` newest |
 * oldest | name | apps | activity and `?page=`; a page past the last shows the
 * last one, and a failed query says so instead of failing the page;
 * `?left=<slug>` (the
 * redirect after leaving a workspace) confirms the leave and `?deleted=<slug>`
 * (after deleting one) the deletion. POST creates a team
 * workspace — any logged-in user may (no role gate beyond the session); the
 * name and slug checks are createTeamWorkspace's, shared with MCP.
 */
import {
  data,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import { isSuperAdmin, requireSessionUser } from '@drobek/auth';
import { dbErrorForLog } from '@drobek/db';
import { adminListPageSize, lastPage, parseAdminList, pickParam, whenView } from '../admin-list.js';
import {
  ADMIN_WORKSPACE_APPS,
  ADMIN_WORKSPACE_KINDS,
  ADMIN_WORKSPACE_PUBLISHING,
  ADMIN_WORKSPACE_SORTS,
  listAdminWorkspaces,
  type AdminWorkspacePage,
} from '../admin-workspaces.server.js';
import { listUserWorkspaces } from '../membership.server.js';
import { ensurePersonalWorkspace } from '../personal-workspace.server.js';
import { createTeamWorkspace } from '../team-workspace.server.js';

/** The super-admin's All workspaces section for the URL's list state. */
async function allWorkspaces(params: URLSearchParams, myRole: ReadonlyMap<string, string>) {
  const { q, sort, page } = parseAdminList(params, ADMIN_WORKSPACE_SORTS);
  const filters = {
    kind: pickParam(params, 'kind', ADMIN_WORKSPACE_KINDS),
    apps: pickParam(params, 'apps', ADMIN_WORKSPACE_APPS),
    publishing: pickParam(params, 'publishing', ADMIN_WORKSPACE_PUBLISHING),
  };
  const pageSize = adminListPageSize();
  const state = {
    q,
    sort: sort === ADMIN_WORKSPACE_SORTS[0] ? '' : sort,
    kind: filters.kind ?? '',
    apps: filters.apps ?? '',
    publishing: filters.publishing ?? '',
  };
  let result: AdminWorkspacePage;
  let shown = page;
  try {
    result = await listAdminWorkspaces({ q, sort, page, pageSize, ...filters });
    if (result.rows.length === 0 && result.matching > 0) {
      shown = lastPage(pageSize, result.matching);
      result = await listAdminWorkspaces({ q, sort, page: shown, pageSize, ...filters });
    }
  } catch (err) {
    console.error('[tenancy] all workspaces list failed', dbErrorForLog(err));
    return { error: true as const, params: state, page: 1, pageSize, total: 0, matching: 0, filtered: true, rows: [] };
  }
  const now = new Date();
  return {
    error: false as const,
    params: { ...state, page: shown > 1 ? String(shown) : '' },
    page: shown,
    pageSize,
    total: result.total,
    matching: result.matching,
    filtered: Boolean(q || filters.kind || filters.apps || filters.publishing),
    rows: result.rows.map((w) => ({
      slug: w.slug,
      name: w.name,
      kind: w.kind,
      adminEmail: w.adminEmail,
      myRole: myRole.get(w.id) ?? null,
      members: w.members,
      apps: w.apps,
      publishedApps: w.publishedApps,
      publishing: w.publishing,
      created: whenView(w.createdAt, now)!,
      lastActivity: whenView(w.lastActivityAt, now),
    })),
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireSessionUser(request);

  // Lazy ensure — personal workspace materializes on first visit.
  await ensurePersonalWorkspace(user.id, user.email);

  const mine = await listUserWorkspaces(user.id);
  const superAdmin = isSuperAdmin(user.email);
  const params = new URL(request.url).searchParams;
  const myRole = new Map(mine.map((w) => [w.id, w.role]));
  const all = superAdmin ? await allWorkspaces(params, myRole) : null;
  // After leaving a workspace (the Members tab redirects here): confirm it, unless the user is still in it.
  const gone = (raw: string | null) =>
    raw && /^[a-z0-9-]{1,64}$/.test(raw) && !mine.some((w) => w.slug === raw) ? raw : null;
  const left = gone(params.get('left'));
  const deleted = gone(params.get('deleted'));

  return {
    email: user.email,
    left,
    deleted,
    workspaces: mine.map(({ slug, name, kind, role }) => ({
      slug,
      name,
      kind,
      role,
    })),
    superAdmin,
    allWorkspaces: all,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireSessionUser(request);

  const form = await request.formData();
  const created = await createTeamWorkspace(
    user.id,
    String(form.get('name') ?? ''),
    String(form.get('slug') ?? '')
  );
  if (!created.ok) {
    return data({ error: created.message }, { status: 400 });
  }

  return redirect(`/workspaces/${created.workspace.slug}`);
}
