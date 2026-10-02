/**
 * delete_workspace — MCP parity with the dashboard's Delete workspace page. A
 * workspace admin deletes a TEAM workspace through the same @drobek/tenancy
 * deleteWorkspace: every app is soft-deleted (the modules' onAppDelete runs)
 * and purged at once, the memberships, pending invites, upstreams and module
 * opt-ins go with the workspace, audited `workspace.delete` with the agent as
 * the actor. It needs `user_confirmed: true`; without it the answer is
 * user_confirmation_required with what would go, and nothing changes. A
 * personal workspace goes only with its owner's account, which is deleted in
 * the dashboard only (like API keys and connections).
 */
import { getRedis } from '@drobek/core';
import { forgetEndUserSessions, type EndUserScanRedis } from '@drobek/modules';
import {
  DeletionError,
  assertWorkspaceDeletable,
  deleteWorkspace,
  workspaceDeletionSummary,
} from '@drobek/tenancy';
import { authorizeWorkspace } from './access.js';
import { ToolError } from './errors.js';
import type { CallContext } from './tools.js';

async function run<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DeletionError) throw new ToolError(err.code === 'personal_workspace' ? 'personal_workspace' : 'forbidden', err.message);
    throw err;
  }
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export async function deleteWorkspaceTool(ctx: CallContext, args: { workspace: string; user_confirmed?: boolean }) {
  const ws = await authorizeWorkspace(ctx.principal, String(args.workspace ?? ''), 'workspace-admin');
  const actor = { userId: ctx.principal.userId, kind: 'agent' as const, role: ws.role };
  await run(() => assertWorkspaceDeletable({ workspace: ws, actor }));
  if (args.user_confirmed !== true) {
    const s = await workspaceDeletionSummary(ws.id);
    throw new ToolError(
      'user_confirmation_required',
      `Deleting workspace "${ws.slug}" cannot be undone: its ${count(s.apps, 'app', 'apps')} (${s.published} published) are deleted for good with their versions, data, uploads and custom domains, and their addresses stop answering; ${count(s.members, 'member loses', 'members lose')} access at once; ${count(s.pendingInvites, 'pending invite stops', 'pending invites stop')} working; ${count(s.upstreams, 'upstream is', 'upstreams are')} removed with their keys. Ask the user whether to delete "${ws.slug}" with everything in it, and call again with user_confirmed: true only after they say yes.`,
      {
        workspace: ws.slug,
        apps: s.apps,
        published: s.published,
        members: s.members,
        pending_invites: s.pendingInvites,
        upstreams: s.upstreams,
      }
    );
  }
  const out = await run(() =>
    deleteWorkspace({
      workspace: ws,
      actor,
      hooks: {
        onAppDelete: (app) => ctx.modules.runHook('onAppDelete', app),
        afterPurge: async (appIds) => {
          await forgetEndUserSessions(getRedis() as unknown as EndUserScanRedis, appIds);
        },
      },
      notify: ctx.deps.notifyAppChanged,
      disk: ctx.deps.assets.disk,
    })
  );
  return {
    deleted: out.slug,
    apps: out.apps,
    members: out.members,
    note: `Workspace "${out.slug}" is gone: its apps answer not_found and leave list_apps. Activity entries stay with the server operator; it cannot be restored.`,
  };
}
