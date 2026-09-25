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
      name: apps.name,
      status: apps.status,
      visibility: apps.visibility,
      publishedVersionId: apps.publishedVersionId,
      createdAt: apps.createdAt,
      latestVersion: sql<number | null>`max(${appVersions.number})`,
      lastChangeAt: sql<Date | null>`max(${appVersions.createdAt})`.mapWith(appVersions.createdAt),
      // NSO-342: the thumbnail needs a compiled version (preview) and the takedown state.
      compiled: sql<boolean | null>`bool_or(${appVersions.compileStatus} = 'ok')`,
      lockedReason: apps.lockedReason,
    })
    .from(apps)
    .leftJoin(appVersions, eq(appVersions.appId, apps.id))
    .where(and(eq(apps.workspaceId, workspaceId), isNull(apps.deletedAt)))
    .groupBy(apps.id);

  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    status: r.status as AppLiveStatus,
    visibility: r.visibility as AppVisibility,
    publishedVersionId: r.publishedVersionId,
    createdAt: r.createdAt,
    latestVersion: r.latestVersion === null ? null : Number(r.latestVersion),
    lastChangeAt: r.lastChangeAt,
    compiled: r.compiled === true,
    lockedReason: r.lockedReason,
  }));
}

export interface AppDetail {
  id: string;
  slug: string;
  name: string | null;
  workspaceId: string;
  status: AppLiveStatus;
  visibility: AppVisibility;
  /** A password is stored (never the hash itself). */
  hasPassword: boolean;
  /** Raw `apps.frame_ancestors` override (null → no embedding). */
  frameAncestors: string | null;
  publishedVersionId: string | null;
  /** NSO-293: the takedown category; non-null = taken down by a super-admin. */
  lockedReason: string | null;
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
      name: apps.name,
      workspaceId: apps.workspaceId,
      status: apps.status,
      visibility: apps.visibility,
      hasPassword: sql<boolean>`${apps.passwordHash} IS NOT NULL`,
      frameAncestors: apps.frameAncestors,
      publishedVersionId: apps.publishedVersionId,
      lockedReason: apps.lockedReason,
    })
    .from(apps)
    .where(and(eq(apps.workspaceId, workspaceId), eq(apps.slug, slug), isNull(apps.deletedAt)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    workspaceId: r.workspaceId,
    status: r.status as AppLiveStatus,
    visibility: r.visibility as AppVisibility,
    hasPassword: Boolean(r.hasPassword),
    frameAncestors: r.frameAncestors,
    publishedVersionId: r.publishedVersionId,
    lockedReason: r.lockedReason,
  };
}
