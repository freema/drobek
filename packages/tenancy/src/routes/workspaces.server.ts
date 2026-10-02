/**
 * GET/POST /workspaces — server half. GET lists the session
 * user's workspaces (and lazily ensures the personal one — this is how
 * existing prod users get theirs on the next visit, no backfill migration);
 * super-admins additionally get the ALL-workspaces list. POST creates a team
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
import {
  listAllWorkspaces,
  listUserWorkspaces,
  personalWorkspaceOwners,
  workspaceAppCounts,
} from '../membership.server.js';
import { ensurePersonalWorkspace } from '../personal-workspace.server.js';
import { createTeamWorkspace } from '../team-workspace.server.js';

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireSessionUser(request);

  // Lazy ensure — personal workspace materializes on first visit.
  await ensurePersonalWorkspace(user.id, user.email);

  const mine = await listUserWorkspaces(user.id);
  const superAdmin = isSuperAdmin(user.email);
  const [all, owners, appCounts] = superAdmin
    ? await Promise.all([listAllWorkspaces(), personalWorkspaceOwners(), workspaceAppCounts()])
    : [null, null, null];
  const myRole = new Map(mine.map((w) => [w.id, w.role]));

  return {
    email: user.email,
    workspaces: mine.map(({ slug, name, kind, role }) => ({
      slug,
      name,
      kind,
      role,
    })),
    superAdmin,
    allWorkspaces: all
      ? all.map(({ id, slug, name, kind }) => ({
          slug,
          name,
          kind,
          ownerEmail: owners?.get(id) ?? null,
          myRole: myRole.get(id) ?? null,
          apps: appCounts?.get(id)?.apps ?? 0,
          publishedApps: appCounts?.get(id)?.published ?? 0,
        }))
      : null,
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
