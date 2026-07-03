/**
 * Membership lookups + the role middleware (U4, PHY-54). The access DECISION
 * is pure (decideWorkspaceAccess in roles.ts); this module is the thin
 * session/db adapter that loaders and actions call.
 */
import { and, eq } from 'drizzle-orm';
import { data } from 'react-router';
import {
  isSuperAdmin,
  requireSessionUser,
  type SessionUser,
} from '@drobek/auth';
import { getDb, memberships, users, workspaces } from '@drobek/db';
import {
  decideWorkspaceAccess,
  type WorkspaceRole,
} from './roles.js';

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  kind: 'personal' | 'team';
}

export interface WorkspaceAccess {
  user: SessionUser;
  workspace: WorkspaceSummary;
  /** The user's own membership role — null for a membership-less super-admin. */
  membershipRole: WorkspaceRole | null;
  superAdmin: boolean;
  /** What UI/actions should gate on; super-admin ⇒ 'workspace-admin'. */
  effectiveRole: WorkspaceRole;
}

export async function getMembership(
  userId: string,
  workspaceId: string
): Promise<{ role: WorkspaceRole } | null> {
  const rows = await getDb()
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.workspaceId, workspaceId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getWorkspaceBySlug(
  slug: string
): Promise<WorkspaceSummary | null> {
  const rows = await getDb()
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      kind: workspaces.kind,
    })
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);
  return rows[0] ?? null;
}

export async function getWorkspaceById(
  id: string
): Promise<WorkspaceSummary | null> {
  const rows = await getDb()
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      kind: workspaces.kind,
    })
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Role middleware for loaders/actions: session required (redirects /login),
 * workspace resolved by slug, then decideWorkspaceAccess — 404 for unknown
 * slugs AND non-members (anti-enumeration), 403 for members below `minRole`,
 * global super-admin override everywhere.
 */
export async function requireWorkspaceRole(
  request: Request,
  workspaceSlug: string,
  minRole: WorkspaceRole
): Promise<WorkspaceAccess> {
  const user = await requireSessionUser(request);
  const superAdmin = isSuperAdmin(user.email);

  const workspace = await getWorkspaceBySlug(workspaceSlug);
  if (!workspace) {
    throw data({ message: 'Not found' }, { status: 404 });
  }

  const membership = await getMembership(user.id, workspace.id);
  const decision = decideWorkspaceAccess({
    membershipRole: membership?.role ?? null,
    superAdmin,
    minRole,
  });
  if (!decision.ok) {
    throw data(
      {
        message:
          decision.status === 403
            ? 'You do not have permission to do that in this workspace.'
            : 'Not found',
      },
      { status: decision.status }
    );
  }

  return {
    user,
    workspace,
    membershipRole: membership?.role ?? null,
    superAdmin,
    effectiveRole: decision.effectiveRole,
  };
}

export interface WorkspaceMember {
  email: string;
  role: WorkspaceRole;
}

export async function listWorkspaceMembers(
  workspaceId: string
): Promise<WorkspaceMember[]> {
  return getDb()
    .select({ email: users.email, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.workspaceId, workspaceId))
    .orderBy(memberships.createdAt);
}

export interface UserWorkspace extends WorkspaceSummary {
  role: WorkspaceRole;
}

export async function listUserWorkspaces(
  userId: string
): Promise<UserWorkspace[]> {
  return getDb()
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      kind: workspaces.kind,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, userId))
    .orderBy(workspaces.createdAt);
}

export async function listAllWorkspaces(): Promise<WorkspaceSummary[]> {
  return getDb()
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      kind: workspaces.kind,
    })
    .from(workspaces)
    .orderBy(workspaces.createdAt);
}
