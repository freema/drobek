/**
 * GET/POST /workspaces/:slug/invite — server half. The action is
 * the workspace-admin-only invite mutation: editors/viewers get 403 from the
 * role middleware, non-members 404,
 * anonymous a /login redirect. It ALWAYS returns the invite link; when an
 * email is provided it also sends the branded invite email (mailpit locally,
 * the operator's transport in prod). The checks, the e-mail and the audit row
 * are inviteMember's, shared with the MCP tool invite_member. GET renders the
 * created-invite page (or a hint when opened directly).
 */
import {
  data,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import { requireWorkspaceRole } from '../membership.server.js';
import { inviteMember } from '../invites.server.js';
import { workspaceNav } from '../workspace-nav.js';

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'workspace-admin'
  );
  return {
    workspaceSlug: access.workspace.slug,
    workspaceName: access.workspace.name,
    /** The shared workspace chrome. */
    nav: await workspaceNav(access),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'workspace-admin'
  );

  const form = await request.formData();
  const invited = await inviteMember({
    workspace: access.workspace,
    invitedByUserId: access.user.id,
    role: String(form.get('role') ?? ''),
    email: String(form.get('email') ?? ''),
    surface: 'web',
  });
  if (!invited.ok) {
    return data({ error: invited.message }, { status: 400 });
  }

  return {
    inviteUrl: invited.inviteUrl,
    role: invited.role,
    email: invited.email,
    emailSent: invited.emailSent,
  };
}
