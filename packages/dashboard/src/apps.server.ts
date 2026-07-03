/**
 * @drobek/dashboard — db reads for the U8 minimal dashboard (PHY-74 slice).
 * Thin drizzle queries over the EXISTING apps/deploys tables (no new schema);
 * the shaping lives in ./view.ts so these stay trivial.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { apps, deploys, getDb } from '@drobek/db';
import type {
  AppLiveStatus,
  AppListRow,
  AppVisibility,
  DeployHistoryRow,
  DeployStateName,
} from './view.js';

/**
 * The workspace's live (non-tombstoned) apps, each joined to its active deploy
 * so the list can show the last-deployed time. Ordering is applied in shapeApps.
 */
export async function listWorkspaceApps(
  workspaceId: string
): Promise<AppListRow[]> {
  const rows = await getDb()
    .select({
      slug: apps.slug,
      status: apps.status,
      visibility: apps.visibility,
      activeDeployId: apps.activeDeployId,
      createdAt: apps.createdAt,
      lastDeployAt: deploys.activatedAt,
    })
    .from(apps)
    .leftJoin(deploys, eq(deploys.id, apps.activeDeployId))
    .where(and(eq(apps.workspaceId, workspaceId), isNull(apps.deletedAt)));

  return rows.map((r) => ({
    slug: r.slug,
    status: r.status as AppLiveStatus,
    visibility: r.visibility as AppVisibility,
    activeDeployId: r.activeDeployId,
    createdAt: r.createdAt,
    lastDeployAt: r.lastDeployAt,
  }));
}

export interface AppDetail {
  id: string;
  slug: string;
  status: AppLiveStatus;
  visibility: AppVisibility;
  activeDeployId: string | null;
}

/** A single app within a workspace, by slug (tombstones excluded). */
export async function loadAppForView(
  workspaceId: string,
  slug: string
): Promise<AppDetail | null> {
  const rows = await getDb()
    .select({
      id: apps.id,
      slug: apps.slug,
      status: apps.status,
      visibility: apps.visibility,
      activeDeployId: apps.activeDeployId,
    })
    .from(apps)
    .where(
      and(
        eq(apps.workspaceId, workspaceId),
        eq(apps.slug, slug),
        isNull(apps.deletedAt)
      )
    )
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    slug: r.slug,
    status: r.status as AppLiveStatus,
    visibility: r.visibility as AppVisibility,
    activeDeployId: r.activeDeployId,
  };
}

/** The app's deploy history, newest-created first (tombstones excluded). */
export async function listAppDeploys(
  appId: string
): Promise<DeployHistoryRow[]> {
  const rows = await getDb()
    .select({
      id: deploys.id,
      state: deploys.state,
      createdAt: deploys.createdAt,
      activatedAt: deploys.activatedAt,
      lintReport: deploys.lintReport,
    })
    .from(deploys)
    .where(and(eq(deploys.appId, appId), isNull(deploys.deletedAt)))
    .orderBy(desc(deploys.createdAt));

  return rows.map((r) => ({
    id: r.id,
    state: r.state as DeployStateName,
    createdAt: r.createdAt,
    activatedAt: r.activatedAt,
    lintReport: (r.lintReport as { ok?: boolean } | null) ?? null,
  }));
}
