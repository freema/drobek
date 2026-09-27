/**
 * set_workspace_publishing (NSO-366): a super-admin sets a workspace's
 * publishing — `allowed`, `blocked` (refused in every PUBLISH_APPROVAL mode)
 * or `default` (the server mode decides) — the same @drobek/apps function as
 * the dashboard's /admin/publishing, audited as the agent. Registered only
 * for a super-admin's grant (register.ts); the body refuses anyone else too.
 * Changing the state needs `user_confirmed: true` (the super-admin's
 * explicit yes), like the other public-affecting tools.
 */
import { isWorkspacePublishing, publishApprovalMode, publishPermission, setWorkspacePublishing, type WorkspacePublishing } from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import { authorizeWorkspace } from './access.js';
import { ToolError } from './errors.js';
import type { CallContext } from './tools.js';

function confirmation(slug: string, to: WorkspacePublishing): string {
  if (to === 'blocked') {
    return `Blocking stops every member of workspace "${slug}" from publishing, in every mode of this server (its live apps keep serving; the takedown is separate), and e-mails its editors and admins. Ask the user whether to turn publishing off for "${slug}", and call again with user_confirmed: true only after they say yes.`;
  }
  if (to === 'allowed') {
    return `Allowing lets every member of workspace "${slug}" publish apps on this server, also while the server requires approval. Ask the user whether "${slug}" may publish, and call again with user_confirmed: true only after they say yes.`;
  }
  return `Default lets the server's mode decide whether workspace "${slug}" may publish (it clears an approval or a block). Ask the user whether to reset "${slug}" to the default, and call again with user_confirmed: true only after they say yes.`;
}

export async function setWorkspacePublishingTool(
  ctx: CallContext,
  args: { workspace: string; publishing: WorkspacePublishing; user_confirmed?: boolean }
) {
  if (!ctx.principal.superAdmin) {
    throw new ToolError('forbidden', 'Only a super-admin of this server can set a workspace\'s publishing.');
  }
  if (!isWorkspacePublishing(args.publishing)) {
    throw new ToolError('invalid_params', '`publishing` must be "default", "allowed" or "blocked".');
  }
  const ws = await authorizeWorkspace(ctx.principal, String(args.workspace ?? ''), 'viewer');
  if (args.user_confirmed !== true) {
    throw new ToolError('user_confirmation_required', confirmation(ws.slug, args.publishing), { workspace: ws.slug, publishing: args.publishing });
  }
  const out = await setWorkspacePublishing({
    workspaceId: ws.id,
    publishing: args.publishing,
    actor: { userId: ctx.principal.userId, kind: actorKindForSurface('mcp') },
    env: ctx.deps.env,
  });
  const now = await publishPermission(ws.id, { env: ctx.deps.env });
  return {
    workspace: ws.slug,
    publishing: out.publishing,
    mode: publishApprovalMode(ctx.deps.env),
    can_publish_now: now.allowed,
    changed: out.changed,
  };
}
