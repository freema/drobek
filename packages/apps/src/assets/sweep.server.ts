/**
 * The assets sweep (NSO-358): hourly, one replica at a time (Redis lease).
 *
 *   1. apps deleted more than ASSETS_SWEEP_RETENTION_MS (24 h) ago: their
 *      `app_assets` and `app_version_assets` rows and their directory
 *      `ASSETS_DIR/<app_id>/` go
 *      (a soft delete never fires the FK cascade; serving stopped at the
 *      delete — a deleted app has no host);
 *   2. temp uploads (`ASSETS_DIR/tmp/*.part`) older than the retention —
 *      what a crash mid-upload left behind;
 *   3. files in an app directory that neither the draft nor a kept published
 *      set references (NSO-362: a set pruned or replaced by a publish, a
 *      restore that reset the draft, an upload that failed after its file
 *      was moved into place) and that are older than an hour — decided and
 *      removed under the app's assets lock, so an upload reusing the bytes
 *      cannot interleave.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { appAssets, appVersionAssets, apps, dbErrorForLog, getDb } from '@drobek/db';
import { withRedisLock } from '../lock.server.js';
import { assetDisk, type AssetDisk } from './disk.server.js';
import { lockAssets, unreferencedKeys } from './snapshots.server.js';

export const ASSETS_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const ASSETS_SWEEP_RETENTION_MS = 24 * 60 * 60 * 1000;
/** How old an unreferenced file in an app directory must be before it is removed. */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;
const LOCK_KEY = 'drobek:lock:assets-sweep';

export interface AssetsSweepResult {
  /** Deleted apps whose assets were removed. */
  apps: number;
  tmp: number;
  orphans: number;
}

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function olderThan(path: string, cutoffMs: number): Promise<boolean> {
  try {
    return (await stat(path)).mtimeMs < cutoffMs;
  } catch {
    return false;
  }
}

export async function sweepAssets(opts: { disk?: AssetDisk; now?: Date; retentionMs?: number } = {}): Promise<AssetsSweepResult> {
  const disk = opts.disk ?? assetDisk();
  const now = (opts.now ?? new Date()).getTime();
  const retentionMs = opts.retentionMs ?? ASSETS_SWEEP_RETENTION_MS;
  const db = getDb();
  const out: AssetsSweepResult = { apps: 0, tmp: 0, orphans: 0 };

  // 1. deleted apps (rows first: once they are gone nothing serves or lists the files)
  const expired = and(isNotNull(apps.deletedAt), lt(apps.deletedAt, new Date(now - retentionMs)));
  const [draftGone, frozenGone] = await Promise.all([
    db.selectDistinct({ appId: appAssets.appId }).from(appAssets).innerJoin(apps, eq(apps.id, appAssets.appId)).where(expired),
    db.selectDistinct({ appId: appVersionAssets.appId }).from(appVersionAssets).innerJoin(apps, eq(apps.id, appVersionAssets.appId)).where(expired),
  ]);
  for (const appId of new Set([...draftGone, ...frozenGone].map((r) => r.appId))) {
    await db.delete(appAssets).where(eq(appAssets.appId, appId));
    await db.delete(appVersionAssets).where(eq(appVersionAssets.appId, appId));
    await disk.removeApp(appId);
    out.apps += 1;
  }

  // 2. stale temp uploads
  for (const name of await entries(disk.tmpDir)) {
    const path = join(disk.tmpDir, name);
    if (await olderThan(path, now - retentionMs)) {
      await rm(path, { force: true });
      out.tmp += 1;
    }
  }

  // 3. unreferenced files in the app directories
  for (const appId of await entries(disk.root)) {
    if (appId === 'tmp' || !/^[a-z0-9]{1,64}$/.test(appId)) continue;
    const files = await entries(join(disk.root, appId));
    if (files.length === 0) continue;
    out.orphans += await db.transaction(async (tx) => {
      await lockAssets(tx, appId);
      let removed = 0;
      for (const key of await unreferencedKeys(tx, appId, files)) {
        const path = join(disk.root, appId, key);
        if (await olderThan(path, now - ORPHAN_GRACE_MS)) {
          await rm(path, { force: true });
          removed += 1;
        }
      }
      return removed;
    });
  }
  return out;
}

/** The hourly sweep in the server process, under a Redis lease. Returns a stop function. */
export function startAssetsSweep(opts: { log: (msg: string, errorText?: string) => void; disk?: AssetDisk }): () => void {
  const run = async () => {
    try {
      const out = await withRedisLock(LOCK_KEY, Math.floor(ASSETS_SWEEP_INTERVAL_MS / 1000) - 60, () =>
        sweepAssets(opts.disk ? { disk: opts.disk } : {})
      );
      if (out.acquired && out.result.apps + out.result.tmp + out.result.orphans > 0) {
        const r = out.result;
        opts.log(`assets sweep: removed the assets of ${r.apps} deleted app(s), ${r.tmp} stale temp upload(s), ${r.orphans} unreferenced file(s)`);
      }
    } catch (err) {
      opts.log('assets sweep failed', dbErrorForLog(err));
    }
  };
  const timer = setInterval(() => void run(), ASSETS_SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
