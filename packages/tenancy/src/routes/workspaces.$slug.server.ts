/**
 * GET/POST /workspaces/:slug — server half of the Members tab. Requires
 * viewer+ via the role middleware (super-admin override included).
 *
 * GET: the workspace, its members (e-mail + role), whether the invite form
 * and the member controls may be shown (workspace-admin or super-admin, TEAM
 * workspaces only), the pending invites (same gate) and whether the viewer
 * may leave (a member of a team workspace).
 *
 * POST `intent`: `role` (userId, role) and `remove` (userId) for a workspace
 * admin, `leave` for any member, `revoke-invite` (inviteId) for a workspace
 * admin. The rules (never the last admin, never a personal workspace) live in
 * members.server.ts, shared with the MCP tools; every change is audited.
 */
import {
  data,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import { actorKindForSurface } from '@drobek/audit';
import { listPendingInvites, revokeInvite } from '../invites.server.js';
import {
  listWorkspaceMembers,
  requireWorkspaceRole,
  userEmails,
  type WorkspaceAccess,
} from '../membership.server.js';
import {
  MembershipError,
  changeMemberRole,
  removeMember,
  type MembershipErrorCode,
} from '../members.server.js';
import { isWorkspaceRole, type WorkspaceRole } from '../roles.js';
import { workspaceNav } from '../workspace-nav.js';

function canManageMembers(access: WorkspaceAccess): boolean {
  return access.effectiveRole === 'workspace-admin' && access.workspace.kind === 'team';
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'viewer'
  );

  const members = await listWorkspaceMembers(access.workspace.id);
  const manage = canManageMembers(access);
  const pending = manage ? await listPendingInvites(access.workspace.id) : [];
  const inviters = await userEmails(pending.map((i) => i.invitedBy));

  return {
    workspace: {
      slug: access.workspace.slug,
      name: access.workspace.name,
      kind: access.workspace.kind,
    },
    /** The shared workspace chrome (breadcrumb, badges, tabs). */
    nav: await workspaceNav(access),
    members: members.map((m) => ({ ...m, you: m.userId === access.user.id })),
    adminCount: members.filter((m) => m.role === 'workspace-admin').length,
    role: access.effectiveRole,
    superAdmin: access.superAdmin,
    canInvite: manage,
    canManageMembers: manage,
    // Leaving is a member's own step; a super-admin without a membership has nothing to leave.
    canLeave: access.membershipRole !== null && access.workspace.kind === 'team',
    invites: pending.map((i) => ({
      id: i.id,
      role: i.role,
      email: i.email,
      invitedBy: inviters.get(i.invitedBy) ?? null,
      expiresAt: i.expiresAt,
    })),
    // The Activity (audit) view is admin/super-admin only. A super-admin's
    // effective workspace role is already 'workspace-admin', so this covers both.
    canViewActivity: access.effectiveRole === 'workspace-admin',
    // The BFF proxy Upstreams config is admin/super-admin only (same gate).
    canManageUpstreams: access.effectiveRole === 'workspace-admin',
  };
}

const ERROR_STATUS: Record<MembershipErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  personal_workspace: 400,
  last_workspace_admin: 409,
};

const ROLE_EFFECT: Record<WorkspaceRole, string> = {
  viewer: 'They can open the workspace’s apps but no longer change them.',
  editor: 'They can build and change the workspace’s apps.',
  'workspace-admin': 'They can also manage members, invites and the workspace’s settings.',
};

function locksNote(slugs: string[]): string {
  return slugs.length > 0 ? ` Their agent’s edit lock on ${slugs.join(', ')} was released.` : '';
}

const ADMIN_ONLY = 'Managing members and invites needs the workspace-admin role in a team workspace.';

export async function action({ request, params }: ActionFunctionArgs) {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'viewer'
  );
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const workspace = access.workspace;
  const actor = {
    userId: access.user.id,
    kind: actorKindForSurface('web'),
    role: access.effectiveRole,
  };

  try {
    if (intent === 'leave') {
      await removeMember({ workspace, userId: access.user.id, actor });
      return redirect(`/workspaces?left=${encodeURIComponent(workspace.slug)}`);
    }

    if (intent === 'role' || intent === 'remove') {
      const userId = String(form.get('userId') ?? '');
      const target = (await listWorkspaceMembers(workspace.id)).find((m) => m.userId === userId);
      if (intent === 'role') {
        const role = String(form.get('role') ?? '');
        if (!isWorkspaceRole(role)) {
          return data({ error: 'Pick a valid role.' }, { status: 400 });
        }
        const out = await changeMemberRole({ workspace, userId, role, actor });
        const who = target?.email ?? 'The member';
        return {
          notice: out.changed
            ? `${who} is now ${out.to}. ${ROLE_EFFECT[out.to]}${locksNote(out.releasedLocks)}`
            : `${who} already has the ${out.to} role; nothing changed.`,
        };
      }
      const out = await removeMember({ workspace, userId, actor });
      if (out.left) {
        return redirect(`/workspaces?left=${encodeURIComponent(workspace.slug)}`);
      }
      return {
        notice: `${target?.email ?? 'The member'} was removed from the workspace and lost access at once: the dashboard and their agents now answer “not found”. The apps and versions they made stay here; to give access back, invite them again.${locksNote(out.releasedLocks)}`,
      };
    }

    if (intent === 'revoke-invite') {
      if (!canManageMembers(access)) {
        return data({ error: ADMIN_ONLY }, { status: 403 });
      }
      const revoked = await revokeInvite({
        workspaceId: workspace.id,
        inviteId: String(form.get('inviteId') ?? ''),
        actor: { userId: actor.userId, kind: actor.kind },
      });
      if (!revoked) {
        return data(
          { error: 'That invite is no longer pending: it was accepted, revoked or has expired. The list below is current.' },
          { status: 404 }
        );
      }
      return {
        notice: `The invite${revoked.email ? ` for ${revoked.email}` : ''} was revoked; its link no longer works. Create a new invite if they should still join.`,
      };
    }

    return data({ error: 'Unsupported action.' }, { status: 400 });
  } catch (err) {
    if (err instanceof MembershipError) {
      return data({ error: err.message }, { status: ERROR_STATUS[err.code] });
    }
    throw err;
  }
}
