/**
 * GET/POST /workspaces — server half. GET lists the session
 * user's workspaces (and lazily ensures the personal one — this is how
 * existing prod users get theirs on the next visit, no backfill migration);
 * super-admins additionally get the ALL-workspaces list; `?left=<slug>` (the
 * redirect after leaving a workspace) confirms the leave. POST creates a team
 * workspace — any logged-in user may (no role gate beyond the session).
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

const NAME_MAX = 80;

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
  // After leaving a workspace (the Members tab redirects here): confirm it, unless the user is still in it.
  const leftRaw = new URL(request.url).searchParams.get('left') ?? '';
  const left = /^[a-z0-9-]{1,64}$/.test(leftRaw) && !mine.some((w) => w.slug === leftRaw) ? leftRaw : null;

  return {
    email: user.email,
    left,
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
  const name = String(form.get('name') ?? '').trim();
  const slug = String(form.get('slug') ?? '')
    .trim()
    .toLowerCase();

  if (!name || name.length > NAME_MAX) {
    return data(
      { error: `Enter a team name (1–${NAME_MAX} characters).` },
      { status: 400 }
    );
  }

  const created = await createTeamWorkspace(user.id, name, slug);
  if (!created.ok) {
    return data({ error: created.message }, { status: 400 });
  }

  return redirect(`/workspaces/${created.workspace.slug}`);
}
