/**
 * App purge: APP_PURGE_AFTER_DAYS (30) after its soft delete an app is
 * deleted for good. Deleting its `apps` row takes everything that belongs to
 * the app with it, because every reference to `apps(id)` is ON DELETE
 * CASCADE: the versions and their file lists (a blob no other version uses
 * goes with the next blob GC), module configs and secrets, custom domains,
 * asset rows, gallery likes and opens, browser errors, compiles, request
 * stats, and the module tables (records, form submissions, end users and
 * their identities, sync state, uploads — whose blobs the files sweep unlinks
 * once no row references them). Abuse reports and the apps duplicated from it
 * keep their rows (ON DELETE SET NULL). Besides the row the purge removes the
 * app's id from every upstream's `allowed_app_ids` and its asset directory.
 * Audit rows have no foreign key: they stay until AUDIT_RETENTION_DAYS.
 * Audited `app.purge` (a system action, target = the slug the app had).
 *
 * One app per transaction, its row locked SKIP LOCKED and re-checked, so two
 * runs never purge the same app. An app whose delete fails (a module table
 * that references `apps(id)` without ON DELETE) stays deleted, is reported in
 * `failed` and is retried on the next run; the others go on.
 */
import { and, asc, eq, gt, isNotNull, lte, sql, type SQL } from 'drizzle-orm';
import { AUDIT_ACTIONS, writeAudit } from '@drobek/audit';
import { apps, dbErrorForLog, getDb, upstreams } from '@drobek/db';
import { assetDisk, type AssetDisk } from './assets/disk.server.js';
import { lockAssets } from './assets/snapshots.server.js';
import { SLUG_RELEASE_AFTER_MS, slugBeforeRelease } from './lifecycle.server.js';
import { withRedisLock } from './lock.server.js';

export const DEFAULT_APP_PURGE_AFTER_DAYS = 30;
export const DEFAULT_APP_PURGE_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 100;
const LOCK_KEY = 'drobek:lock:app-purge';

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** APP_PURGE_AFTER_DAYS / APP_PURGE_INTERVAL_MS (the production defaults when unset or invalid). */
export function appPurgeSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): { afterDays: number; intervalMs: number } {
  return {
    afterDays: positiveInt(env.APP_PURGE_AFTER_DAYS, DEFAULT_APP_PURGE_AFTER_DAYS),
    intervalMs: positiveInt(env.APP_PURGE_INTERVAL_MS, DEFAULT_APP_PURGE_INTERVAL_MS),
  };
}

/**
 * What a delete promises, in days: the address stays reserved for
 * `slugReservedDays` (30, or less when the purge comes sooner and frees it),
 * the app and its data are deleted for good after `purgeDays`.
 */
export function deletionWindow(env: NodeJS.ProcessEnv = process.env): { slugReservedDays: number; purgeDays: number } {
  const purgeDays = appPurgeSettingsFromEnv(env).afterDays;
  return { slugReservedDays: Math.min(Math.round(SLUG_RELEASE_AFTER_MS / DAY_MS), purgeDays), purgeDays };
}

export interface PurgedApp {
  appId: string;
  workspaceId: string;
  /** The slug the app had (a released slug's tombstone is undone). */
  slug: string;
}

export interface AppPurgeResult {
  purged: PurgedApp[];
  /** Apps whose delete failed (log-safe error text); they stay deleted and are retried. */
  failed: { appId: string; error: string }[];
}

/**
 * Delete one soft-deleted app for good (see the file header) → what was
 * purged, or null when the app is live, deleted after `deletedBefore`,
 * already gone or being purged by another run. Throws when the delete fails;
 * nothing changed then.
 */
export async function purgeApp(
  appId: string,
  opts: { deletedBefore?: Date; disk?: AssetDisk } = {}
): Promise<PurgedApp | null> {
  const disk = opts.disk ?? assetDisk();
  const conditions: SQL[] = [eq(apps.id, appId), isNotNull(apps.deletedAt)];
  if (opts.deletedBefore) conditions.push(lte(apps.deletedAt, opts.deletedBefore));
  return getDb().transaction(async (tx) => {
    const [app] = await tx
      .select({ id: apps.id, slug: apps.slug, workspaceId: apps.workspaceId })
      .from(apps)
      .where(and(...conditions))
      .for('update', { skipLocked: true });
    if (!app) return null;
    await lockAssets(tx, app.id);
    await tx
      .update(upstreams)
      .set({ allowedAppIds: sql`array_remove(${upstreams.allowedAppIds}, ${app.id})` })
      .where(sql`${app.id} = ANY(${upstreams.allowedAppIds})`);
    await tx.delete(apps).where(eq(apps.id, app.id));
    const slug = slugBeforeRelease(app.slug);
    await writeAudit(
      {
        workspaceId: app.workspaceId,
        actorUserId: null,
        actorKind: 'user',
        action: AUDIT_ACTIONS.appPurge,
        subjectType: 'app',
        target: slug,
        meta: { appId: app.id },
      },
      tx
    );
    await disk.removeApp(app.id);
    return { appId: app.id, workspaceId: app.workspaceId, slug };
  });
}

/**
 * Purge every app deleted at least `afterDays` (APP_PURGE_AFTER_DAYS) before
 * `now`, in app-id order. A failed app is reported and skipped.
 */
export async function purgeDeletedApps(
  opts: { now?: Date; afterDays?: number; disk?: AssetDisk } = {}
): Promise<AppPurgeResult> {
  const afterDays = opts.afterDays ?? appPurgeSettingsFromEnv().afterDays;
  const deletedBefore = new Date((opts.now ?? new Date()).getTime() - afterDays * DAY_MS);
  const out: AppPurgeResult = { purged: [], failed: [] };
  let after = '';
  for (;;) {
    const batch = await getDb()
      .select({ id: apps.id })
      .from(apps)
      .where(and(isNotNull(apps.deletedAt), lte(apps.deletedAt, deletedBefore), gt(apps.id, after)))
      .orderBy(asc(apps.id))
      .limit(BATCH);
    for (const { id } of batch) {
      try {
        const purged = await purgeApp(id, { deletedBefore, ...(opts.disk ? { disk: opts.disk } : {}) });
        if (purged) out.purged.push(purged);
      } catch (err) {
        out.failed.push({ appId: id, error: dbErrorForLog(err) });
      }
    }
    if (batch.length < BATCH) return out;
    after = batch[batch.length - 1].id;
  }
}

/**
 * The purge in the server process: first within a minute of the start, then
 * every APP_PURGE_INTERVAL_MS (1 h), one replica at a time (Redis lease).
 * `afterPurge` gets the apps of a run that purged any — for what lives
 * outside the database (the end-user sessions in Redis). Returns a stop
 * function.
 */
export function startAppPurge(opts: {
  log: (msg: string, errorText?: string) => void;
  afterPurge?: (purged: PurgedApp[]) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}): () => void {
  const { afterDays, intervalMs } = appPurgeSettingsFromEnv(opts.env);
  const leaseSec = Math.max(600, Math.ceil(intervalMs / 1000));
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const out = await withRedisLock(LOCK_KEY, leaseSec, () => purgeDeletedApps({ afterDays }));
      if (!out.acquired) return;
      for (const f of out.result.failed) {
        opts.log(`app purge: app ${f.appId} was not deleted, the next run retries it`, f.error);
      }
      const { purged } = out.result;
      if (purged.length === 0) return;
      opts.log(`app purge: deleted ${purged.length} app(s) for good, ${afterDays} day(s) after their delete`);
      if (opts.afterPurge) {
        try {
          await opts.afterPurge(purged);
        } catch (err) {
          opts.log('app purge: the clean-up after the purge failed', dbErrorForLog(err));
        }
      }
    } catch (err) {
      opts.log('app purge failed', dbErrorForLog(err));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), Math.min(60_000, intervalMs));
  first.unref();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
