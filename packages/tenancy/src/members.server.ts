/**
 * Membership changes: a workspace admin changes a member's role or removes
 * them, and any member leaves. The dashboard's Members tab and the MCP tools
 * (set_member_role, remove_member) both call these, so they share the rules:
 *
 *  - a personal workspace's one membership (its owner) never changes
 *    (`personal_workspace`);
 *  - a workspace always keeps a workspace-admin (`last_workspace_admin`); the
 *    workspace row is locked for the transaction, so two admins demoting or
 *    removing each other at the same moment cannot both succeed;
 *  - changing a role or removing someone else needs the workspace-admin role
 *    (a super-admin acts as one); removing yourself (leaving) needs only the
 *    membership.
 *
 * Access is resolved on every request (the dashboard's role middleware, the
 * MCP per-call membership check), so a removed member is out on their next
 * request. Their app leases are released here as well: they can no longer
 * write, and the remaining editors' agents must not wait for the lease TTL.
 * The same happens when a member becomes a viewer.
 */
import { and, count, eq } from 'drizzle-orm';
import { releaseUserAppLeases, type TakeLeaseHeldBy } from '@drobek/apps';
import { AUDIT_ACTIONS, AUDIT_SUBJECT_TYPES, writeAudit, type AuditActorKind } from '@drobek/audit';
import { logger, normalizeAuthEmail } from '@drobek/auth';
import { dbErrorForLog, getDb, memberships, users, workspaces } from '@drobek/db';
import type { WorkspaceMember, WorkspaceSummary } from './membership.server.js';
import { isWorkspaceRole, type WorkspaceRole } from './roles.js';

export type MembershipErrorCode = 'not_found' | 'forbidden' | 'personal_workspace' | 'last_workspace_admin';

export class MembershipError extends Error {
  readonly code: MembershipErrorCode;

  constructor(code: MembershipErrorCode, message: string) {
    super(message);
    this.name = 'MembershipError';
    this.code = code;
  }
}

/** Who changes the membership — resolved server-side by the dashboard route or the MCP tool. */
export interface MembershipActor {
  userId: string;
  kind: AuditActorKind;
  /** The actor's effective role in the workspace (a super-admin acts as workspace-admin). */
  role: WorkspaceRole;
}

interface RemovalInput {
  workspace: Pick<WorkspaceSummary, 'id' | 'kind'>;
  /** The member whose membership changes. */
  userId: string;
  actor: MembershipActor;
}

interface ChangeInput extends RemovalInput {
  /** How a lease is taken (the MCP lease store, tests); Redis by default. */
  takeLease?: TakeLeaseHeldBy;
}

const PERSONAL =
  'A personal workspace always has exactly one member, its owner, so its membership cannot be changed or removed. Create a team workspace to work with others.';

const NOT_A_MEMBER = 'That person is not a member of this workspace.';

/** The member with this e-mail address in the workspace, or null. */
export async function findWorkspaceMember(workspaceId: string, email: string): Promise<WorkspaceMember | null> {
  const rows = await getDb()
    .select({ userId: users.id, email: users.email, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, workspaceId), eq(users.email, normalizeAuthEmail(email))))
    .limit(1);
  return rows[0] ?? null;
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];
type Executor = Tx | ReturnType<typeof getDb>;

/** The member's role; with `lock`, the workspace row is locked first (serializes membership changes). */
async function memberRole(db: Executor, workspaceId: string, userId: string, lock: boolean): Promise<WorkspaceRole> {
  if (lock) await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for('update');
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .limit(1);
  if (!row) throw new MembershipError('not_found', NOT_A_MEMBER);
  return row.role;
}

async function adminCount(db: Executor, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'workspace-admin')));
  return row?.n ?? 0;
}

/** removeMember's rules: throws its refusal, else returns the member's role. */
async function checkRemoval(db: Executor, input: RemovalInput, lock: boolean): Promise<WorkspaceRole> {
  const left = input.actor.userId === input.userId;
  if (!left && input.actor.role !== 'workspace-admin') {
    throw new MembershipError('forbidden', 'Removing a member needs the workspace-admin role.');
  }
  if (input.workspace.kind === 'personal') throw new MembershipError('personal_workspace', PERSONAL);
  const current = await memberRole(db, input.workspace.id, input.userId, lock);
  if (current === 'workspace-admin' && (await adminCount(db, input.workspace.id)) <= 1) {
    throw new MembershipError(
      'last_workspace_admin',
      left
        ? 'You are the only workspace-admin, and a workspace always needs one. Make another member a workspace-admin first, then leave.'
        : 'This is the only workspace-admin, and a workspace always needs one. Make another member a workspace-admin first.'
    );
  }
  return current;
}

/** Release the member's leases; a failure is logged, never undoes the committed change (a lease expires on its own). */
async function releaseLeases(input: ChangeInput): Promise<string[]> {
  try {
    return await releaseUserAppLeases({
      workspaceId: input.workspace.id,
      holderUserId: input.userId,
      actor: { userId: input.actor.userId, kind: input.actor.kind },
      take: input.takeLease,
    });
  } catch (err) {
    logger.error('[tenancy] releasing the app leases of a member failed', { err: dbErrorForLog(err) });
    return [];
  }
}

export interface RoleChangeResult {
  changed: boolean;
  from: WorkspaceRole;
  to: WorkspaceRole;
  /** Slugs of the apps whose lease the member held and lost (they became a viewer). */
  releasedLocks: string[];
}

/** A workspace admin sets a member's role; audited `member.role_change` when it changes. */
export async function changeMemberRole(input: ChangeInput & { role: WorkspaceRole }): Promise<RoleChangeResult> {
  if (!isWorkspaceRole(input.role)) throw new Error('invalid workspace role');
  if (input.actor.role !== 'workspace-admin') {
    throw new MembershipError('forbidden', 'Changing a member’s role needs the workspace-admin role.');
  }
  if (input.workspace.kind === 'personal') throw new MembershipError('personal_workspace', PERSONAL);

  const from = await getDb().transaction(async (tx) => {
    const current = await memberRole(tx, input.workspace.id, input.userId, true);
    if (current === input.role) return current;
    if (current === 'workspace-admin' && (await adminCount(tx, input.workspace.id)) <= 1) {
      throw new MembershipError(
        'last_workspace_admin',
        'This is the only workspace-admin, and a workspace always needs one. Make another member a workspace-admin first.'
      );
    }
    await tx
      .update(memberships)
      .set({ role: input.role })
      .where(and(eq(memberships.workspaceId, input.workspace.id), eq(memberships.userId, input.userId)));
    await writeAudit(
      {
        workspaceId: input.workspace.id,
        actorUserId: input.actor.userId,
        actorKind: input.actor.kind,
        action: AUDIT_ACTIONS.memberRoleChange,
        subjectType: AUDIT_SUBJECT_TYPES.member,
        target: input.userId,
        meta: { from: current, to: input.role },
      },
      tx
    );
    return current;
  });

  const changed = from !== input.role;
  const releasedLocks = changed && input.role === 'viewer' ? await releaseLeases(input) : [];
  return { changed, from, to: input.role, releasedLocks };
}

export interface RemoveResult {
  /** The role the member had. */
  role: WorkspaceRole;
  /** True when the member removed themselves (left). */
  left: boolean;
  /** Slugs of the apps whose lease the member held and lost. */
  releasedLocks: string[];
}

/**
 * Remove a member: a workspace admin removes anyone, a member removes
 * themselves (leaves). Audited `member.remove` / `member.leave` with the role
 * they had. Their apps, versions and audit rows stay with the workspace.
 */
export async function removeMember(input: ChangeInput): Promise<RemoveResult> {
  const left = input.actor.userId === input.userId;
  const role = await getDb().transaction(async (tx) => {
    const current = await checkRemoval(tx, input, true);
    await tx
      .delete(memberships)
      .where(and(eq(memberships.workspaceId, input.workspace.id), eq(memberships.userId, input.userId)));
    await writeAudit(
      {
        workspaceId: input.workspace.id,
        actorUserId: input.actor.userId,
        actorKind: input.actor.kind,
        action: left ? AUDIT_ACTIONS.memberLeave : AUDIT_ACTIONS.memberRemove,
        subjectType: AUDIT_SUBJECT_TYPES.member,
        target: input.userId,
        meta: { role: current },
      },
      tx
    );
    return current;
  });

  return { role, left, releasedLocks: await releaseLeases(input) };
}

/**
 * Throws the refusal removeMember would answer, changing nothing — so a
 * caller asks the user to confirm only a removal that can happen
 * (removeMember checks again inside its transaction).
 */
export async function assertMemberRemovable(input: RemovalInput): Promise<void> {
  await checkRemoval(getDb(), input, false);
}
