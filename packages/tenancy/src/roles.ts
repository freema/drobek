/**
 * U4 (PHY-54) — workspace roles, RATIFIED: a fixed TS union, no custom-role
 * table, no user-editable roles. `super-admin` is deliberately NOT here — it
 * is a GLOBAL env flag (SUPERADMIN_EMAIL via @drobek/auth isSuperAdmin), not
 * a memberships row; it overrides every workspace check.
 */

export const WORKSPACE_ROLES = ['viewer', 'editor', 'workspace-admin'] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** viewer < editor < workspace-admin */
const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  editor: 1,
  'workspace-admin': 2,
};

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return (
    typeof value === 'string' &&
    (WORKSPACE_ROLES as readonly string[]).includes(value)
  );
}

export function roleRank(role: WorkspaceRole): number {
  return ROLE_RANK[role];
}

export function roleAtLeast(actual: WorkspaceRole, min: WorkspaceRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[min];
}

/** Higher of two roles — invite-accept keeps the user's better role. */
export function higherRole(a: WorkspaceRole, b: WorkspaceRole): WorkspaceRole {
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

export type WorkspaceAccessDecision =
  | { ok: true; effectiveRole: WorkspaceRole }
  | { ok: false; status: 403 | 404 };

/**
 * Pure access decision for requireWorkspaceRole (unit-tested without db):
 * - global super-admin → full access everywhere (effective workspace-admin);
 * - no membership → 404 (a non-member must not learn the workspace exists);
 * - membership below `minRole` → 403 (the "viewer mutation 403" acceptance);
 * - otherwise → allowed with the membership role.
 */
export function decideWorkspaceAccess(input: {
  membershipRole: WorkspaceRole | null;
  superAdmin: boolean;
  minRole: WorkspaceRole;
}): WorkspaceAccessDecision {
  if (input.superAdmin) {
    return { ok: true, effectiveRole: 'workspace-admin' };
  }
  if (input.membershipRole === null) {
    return { ok: false, status: 404 };
  }
  if (!roleAtLeast(input.membershipRole, input.minRole)) {
    return { ok: false, status: 403 };
  }
  return { ok: true, effectiveRole: input.membershipRole };
}
