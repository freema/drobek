/**
 * Per-call authorization (NSO-282 model, M0-05 tools): a grant names a USER;
 * every call resolves that user's role in the TARGET app's workspace:
 *   - unknown app, soft-deleted app, unknown workspace, non-member → the SAME
 *     `not_found` (anti-enumeration);
 *   - member below the floor (viewer calling a write tool) → `forbidden`;
 *   - global super-admin → effective workspace-admin everywhere.
 * Reads need viewer+, writes editor+.
 */
import {
  decideWorkspaceAccess,
  getMembership,
  resolveWorkspaceAccess,
  roleAtLeast,
  type WorkspaceRole,
} from '@drobek/tenancy';
import type { ToolPrincipal } from './context.js';
import { ToolError, notFound } from './errors.js';
import { findApp, type AppRow } from './queries.js';

function checkFloor(role: WorkspaceRole, min: WorkspaceRole): void {
  if (!roleAtLeast(role, min)) {
    throw new ToolError(
      'forbidden',
      `This needs the ${min} role in the workspace; yours is ${role}.`
    );
  }
}

/** The app (live) and the caller's effective role in its workspace — or a ToolError. */
export async function authorizeApp(
  principal: ToolPrincipal,
  appId: string,
  min: WorkspaceRole
): Promise<{ app: AppRow; role: WorkspaceRole }> {
  const app = typeof appId === 'string' && appId.length > 0 ? await findApp(appId) : null;
  if (!app) throw notFound('app');
  const membership = await getMembership(principal.userId, app.workspaceId);
  const decision = decideWorkspaceAccess({
    membershipRole: membership?.role ?? null,
    superAdmin: principal.superAdmin,
    minRole: 'viewer',
  });
  if (!decision.ok) throw notFound('app');
  checkFloor(decision.effectiveRole, min);
  return { app, role: decision.effectiveRole };
}

/** A workspace by slug the caller can reach, with the role floor applied — or a ToolError. */
export async function authorizeWorkspace(
  principal: ToolPrincipal,
  workspaceSlug: string,
  min: WorkspaceRole
): Promise<{ id: string; slug: string; role: WorkspaceRole }> {
  const access = await resolveWorkspaceAccess({
    userId: principal.userId,
    superAdmin: principal.superAdmin,
    workspaceSlug,
  });
  if (!access) throw notFound('workspace');
  checkFloor(access.effectiveRole, min);
  return { id: access.workspace.id, slug: access.workspace.slug, role: access.effectiveRole };
}
