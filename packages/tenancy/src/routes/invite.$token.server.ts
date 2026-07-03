/**
 * GET/POST /invite/:token — accept flow (U4, PHY-54).
 * GET peeks WITHOUT consuming: anonymous → "sign in to accept" page (plain
 * /login link, no redirect chains — the user re-visits the invite link after
 * signing in); logged-in → accept button. POST consumes (single-use GETDEL),
 * upserts the membership keeping the HIGHER role, redirects to the workspace.
 * Expired/used/garbage tokens → generic 404 page via the route ErrorBoundary
 * ("This invite is not valid or has expired.") — no state enumeration.
 */
import {
  data,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import { getSessionUser, requireSessionUser } from '@drobek/auth';
import { acceptInvite, getInvite } from '../invites.server.js';
import { getWorkspaceById } from '../membership.server.js';

function invalidInvite(): never {
  throw data({ invalid: true }, { status: 404 });
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const token = String(params.token ?? '');

  const invite = await getInvite(token);
  if (!invite) invalidInvite();

  const workspace = await getWorkspaceById(invite.workspaceId);
  if (!workspace) invalidInvite();

  const user = await getSessionUser(request);
  return {
    anonymous: !user,
    workspaceName: workspace.name,
    role: invite.role,
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const user = await requireSessionUser(request);
  const token = String(params.token ?? '');

  const result = await acceptInvite({ token, userId: user.id });
  if (!result.ok) invalidInvite();

  return redirect(`/workspaces/${result.workspaceSlug}`);
}
