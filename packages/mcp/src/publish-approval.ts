/**
 * set_publish_approval (NSO-366): a super-admin approves or revokes a
 * workspace's publishing (PUBLISH_APPROVAL=approval) — the same
 * @drobek/apps function as the dashboard's /admin/publishing, audited as the
 * agent. Registered only for a super-admin's grant (register.ts); the body
 * refuses anyone else too. Changing the state needs `user_confirmed: true`
 * (the super-admin's explicit yes), like the other public-affecting tools.
 */
import { publishApprovalMode, setPublishApproval } from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import { authorizeWorkspace } from './access.js';
import { ToolError } from './errors.js';
import type { CallContext } from './tools.js';

export async function setPublishApprovalTool(
  ctx: CallContext,
  args: { workspace: string; approved: boolean; user_confirmed?: boolean }
) {
  if (!ctx.principal.superAdmin) {
    throw new ToolError('forbidden', 'Only a super-admin of this server can approve or revoke a workspace\'s publishing.');
  }
  if (typeof args.approved !== 'boolean') throw new ToolError('invalid_params', '`approved` must be true or false.');
  const ws = await authorizeWorkspace(ctx.principal, String(args.workspace ?? ''), 'viewer');
  if (args.user_confirmed !== true) {
    throw new ToolError(
      'user_confirmation_required',
      args.approved
        ? `Approving lets every member of workspace "${ws.slug}" publish apps on this server. Ask the user whether "${ws.slug}" may publish, and call again with user_confirmed: true only after they say yes.`
        : `Revoking stops workspace "${ws.slug}" from publishing (its live apps keep serving). Ask the user whether to take publishing away from "${ws.slug}", and call again with user_confirmed: true only after they say yes.`,
      { workspace: ws.slug }
    );
  }
  const out = await setPublishApproval({
    workspaceId: ws.id,
    approved: args.approved,
    actor: { userId: ctx.principal.userId, kind: actorKindForSurface('mcp') },
  });
  const mode = publishApprovalMode(ctx.deps.env);
  return {
    workspace: ws.slug,
    approved: args.approved,
    approved_at: out.approvedAt ? out.approvedAt.toISOString() : null,
    changed: out.changed,
    mode,
    ...(mode === 'open'
      ? { note: 'This server runs PUBLISH_APPROVAL=open: every workspace may publish; the approval matters once the operator switches to approval.' }
      : {}),
  };
}
