/**
 * The workspace member tools (MCP parity with the dashboard's Members tab):
 * list_members, set_member_role, remove_member. The bodies call the SAME
 * @drobek/tenancy operations as the dashboard — the rules (never the last
 * workspace-admin, never a personal workspace) and the audit rows
 * `member.role_change` / `member.remove` / `member.leave`, here as the agent.
 *
 * list_members: any member. set_member_role and removing someone else:
 * workspace admins (and super-admins). remove_member with the caller's own
 * e-mail leaves the workspace, at any role. Removing needs `user_confirmed:
 * true` — the member loses access at once. The leases a removed member (or a
 * new viewer) held on the workspace's apps are released through the tools'
 * lease store.
 */
import { dashboardOrigin } from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import {
  MembershipError,
  assertMemberRemovable,
  changeMemberRole,
  findWorkspaceMember,
  isWorkspaceRole,
  listWorkspaceMembers,
  removeMember,
  type MembershipActor,
} from '@drobek/tenancy';
import { authorizeWorkspace } from './access.js';
import { ToolError } from './errors.js';
import type { CallContext } from './tools.js';

function membersPage(ctx: CallContext, slug: string): string {
  return `${dashboardOrigin(ctx.deps.env)}/workspaces/${encodeURIComponent(slug)}`;
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MembershipError) throw new ToolError(err.code, err.message);
    throw err;
  }
}

function emailArg(raw: unknown): string {
  const email = typeof raw === 'string' ? raw.trim() : '';
  if (!email) throw new ToolError('invalid_params', '`email` must be the e-mail address of a member (list_members lists them).');
  return email;
}

async function memberOf(ws: { id: string; slug: string }, email: string) {
  const member = await findWorkspaceMember(ws.id, email);
  if (!member) throw new ToolError('not_found', `No member with the e-mail ${email} in workspace "${ws.slug}" — list_members lists them.`);
  return member;
}

function actorOf(ctx: CallContext, role: MembershipActor['role']): MembershipActor {
  return { userId: ctx.principal.userId, kind: actorKindForSurface('mcp'), role };
}

const takeLease = (ctx: CallContext) => (appId: string, holderUserId: string) => ctx.deps.leases.takeHeldBy(appId, holderUserId);

// ── list_members ─────────────────────────────────────────────────────────────

export async function listMembersTool(ctx: CallContext, args: { workspace: string }) {
  const ws = await authorizeWorkspace(ctx.principal, String(args.workspace ?? ''), 'viewer');
  const members = await listWorkspaceMembers(ws.id);
  return {
    workspace: ws.slug,
    kind: ws.kind,
    role: ws.role,
    members: members.map((m) => ({ email: m.email, role: m.role, you: m.userId === ctx.principal.userId })),
    can_manage: ws.role === 'workspace-admin' && ws.kind === 'team',
    members_url: membersPage(ctx, ws.slug),
  };
}

// ── set_member_role ──────────────────────────────────────────────────────────

export async function setMemberRoleTool(ctx: CallContext, args: { workspace: string; email: string; role: string }) {
  const ws = await authorizeWorkspace(ctx.principal, String(args.workspace ?? ''), 'workspace-admin');
  if (!isWorkspaceRole(args.role)) {
    throw new ToolError('invalid_params', '`role` must be "viewer", "editor" or "workspace-admin".');
  }
  const role = args.role;
  const email = emailArg(args.email);
  const member = await memberOf(ws, email);
  const out = await run(() =>
    changeMemberRole({ workspace: ws, userId: member.userId, role, actor: actorOf(ctx, ws.role), takeLease: takeLease(ctx) })
  );
  return {
    workspace: ws.slug,
    email: member.email,
    from: out.from,
    to: out.to,
    changed: out.changed,
    released_locks: out.releasedLocks,
  };
}

// ── remove_member ────────────────────────────────────────────────────────────

export async function removeMemberTool(ctx: CallContext, args: { workspace: string; email: string; user_confirmed?: boolean }) {
  const ws = await authorizeWorkspace(ctx.principal, String(args.workspace ?? ''), 'viewer');
  const email = emailArg(args.email);
  const member = await memberOf(ws, email);
  const leaving = member.userId === ctx.principal.userId;
  if (!leaving && ws.role !== 'workspace-admin') {
    throw new ToolError(
      'forbidden',
      `Removing another member needs the workspace-admin role in the workspace; yours is ${ws.role}. To leave the workspace yourself, pass your own e-mail.`
    );
  }
  const input = { workspace: ws, userId: member.userId, actor: actorOf(ctx, ws.role) };
  await run(() => assertMemberRemovable(input));
  if (args.user_confirmed !== true) {
    throw new ToolError(
      'user_confirmation_required',
      leaving
        ? `Leaving workspace "${ws.slug}" ends your own access at once: its apps leave list_apps and every call on them answers not_found. The apps and versions stay in the workspace; only a workspace admin can invite you back. Ask the user whether to leave "${ws.slug}", and call again with user_confirmed: true only after they say yes.`
        : `Removing ${member.email} (${member.role}) from workspace "${ws.slug}" ends their access at once: the dashboard and their agents answer not_found, and their edit locks on its apps are released. The apps and versions they made stay. Ask the user whether to remove ${member.email}, and call again with user_confirmed: true only after they say yes.`,
      { workspace: ws.slug, email: member.email, role: member.role, leaving }
    );
  }
  const out = await run(() => removeMember({ ...input, takeLease: takeLease(ctx) }));
  return {
    workspace: ws.slug,
    removed: member.email,
    role: out.role,
    left: out.left,
    released_locks: out.releasedLocks,
    note: out.left
      ? `You are no longer a member of "${ws.slug}": its apps are gone from list_apps. Only a workspace admin can invite you back.`
      : `${member.email} can come back only through a new invite (the dashboard's Members tab).`,
  };
}
