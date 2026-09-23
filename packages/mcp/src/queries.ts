/**
 * Read queries the tools share (apps + their latest version, users' emails),
 * batched so list_apps stays a constant number of round trips.
 */
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { appVersions, apps, getDb, memberships, users, workspaces } from '@drobek/db';
import type { CompileStatus } from '@drobek/apps';

export interface AppRow {
  id: string;
  slug: string;
  name: string | null;
  workspaceId: string;
  workspaceSlug: string;
  publishedVersionId: string | null;
}

const appColumns = {
  id: apps.id,
  slug: apps.slug,
  name: apps.name,
  workspaceId: apps.workspaceId,
  workspaceSlug: workspaces.slug,
  publishedVersionId: apps.publishedVersionId,
};

/** A live (not soft-deleted) app by id, or null. */
export async function findApp(appId: string): Promise<AppRow | null> {
  const [row] = await getDb()
    .select(appColumns)
    .from(apps)
    .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
    .where(and(eq(apps.id, appId), isNull(apps.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** Live apps of one workspace (oldest first). */
export async function appsInWorkspace(workspaceId: string): Promise<AppRow[]> {
  return getDb()
    .select(appColumns)
    .from(apps)
    .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
    .where(and(eq(apps.workspaceId, workspaceId), isNull(apps.deletedAt)))
    .orderBy(asc(apps.createdAt));
}

/** Live apps of every workspace the user is a member of. */
export async function appsOfMember(userId: string): Promise<AppRow[]> {
  return getDb()
    .select(appColumns)
    .from(apps)
    .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
    .innerJoin(
      memberships,
      and(eq(memberships.workspaceId, apps.workspaceId), eq(memberships.userId, userId))
    )
    .where(isNull(apps.deletedAt))
    .orderBy(asc(workspaces.createdAt), asc(apps.createdAt));
}

export interface LatestVersion {
  id: string;
  number: number;
  compileStatus: CompileStatus;
  compileErrors: unknown;
}

/** The newest version of each app (apps without versions are absent). */
export async function latestVersions(appIds: string[]): Promise<Map<string, LatestVersion>> {
  const out = new Map<string, LatestVersion>();
  if (appIds.length === 0) return out;
  const rows = await getDb()
    .selectDistinctOn([appVersions.appId], {
      appId: appVersions.appId,
      id: appVersions.id,
      number: appVersions.number,
      compileStatus: appVersions.compileStatus,
      compileErrors: appVersions.compileErrors,
    })
    .from(appVersions)
    .where(inArray(appVersions.appId, appIds))
    .orderBy(appVersions.appId, desc(appVersions.number));
  for (const { appId, ...v } of rows) out.set(appId, v);
  return out;
}

/** Version numbers by version id (for the published pointers). */
export async function versionNumbers(versionIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (versionIds.length === 0) return out;
  const rows = await getDb()
    .select({ id: appVersions.id, number: appVersions.number })
    .from(appVersions)
    .where(inArray(appVersions.id, versionIds));
  for (const r of rows) out.set(r.id, r.number);
  return out;
}

/** The newest version that compiled ok (what the preview host serves), or null. */
export async function lastOkVersionNumber(appId: string): Promise<number | null> {
  const [row] = await getDb()
    .select({ number: appVersions.number })
    .from(appVersions)
    .where(and(eq(appVersions.appId, appId), eq(appVersions.compileStatus, 'ok')))
    .orderBy(desc(appVersions.number))
    .limit(1);
  return row?.number ?? null;
}

export async function emailsByUserIds(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return out;
  const rows = await getDb()
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));
  for (const r of rows) out.set(r.id, r.email);
  return out;
}
