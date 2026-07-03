/**
 * Redis-backed serving caches + read-through DB loaders (U7, PHY-58).
 *
 * Three keys, all `drobek:`-prefixed:
 *  - `drobek:serve:ws:<wsSlug>`            → workspace id (slug↔id is stable).
 *  - `drobek:serve:app:<wsId>/<appSlug>`   → the app POINTER record
 *      {activeDeployId, routingMode, visibility, hasPassword, status}. This is
 *      the only mutable one: it is busted explicitly on activate/rollback (the
 *      deploy pipeline calls `bustServeCache` with the workspaceId+appSlug it
 *      already holds) and additionally carries a short TTL backstop for
 *      visibility/status edits not wired to a bust.
 *  - `drobek:manifest:<deployId>`          → the resolved {path → {sha256,size}}
 *      manifest. A deploy is IMMUTABLE, so this is keyed by deployId and never
 *      needs busting — a rollback just points at a different (cached) deploy.
 *
 * `password_hash` is deliberately NOT cached — the POST verify reads it from
 * the DB on demand (`loadAppPasswordHash`), so no secret material lives in the
 * shared cache.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { getRedis } from '@drobek/core';
import { apps, blobs, deployFiles, getDb, workspaces } from '@drobek/db';
import type { RoutingMode } from './resolve.js';
import type { Visibility } from './visibility.js';

export type AppStatus = 'live' | 'hibernated';

export interface ServeAppRecord {
  appId: string;
  workspaceId: string;
  activeDeployId: string | null;
  routingMode: RoutingMode;
  visibility: Visibility;
  /** True when a password_hash is set — the hash itself is never cached. */
  hasPassword: boolean;
  status: AppStatus;
}

export interface ManifestFile {
  sha256: string;
  size: number;
}
export type ServeManifest = Record<string, ManifestFile>;

/** wsSlug → id is effectively immutable (slugs never change here). */
const WS_TTL_SEC = 300;
/** Backstop for visibility/status edits not wired to an explicit bust. */
const APP_TTL_SEC = 60;
/** A deploy is immutable — long TTL, never busted. */
const MANIFEST_TTL_SEC = 24 * 60 * 60;

function wsKey(wsSlug: string): string {
  return `drobek:serve:ws:${wsSlug}`;
}
function appKey(workspaceId: string, appSlug: string): string {
  return `drobek:serve:app:${workspaceId}/${appSlug}`;
}
function manifestKey(deployId: string): string {
  return `drobek:manifest:${deployId}`;
}

/** wsSlug → workspace id (read-through; positive results cached). */
export async function resolveWorkspaceId(wsSlug: string): Promise<string | null> {
  if (!wsSlug) return null;
  const redis = getRedis();
  const cached = await redis.get(wsKey(wsSlug));
  if (cached) return cached;

  const rows = await getDb()
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, wsSlug))
    .limit(1);
  const id = rows[0]?.id ?? null;
  if (id) await redis.set(wsKey(wsSlug), id, 'EX', WS_TTL_SEC);
  return id;
}

/** (workspaceId, appSlug) → pointer record (read-through, TTL-backstopped). */
export async function getServeAppRecord(
  workspaceId: string,
  appSlug: string
): Promise<ServeAppRecord | null> {
  const redis = getRedis();
  const key = appKey(workspaceId, appSlug);
  const cached = await redis.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as ServeAppRecord;
    } catch {
      /* fall through to a fresh DB read */
    }
  }

  const rows = await getDb()
    .select({
      appId: apps.id,
      workspaceId: apps.workspaceId,
      activeDeployId: apps.activeDeployId,
      routingMode: apps.routingMode,
      visibility: apps.visibility,
      passwordHash: apps.passwordHash,
      status: apps.status,
    })
    .from(apps)
    .where(
      and(
        eq(apps.workspaceId, workspaceId),
        eq(apps.slug, appSlug),
        isNull(apps.deletedAt)
      )
    )
    .limit(1);
  const r = rows[0];
  if (!r) return null;

  const record: ServeAppRecord = {
    appId: r.appId,
    workspaceId: r.workspaceId,
    activeDeployId: r.activeDeployId,
    routingMode: r.routingMode as RoutingMode,
    visibility: r.visibility as Visibility,
    hasPassword: Boolean(r.passwordHash),
    status: r.status as AppStatus,
  };
  await redis.set(key, JSON.stringify(record), 'EX', APP_TTL_SEC);
  return record;
}

/** The app's password hash, read straight from the DB (never cached). */
export async function loadAppPasswordHash(appId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ passwordHash: apps.passwordHash })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);
  return rows[0]?.passwordHash ?? null;
}

/** deployId → {path → {sha256,size}} manifest (read-through; immutable deploy). */
export async function getServeManifest(deployId: string): Promise<ServeManifest> {
  const redis = getRedis();
  const key = manifestKey(deployId);
  const cached = await redis.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as ServeManifest;
    } catch {
      /* fall through */
    }
  }

  const rows = await getDb()
    .select({
      path: deployFiles.path,
      sha256: deployFiles.sha256,
      size: blobs.size,
    })
    .from(deployFiles)
    .innerJoin(blobs, eq(blobs.sha256, deployFiles.sha256))
    .where(eq(deployFiles.deployId, deployId));

  const manifest: ServeManifest = {};
  for (const row of rows) {
    manifest[row.path] = { sha256: row.sha256, size: row.size };
  }
  await redis.set(key, JSON.stringify(manifest), 'EX', MANIFEST_TTL_SEC);
  return manifest;
}

/**
 * Invalidate the app-pointer cache after `apps.active_deploy_id` (or
 * visibility/status) changed. Called by the deploy pipeline on activate +
 * rollback. Best-effort: a redis blip is bounded by the pointer TTL backstop, so
 * a failed bust must never fail the deploy/rollback. The manifest cache is NOT
 * busted here — it is keyed by the immutable deployId.
 */
export async function bustServeCache(input: {
  workspaceId: string;
  appSlug: string;
}): Promise<void> {
  try {
    await getRedis().del(appKey(input.workspaceId, input.appSlug));
  } catch {
    /* TTL backstop covers a transient redis failure */
  }
}
