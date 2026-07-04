/**
 * App resolution for insights (PHY-123). Resolves `(wsSlug, appSlug)` to a
 * concrete, NON-deleted app id. The caller never supplies a raw app/workspace
 * id; a cross-workspace locator (MCP token bound elsewhere) is rejected before
 * any error/signal row is read — tenant isolation, mirroring @drobek/data.
 *
 * Self-contained (workspaces + apps tables only) so @drobek/serving can depend
 * on this package for the serving-signal hook WITHOUT a dependency cycle.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { apps, getDb, workspaces } from '@drobek/db';
import { InsightsError } from './errors.js';

export interface ResolvedApp {
  appId: string;
  workspaceId: string;
}

export async function resolveLiveApp(input: {
  wsSlug: string;
  appSlug: string;
  /** MCP path only: the token's bound workspace id (cross-workspace guard). */
  requireWorkspaceId?: string;
}): Promise<ResolvedApp> {
  const { wsSlug, appSlug, requireWorkspaceId } = input;
  if (!wsSlug || !appSlug) throw new InsightsError('not_found', 'app not found');

  const wsRows = await getDb()
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, wsSlug))
    .limit(1);
  const workspaceId = wsRows[0]?.id;
  if (!workspaceId) throw new InsightsError('not_found', 'app not found');
  if (requireWorkspaceId && workspaceId !== requireWorkspaceId) {
    // Token is bound to a different workspace than the locator → reject
    // (never leak whether the other app exists).
    throw new InsightsError('not_found', 'app not found');
  }

  const appRows = await getDb()
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
  const appId = appRows[0]?.id;
  if (!appId) throw new InsightsError('not_found', 'app not found');

  return { appId, workspaceId };
}
