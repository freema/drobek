/**
 * Per-call authorization for user-bound MCP grants (M0-04, NSO-282).
 *
 * A token / API key names a USER, not a workspace. Every tool that touches a
 * workspace resolves the caller's membership in it HERE, on each call:
 *   - member → their role (viewer / editor / workspace-admin);
 *   - global super-admin → effective workspace-admin everywhere;
 *   - unknown workspace OR not a member → null, which the tools answer with
 *     the SAME `not_found` as a missing app (anti-enumeration: a caller cannot
 *     tell "exists but not yours" from "does not exist").
 * Role floors (e.g. editor+ to define a collection) stay with each tool.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { apps, getDb, memberships, workspaces } from '@drobek/db';
import {
  listUserWorkspaces,
  resolveWorkspaceAccess,
  type WorkspaceRole,
} from '@drobek/tenancy';
import type { AuthContext } from './oauth-resource.js';

type Principal = Pick<AuthContext, 'userId' | 'superAdmin'>;

export interface CallWorkspace {
  workspaceId: string;
  workspaceSlug: string;
  role: WorkspaceRole;
}

/** The caller's access to `workspaceSlug`, or null (unknown or not a member). */
export async function resolveCallWorkspace(
  principal: Principal,
  workspaceSlug: string
): Promise<CallWorkspace | null> {
  const access = await resolveWorkspaceAccess({
    userId: principal.userId,
    superAdmin: principal.superAdmin,
    workspaceSlug,
  });
  if (!access) return null;
  return {
    workspaceId: access.workspace.id,
    workspaceSlug: access.workspace.slug,
    role: access.effectiveRole,
  };
}

export interface WhoamiWorkspace {
  slug: string;
  name: string;
  kind: 'personal' | 'team';
  role: WorkspaceRole;
}

/** Every workspace the user is a member of, with their role (oldest first). */
export async function listPrincipalWorkspaces(
  principal: Principal
): Promise<WhoamiWorkspace[]> {
  const rows = await listUserWorkspaces(principal.userId);
  return rows.map((w) => ({ slug: w.slug, name: w.name, kind: w.kind, role: w.role }));
}

export interface ListedApp {
  workspace: string;
  slug: string;
  status: string;
  visibility: string;
  createdAt: Date;
}

const appColumns = {
  workspace: workspaces.slug,
  slug: apps.slug,
  status: apps.status,
  visibility: apps.visibility,
  createdAt: apps.createdAt,
};

/**
 * list_apps: without a filter, the live apps across EVERY workspace the user
 * is a member of (a super-admin sees their own memberships here, not the whole
 * instance); with `workspaceSlug`, only that workspace — null when the caller
 * cannot reach it (→ not_found).
 */
export async function listAppsForPrincipal(
  principal: Principal,
  workspaceSlug?: string
): Promise<ListedApp[] | null> {
  const db = getDb();
  if (workspaceSlug !== undefined) {
    const ws = await resolveCallWorkspace(principal, workspaceSlug);
    if (!ws) return null;
    return db
      .select(appColumns)
      .from(apps)
      .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
      .where(and(eq(apps.workspaceId, ws.workspaceId), isNull(apps.deletedAt)))
      .orderBy(asc(apps.createdAt));
  }
  return db
    .select(appColumns)
    .from(apps)
    .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
    .innerJoin(
      memberships,
      and(
        eq(memberships.workspaceId, apps.workspaceId),
        eq(memberships.userId, principal.userId)
      )
    )
    .where(isNull(apps.deletedAt))
    .orderBy(asc(workspaces.createdAt), asc(apps.createdAt));
}
