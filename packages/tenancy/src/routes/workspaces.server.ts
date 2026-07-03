/**
 * GET/POST /workspaces — server half (U4, PHY-54). GET lists the session
 * user's workspaces (and lazily ensures the personal one — this is how
 * existing prod users get theirs on the next visit, no backfill migration);
 * super-admins additionally get the ALL-workspaces list. POST creates a team
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
  const all = superAdmin ? await listAllWorkspaces() : null;

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
      ? all.map(({ slug, name, kind }) => ({ slug, name, kind }))
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
