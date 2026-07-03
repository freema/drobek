/**
 * App + workspace resolution and caller identity for the Data API (U10). Every
 * data query is CENTRALLY scoped to a single resolved `app_id` here — callers
 * never supply a raw app/workspace id, and cross-workspace access is rejected
 * before any collection/document row is touched (tenant isolation).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { getSessionUser, isSuperAdmin } from '@drobek/auth';
import { apps, getDb } from '@drobek/db';
import { resolveWorkspaceId } from '@drobek/serving';
import { getMembership, type WorkspaceRole } from '@drobek/tenancy';
import { ANON_CALLER, type DataCaller } from './access.js';
import { DataError } from './errors.js';

export interface ResolvedApp {
  appId: string;
  workspaceId: string;
  workspaceSlug: string;
  appSlug: string;
}

/**
 * Resolve `(wsSlug, appSlug)` to a concrete, non-deleted app. When
 * `requireWorkspaceId` is given (the MCP path — the token is bound to ONE
 * workspace), the resolved workspace MUST match it, else `not_found` (a
 * cross-workspace locator never leaks whether the other app exists).
 */
export async function resolveApp(input: {
  wsSlug: string;
  appSlug: string;
  requireWorkspaceId?: string;
}): Promise<ResolvedApp> {
  const { wsSlug, appSlug, requireWorkspaceId } = input;
  if (!wsSlug || !appSlug) {
    throw new DataError('not_found', 'app not found');
  }
  const workspaceId = await resolveWorkspaceId(wsSlug);
  if (!workspaceId) throw new DataError('not_found', 'app not found');
  if (requireWorkspaceId && workspaceId !== requireWorkspaceId) {
    // Token is bound to a different workspace than the locator → reject.
    throw new DataError('not_found', 'app not found');
  }

  const rows = await getDb()
    .select({ id: apps.id })
    .from(apps)
    .where(
      and(
        eq(apps.workspaceId, workspaceId),
        eq(apps.slug, appSlug),
        isNull(apps.deletedAt)
      )
    )
    .limit(1);
  const app = rows[0];
  if (!app) throw new DataError('not_found', 'app not found');

  return { appId: app.id, workspaceId, workspaceSlug: wsSlug, appSlug };
}

/**
 * Resolve the caller identity for a REST request against `workspaceId`: an
 * authenticated workspace member (or super-admin) becomes an authorized
 * `DataCaller`; everyone else is anonymous. NEVER trusts client-supplied
 * identity — only the signed session cookie.
 */
export async function resolveRestCaller(
  request: Request,
  workspaceId: string
): Promise<DataCaller> {
  const user = await getSessionUser(request);
  if (!user) return ANON_CALLER;
  if (isSuperAdmin(user.email)) {
    return { authenticated: true, role: 'workspace-admin' };
  }
  const membership = await getMembership(user.id, workspaceId);
  if (!membership) return ANON_CALLER;
  return { authenticated: true, role: membership.role as WorkspaceRole };
}
