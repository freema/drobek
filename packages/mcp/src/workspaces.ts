/**
 * The workspace tools (MCP parity with the dashboard's /workspaces page and
 * a workspace's Invite page): create_workspace and invite_member. Both call
 * the SAME @drobek/tenancy functions as the dashboard — the name and slug
 * rules, the team-only, role and address checks, the invite e-mail and the
 * `member.invite` audit row (here with the agent as the actor).
 *
 * create_workspace: any signed-in user, like the dashboard (write scope); the
 * caller becomes its workspace-admin. invite_member: workspace admins (and
 * super-admins) of a TEAM workspace. It e-mails a person outside the
 * conversation, so it needs `user_confirmed: true`. The invite link is a
 * credential (whoever opens it joins): it travels only in that e-mail and
 * never through MCP, so an invite whose e-mail cannot be sent is withdrawn
 * (`unavailable`); a link-only invite stays in the dashboard.
 */
import { dashboardOrigin } from '@drobek/apps';
import { scanForSecrets } from '@drobek/compile';
import {
  INVITE_TTL_SEC,
  createTeamWorkspace,
  getWorkspaceById,
  inviteMember,
  isWorkspaceRole,
  normalizeInviteEmail,
} from '@drobek/tenancy';
import { authorizeWorkspace } from './access.js';
import { ToolError, notFound } from './errors.js';
import type { CallContext } from './tools.js';

const workspaceUrl = (ctx: CallContext, slug: string) => `${dashboardOrigin(ctx.deps.env)}/workspaces/${encodeURIComponent(slug)}`;

export async function createWorkspaceTool(ctx: CallContext, args: { name: string; slug: string }) {
  const name = String(args.name ?? '');
  const slug = String(args.slug ?? '').trim().toLowerCase();
  if (scanForSecrets('name', name).length > 0) {
    throw new ToolError('invalid_params', '`name` looks like a credential — pick a plain name.');
  }
  const created = await createTeamWorkspace(ctx.principal.userId, name, slug);
  if (!created.ok) {
    if (created.reason === 'slug-taken') {
      throw new ToolError('slug_taken', `The workspace slug "${slug}" is taken on this server. Ask the user for another one and call again.`, { slug });
    }
    throw new ToolError('invalid_params', `${created.reason === 'invalid-name' ? 'name' : 'slug'}: ${created.message}`);
  }
  const ws = created.workspace;
  return {
    workspace: ws.slug,
    name: ws.name,
    kind: ws.kind,
    role: 'workspace-admin' as const,
    workspace_url: workspaceUrl(ctx, ws.slug),
    next: `create_app({ name, workspace: "${ws.slug}" }) builds an app in it; invite_member({ workspace: "${ws.slug}", email, role, user_confirmed }) invites the people the user names.`,
  };
}

export async function inviteMemberTool(
  ctx: CallContext,
  args: { workspace: string; email: string; role: string; user_confirmed?: boolean }
) {
  const access = await authorizeWorkspace(ctx.principal, String(args.workspace ?? ''), 'workspace-admin');
  const workspace = await getWorkspaceById(access.id);
  if (!workspace) throw notFound('workspace');
  if (workspace.kind !== 'team') {
    throw new ToolError(
      'invalid_params',
      `"${workspace.slug}" is a personal workspace: invites are only available for team workspaces. create_workspace makes one.`
    );
  }
  if (!isWorkspaceRole(args.role)) throw new ToolError('invalid_params', '`role` must be "viewer", "editor" or "workspace-admin".');
  const role = args.role;
  const email = normalizeInviteEmail(String(args.email ?? ''));
  if (!email) throw new ToolError('invalid_params', '`email` must be one e-mail address, e.g. ana@example.com.');
  const days = Math.round(INVITE_TTL_SEC / 86_400);
  if (args.user_confirmed !== true) {
    throw new ToolError(
      'user_confirmation_required',
      `Inviting e-mails ${email} a link that adds whoever opens it to workspace "${workspace.slug}" as ${role} (once, within ${days} days). Ask the user whether to invite ${email} as ${role}, and call again with user_confirmed: true only after they say yes.`,
      { workspace: workspace.slug, email, role }
    );
  }
  const out = await inviteMember({
    workspace,
    invitedByUserId: ctx.principal.userId,
    role,
    email,
    surface: 'mcp',
    requireDelivery: true,
    deps: ctx.deps.invites,
    env: ctx.deps.env,
  });
  if (!out.ok) {
    if (out.reason === 'email-failed') {
      throw new ToolError(
        'unavailable',
        `The invite e-mail to ${email} could not be sent, so no invite was created. A workspace admin can invite from the dashboard (${workspaceUrl(ctx, workspace.slug)}/invite), which also shows the link.`,
        { reason: 'email_failed' }
      );
    }
    throw new ToolError('invalid_params', out.message);
  }
  return {
    workspace: workspace.slug,
    email,
    role,
    invited: true as const,
    expires_in_days: days,
    note: `drobek e-mailed ${email} an invite to "${workspace.name}" as ${role}. The link works once, within ${days} days, and never passes through MCP. Accepting keeps an existing member's higher role.`,
  };
}
