/**
 * @drobek/dashboard — db reads for the minimal dashboard (PHY-74 slice).
 * Thin drizzle queries over the apps/app_versions tables; the shaping lives in
 * ./view.ts so these stay trivial. Version history comes from @drobek/apps.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { appVersions, apps, getDb } from '@drobek/db';
import type { AppListRow, AppLiveStatus, AppVisibility } from './view.js';

/**
 * The workspace's live (non-tombstoned) apps with their newest version number
 * and time. Ordering is applied in shapeApps.
 */
export async function listWorkspaceApps(workspaceId: string): Promise<AppListRow[]> {
  const rows = await getDb()
    .select({
      slug: apps.slug,
      status: apps.status,
      visibility: apps.visibility,
      publishedVersionId: apps.publishedVersionId,
      createdAt: apps.createdAt,
      latestVersion: sql<number | null>`max(${appVersions.number})`,
      lastChangeAt: sql<Date | null>`max(${appVersions.createdAt})`.mapWith(appVersions.createdAt),
    })
    .from(apps)
    .leftJoin(appVersions, eq(appVersions.appId, apps.id))
    .where(and(eq(apps.workspaceId, workspaceId), isNull(apps.deletedAt)))
    .groupBy(apps.id);

  return rows.map((r) => ({
    slug: r.slug,
    status: r.status as AppLiveStatus,
    visibility: r.visibility as AppVisibility,
    publishedVersionId: r.publishedVersionId,
    createdAt: r.createdAt,
    latestVersion: r.latestVersion === null ? null : Number(r.latestVersion),
    lastChangeAt: r.lastChangeAt,
  }));
}

export interface AppDetail {
  id: string;
  slug: string;
  status: AppLiveStatus;
  visibility: AppVisibility;
  publishedVersionId: string | null;
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
      publishedVersionId: apps.publishedVersionId,
    })
    .from(apps)
    .where(and(eq(apps.workspaceId, workspaceId), eq(apps.slug, slug), isNull(apps.deletedAt)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    slug: r.slug,
    status: r.status as AppLiveStatus,
    visibility: r.visibility as AppVisibility,
    publishedVersionId: r.publishedVersionId,
  };
}
