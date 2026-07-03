/**
 * GET/POST /workspaces/:slug/invite — server half (U4, PHY-54). The action is
 * the workspace-admin-only invite mutation: editors/viewers get 403 from the
 * role middleware (the "viewer mutation 403" acceptance), non-members 404,
 * anonymous a /login redirect. It ALWAYS returns the invite link; when an
 * email is provided it also sends the branded invite email (mailpit locally,
 * Hostinger SMTP in prod). GET renders the created-invite page (or a hint
 * when opened directly).
 */
import {
  data,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import { logger, maskEmail, normalizeAuthEmail, serializeError } from '@drobek/auth';
import { requireWorkspaceRole } from '../membership.server.js';
import { acceptInviteUrl, createInvite } from '../invites.server.js';
import { sendInviteEmail } from '../email/invite-email.server.js';
import { isWorkspaceRole } from '../roles.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'workspace-admin'
  );
  return {
    workspaceSlug: access.workspace.slug,
    workspaceName: access.workspace.name,
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'workspace-admin'
  );

  if (access.workspace.kind !== 'team') {
    return data(
      { error: 'Invites are only available for team workspaces.' },
      { status: 400 }
    );
  }

  const form = await request.formData();
  const roleRaw = String(form.get('role') ?? '');
  if (!isWorkspaceRole(roleRaw)) {
    return data({ error: 'Pick a valid role.' }, { status: 400 });
  }

  const emailRaw = String(form.get('email') ?? '').trim();
  let email: string | null = null;
  if (emailRaw) {
    email = normalizeAuthEmail(emailRaw);
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return data({ error: 'Enter a valid email address.' }, { status: 400 });
    }
  }

  const { token } = await createInvite({
    workspaceId: access.workspace.id,
    role: roleRaw,
    invitedByUserId: access.user.id,
    email,
  });
  const inviteUrl = acceptInviteUrl(token);

  let emailSent = false;
  if (email) {
    try {
      await sendInviteEmail({
        email,
        workspaceName: access.workspace.name,
        role: roleRaw,
        acceptUrl: inviteUrl,
      });
      emailSent = true;
    } catch (err) {
      // The link is still valid and shown — surface the send failure softly.
      logger.error('[tenancy] sendInviteEmail failed', {
        err: serializeError(err),
        email: maskEmail(email),
      });
    }
  }

  return {
    inviteUrl,
    role: roleRaw,
    email,
    emailSent,
  };
}
