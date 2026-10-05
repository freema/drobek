/**
 * How much version history drobek keeps:
 *
 *   APP_VERSIONS_KEEP       the newest versions of each app the retention
 *                           keeps (default 200); kept versions stay on top
 *   APP_VERSIONS_KEPT_MAX   versions of one app its members may keep
 *                           (default 20)
 *   WORKSPACE_SOURCE_QUOTA  bytes of the unique files (sources and their
 *                           built output) the versions of a workspace's live
 *                           apps may store (default 1 GiB)
 *
 * The retention (`pruneVersionHistory`, hourly under a Redis lease) deletes
 * the versions of an app older than its newest APP_VERSIONS_KEEP, and a
 * member's clean-up (`deleteVersions`) the versions up to a number they pick.
 * Both leave the same versions alone (`protectionReason`): the published
 * version, the newest version that compiled (the one the preview serves), a
 * version a member keeps (`kept_at`, version-keep.server.ts), a version whose
 * asset set is kept for a rollback (`assets_frozen_at`), the newest version
 * (version numbers are never reused) and a version from the last hour (it
 * still counts against the hourly version rate). Each app is pruned under its
 * row lock, so a write, restore or publish never sees half of it;
 * `version_files` go with their version (cascade) and the blob GC removes the
 * bytes nothing references any more. A prune is audited `app.versions.prune`
 * (a system action), a clean-up `app.versions.delete` (the member).
 *
 * The quota is checked when a version is stored (`createVersion`, after the
 * app's row lock, under a per-workspace advisory lock so parallel writes in
 * one workspace cannot overshoot it): a version whose NEW unique bytes would
 * take the workspace past WORKSPACE_SOURCE_QUOTA is refused with
 * `limit_exceeded` and nothing is stored. A version that adds no bytes (a
 * restore, a revert) always fits. Deleted apps and deleted versions do not
 * count.
 *
 * All three are in the limits catalogue (`CORE_LIMITS`, @drobek/modules), so a
 * limits provider can set them per workspace. The retention leaves a
 * workspace alone while the provider does not answer: the env fallback never
 * deletes history a plan keeps.
 */
import { createHash } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import { AUDIT_ACTIONS, writeAudit } from '@drobek/audit';
import { appVersions, apps, dbErrorForLog, getDb, type DB } from '@drobek/db';
import { AppsError } from './errors.js';
import { notifyAppChanged } from './events.js';
import { withRedisLock } from './lock.server.js';
import { lockedByAdminError } from './moderation.server.js';
import type { Actor } from './types.js';
import { VERSION_RATE_WINDOW_SEC } from './version-rate.server.js';

export const DEFAULT_APP_VERSIONS_KEEP = 200;
export const DEFAULT_APP_VERSIONS_KEPT_MAX = 20;
export const DEFAULT_APP_VERSIONS_PAGE = 20;
export const DEFAULT_WORKSPACE_SOURCE_QUOTA = 1024 * 1024 * 1024;
export const VERSION_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** Versions one transaction of the retention deletes at most (the app's row lock is held meanwhile). */
const PRUNE_BATCH = 200;
const LOCK_KEY = 'drobek:lock:version-retention';

export interface VersionStorageLimits {
  /** APP_VERSIONS_KEEP */
  keep: number;
  /** APP_VERSIONS_KEPT_MAX */
  keptMax: number;
  /** WORKSPACE_SOURCE_QUOTA, bytes */
  sourceQuota: number;
}

type Executor = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

function positiveInt(raw: unknown, fallback: number): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function rowsOf<T>(res: unknown): T[] {
  return Array.isArray(res) ? (res as T[]) : ((res as { rows?: T[] }).rows ?? []);
}

/** The server-wide limits (no workspace): the env, else the defaults. */
export function versionStorageLimits(env: NodeJS.ProcessEnv = process.env): VersionStorageLimits {
  return {
    keep: positiveInt(env.APP_VERSIONS_KEEP, DEFAULT_APP_VERSIONS_KEEP),
    keptMax: positiveInt(env.APP_VERSIONS_KEPT_MAX, DEFAULT_APP_VERSIONS_KEPT_MAX),
    sourceQuota: positiveInt(env.WORKSPACE_SOURCE_QUOTA, DEFAULT_WORKSPACE_SOURCE_QUOTA),
  };
}

/** A workspace's limits as the module runtime answers them (`workspaceLimits`); a missing value falls back to the env. */
export function versionStorageLimitsOf(
  limits: Readonly<Record<string, number>>,
  env: NodeJS.ProcessEnv = process.env
): VersionStorageLimits {
  const base = versionStorageLimits(env);
  return {
    keep: positiveInt(limits.APP_VERSIONS_KEEP, base.keep),
    keptMax: positiveInt(limits.APP_VERSIONS_KEPT_MAX, base.keptMax),
    sourceQuota: positiveInt(limits.WORKSPACE_SOURCE_QUOTA, base.sourceQuota),
  };
}

/** APP_VERSIONS_PAGE: versions one page of the history lists (the dashboard's page, list_versions' maximum). */
export function versionsPageSize(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.APP_VERSIONS_PAGE, DEFAULT_APP_VERSIONS_PAGE);
}

// ── the quota ────────────────────────────────────────────────────────────────

/** The versions of the workspace's live apps, as a FROM … WHERE fragment over `version_files vf`. */
function workspaceFiles(workspaceId: string) {
  return sql`version_files vf
    JOIN app_versions v ON v.id = vf.version_id
    JOIN apps a ON a.id = v.app_id
    WHERE a.workspace_id = ${workspaceId} AND a.deleted_at IS NULL`;
}

/** Bytes of the unique files the versions of the workspace's live apps store. */
export async function workspaceSourceBytes(workspaceId: string, ex: Executor = getDb()): Promise<number> {
  const res = await ex.execute(sql`
    SELECT coalesce(sum(size), 0)::text AS used FROM (
      SELECT DISTINCT vf.sha256, vf.size FROM ${workspaceFiles(workspaceId)}
    ) d`);
  return Number(rowsOf<{ used: string }>(res)[0]?.used ?? 0);
}

/** Of `files` (sha256 → size), the bytes no version of the workspace's live apps stores yet. */
async function newBytes(ex: Executor, workspaceId: string, files: Map<string, number>): Promise<number> {
  if (files.size === 0) return 0;
  const res = await ex.execute(sql`
    SELECT DISTINCT vf.sha256 FROM ${workspaceFiles(workspaceId)}
      AND vf.sha256 IN (${sql.join([...files.keys()].map((s) => sql`${s}`), sql`, `)})`);
  const stored = new Set(rowsOf<{ sha256: string }>(res).map((r) => r.sha256));
  let bytes = 0;
  for (const [sha256, size] of files) if (!stored.has(sha256)) bytes += size;
  return bytes;
}

function mib(bytes: number): string {
  const v = bytes / (1024 * 1024);
  return `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} MiB`;
}

async function check(ex: Executor, workspaceId: string, files: Map<string, number>, quota: number): Promise<void> {
  const adding = await newBytes(ex, workspaceId, files);
  if (adding === 0) return;
  const used = await workspaceSourceBytes(workspaceId, ex);
  if (used + adding <= quota) return;
  throw new AppsError(
    'limit_exceeded',
    `The versions of this workspace's apps store ${mib(used)} and this one would add ${mib(adding)}; the limit (WORKSPACE_SOURCE_QUOTA) is ${mib(quota)} — nothing was stored. Delete an app the workspace no longer needs (its versions stop counting at once), make the app smaller, or ask the operator for a higher limit.`,
    { details: { limit: 'WORKSPACE_SOURCE_QUOTA', value: quota, used_bytes: used } }
  );
}

/** sha256 → size of the files a version would store. */
export function fileSizes(files: Iterable<{ sha256: string; size: number }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of files) out.set(f.sha256, f.size);
  return out;
}

/**
 * `limit_exceeded` when a version of `files` would take the workspace past
 * its quota — the check ahead of work whose result createVersion would refuse
 * (a new app's version 1, a gallery copy).
 */
export async function assertSourceQuota(
  workspaceId: string,
  files: Iterable<{ content: string | Buffer }>,
  quota: number = versionStorageLimits().sourceQuota
): Promise<void> {
  const sizes = new Map<string, number>();
  for (const f of files) {
    const bytes = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
    sizes.set(createHash('sha256').update(bytes).digest('hex'), bytes.length);
  }
  await check(getDb(), workspaceId, sizes, quota);
}

/** The check inside createVersion, after the app's row lock: one workspace's new versions are serialized. */
export async function assertSourceQuotaLocked(
  tx: Executor,
  workspaceId: string,
  files: Map<string, number>,
  quota: number
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`drobek:sources:${workspaceId}`}::text))`);
  await check(tx, workspaceId, files, quota);
}

// ── what is kept ─────────────────────────────────────────────────────────────

export interface VersionRetentionInfo {
  /** APP_VERSIONS_KEEP of the app's workspace. */
  keep: number;
  /** Versions the app has now. */
  stored: number;
  /** Its oldest and newest stored version (null: none). */
  oldest: number | null;
  newest: number | null;
}

/** How many versions the app keeps (`keep`) and has. */
export async function versionRetention(appId: string, keep: number, ex: Executor = getDb()): Promise<VersionRetentionInfo> {
  const [row] = await ex
    .select({
      stored: sql<number>`count(*)`.mapWith(Number),
      oldest: sql<number | null>`min(${appVersions.number})`,
      newest: sql<number | null>`max(${appVersions.number})`,
    })
    .from(appVersions)
    .where(eq(appVersions.appId, appId));
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return { keep, stored: row?.stored ?? 0, oldest: num(row?.oldest), newest: num(row?.newest) };
}

/**
 * Why the app has no version `number`: it never existed, or the retention or a
 * member's clean-up deleted it (version numbers are never reused, so a missing
 * number below the newest one was deleted). `keep` = the workspace's
 * APP_VERSIONS_KEEP, when the caller knows it.
 */
export async function missingVersionMessage(
  appId: string,
  number: number,
  opts: { keep?: number; ex?: Executor } = {}
): Promise<string> {
  const info = await versionRetention(appId, opts.keep ?? 0, opts.ex);
  if (info.newest === null) return `Version ${number} does not exist — the app has no versions yet.`;
  if (number > info.newest) return `Version ${number} does not exist — the newest version is ${info.newest}.`;
  const newest = opts.keep ? `its newest ${opts.keep} versions` : 'its newest versions';
  return `Version ${number} is no longer stored: the history retention or a member's clean-up deleted it. An app keeps ${newest}, the published one, the kept ones and those kept for a rollback; the oldest version still stored is ${info.oldest}.`;
}

// ── what never goes ─────────────────────────────────────────────────────────

/** Why a version stays when the retention or a clean-up would delete it. */
export type VersionProtection = 'published' | 'preview' | 'kept' | 'rollback_assets' | 'newest' | 'recent';

/**
 * The one rule both deleters share: over `app_versions v` of app `appId`, the
 * reason the version must stay (a VersionProtection), or NULL when it may go.
 * The subqueries do not depend on `v`, so each runs once per statement.
 */
function protectionReason(appId: string): SQL {
  return sql`CASE
    WHEN v.id IS NOT DISTINCT FROM (SELECT published_version_id FROM apps WHERE id = ${appId}) THEN 'published'
    WHEN v.id IS NOT DISTINCT FROM (
      SELECT id FROM app_versions WHERE app_id = ${appId} AND compile_status = 'ok' ORDER BY number DESC LIMIT 1
    ) THEN 'preview'
    WHEN v.kept_at IS NOT NULL THEN 'kept'
    WHEN v.assets_frozen_at IS NOT NULL THEN 'rollback_assets'
    WHEN v.number = (SELECT max(number) FROM app_versions WHERE app_id = ${appId}) THEN 'newest'
    WHEN v.created_at >= localtimestamp - make_interval(secs => ${VERSION_RATE_WINDOW_SEC}) THEN 'recent'
  END`;
}

/** The reason each of `numbers` stays (null: it may go); the version must exist. */
export async function versionProtections(
  appId: string,
  numbers: number[],
  ex: Executor = getDb()
): Promise<Map<number, VersionProtection | null>> {
  if (numbers.length === 0) return new Map();
  const res = await ex.execute(sql`
    SELECT v.number, ${protectionReason(appId)} AS reason FROM app_versions v
    WHERE v.app_id = ${appId} AND v.number IN (${sql.join(numbers.map((n) => sql`${n}`), sql`, `)})`);
  return new Map(rowsOf<{ number: number; reason: VersionProtection | null }>(res).map((r) => [Number(r.number), r.reason ?? null]));
}

/** Delete one batch of the versions `which` selects that may go; the numbers deleted, ascending. */
async function deleteBatch(ex: Executor, appId: string, which: SQL): Promise<number[]> {
  const res = await ex.execute(sql`
    DELETE FROM app_versions WHERE id IN (
      SELECT v.id FROM app_versions v
      WHERE v.app_id = ${appId} AND ${which} AND (${protectionReason(appId)}) IS NULL
      ORDER BY v.number
      LIMIT ${PRUNE_BATCH}
    )
    RETURNING number`);
  return rowsOf<{ number: number }>(res)
    .map((r) => Number(r.number))
    .sort((a, b) => a - b);
}

/** Ascending version numbers as compact ranges: [3,4,5,9] → ["3-5", "9"]. */
export function versionRanges(numbers: Iterable<number>): string[] {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    out.push(i === j ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return out;
}

// ── the retention ────────────────────────────────────────────────────────────

export interface VersionPruneResult {
  /** Apps that lost versions. */
  apps: number;
  versions: number;
  /** Apps left alone because their workspace's limits were unknown (the limits provider did not answer). */
  skipped: number;
  failed: number;
}

export interface PruneVersionHistoryOptions {
  /**
   * The effective limits of a workspace, or null to leave it alone this run
   * (`ModuleRuntime.settledWorkspaceLimits`). Omitted: the env.
   */
  limits?: (workspaceId: string) => Promise<Readonly<Record<string, number>> | null>;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string, errorText?: string) => void;
}

/** Delete one batch of the app's versions past `keep`; the numbers deleted (ascending), or null when the app is gone. */
async function pruneBatch(appId: string, keep: number): Promise<{ slug: string; numbers: number[] } | null> {
  return getDb().transaction(async (tx) => {
    const [app] = await tx
      .select({ slug: apps.slug, workspaceId: apps.workspaceId })
      .from(apps)
      .where(eq(apps.id, appId))
      .for('update');
    if (!app) return null;
    const numbers = await deleteBatch(
      tx,
      appId,
      sql`v.number <= (SELECT max(number) FROM app_versions WHERE app_id = ${appId}) - ${keep}`
    );
    if (numbers.length > 0) {
      await writeAudit(
        {
          workspaceId: app.workspaceId,
          actorUserId: null,
          actorKind: 'user',
          action: AUDIT_ACTIONS.appVersionsPrune,
          subjectType: 'app',
          target: app.slug,
          meta: { appId, versions: numbers.length, from: numbers[0], to: numbers[numbers.length - 1], keep },
        },
        tx
      );
    }
    return { slug: app.slug, numbers };
  });
}

/** Prune one app to `keep`; how many versions went. */
async function pruneApp(appId: string, keep: number): Promise<number> {
  let deleted = 0;
  let slug: string | null = null;
  for (;;) {
    const batch = await pruneBatch(appId, keep);
    if (!batch) break;
    slug = batch.slug;
    deleted += batch.numbers.length;
    if (batch.numbers.length < PRUNE_BATCH) break;
  }
  // The version hosts of the deleted versions stop answering from the next request.
  if (deleted > 0 && slug) await notifyAppChanged({ app_id: appId, slug, kind: 'version' });
  return deleted;
}

/**
 * The retention over every app (deleted ones too): versions past the
 * workspace's APP_VERSIONS_KEEP go, the kept ones (see the file comment) stay.
 */
export async function pruneVersionHistory(opts: PruneVersionHistoryOptions = {}): Promise<VersionPruneResult> {
  const env = opts.env ?? process.env;
  const candidates = await getDb()
    .select({ appId: appVersions.appId, workspaceId: apps.workspaceId, count: sql<number>`count(*)`.mapWith(Number) })
    .from(appVersions)
    .innerJoin(apps, eq(apps.id, appVersions.appId))
    .groupBy(appVersions.appId, apps.workspaceId)
    .having(sql`count(*) > 1`);
  const keepOf = new Map<string, number | null>();
  const out: VersionPruneResult = { apps: 0, versions: 0, skipped: 0, failed: 0 };
  for (const c of candidates) {
    if (!keepOf.has(c.workspaceId)) {
      let keep: number | null = null;
      try {
        const limits = opts.limits ? await opts.limits(c.workspaceId) : {};
        keep = limits ? versionStorageLimitsOf(limits, env).keep : null;
      } catch (err) {
        opts.log?.('version retention: the limits of a workspace are unavailable', dbErrorForLog(err));
      }
      keepOf.set(c.workspaceId, keep);
    }
    const keep = keepOf.get(c.workspaceId) ?? null;
    if (keep === null) {
      out.skipped += 1;
      continue;
    }
    if (c.count <= keep) continue;
    try {
      const deleted = await pruneApp(c.appId, keep);
      if (deleted > 0) {
        out.apps += 1;
        out.versions += deleted;
      }
    } catch (err) {
      out.failed += 1;
      opts.log?.('version retention failed for an app', dbErrorForLog(err));
    }
  }
  return out;
}

// ── a member's clean-up ──────────────────────────────────────────────────────

export interface VersionDeletionOptions {
  /** Only versions whose build failed (`compile_status = 'error'`). */
  failedOnly?: boolean;
  /**
   * `deleteVersions` only: the `planId` of the plan the member confirmed. When
   * the versions that would go differ from it, nothing is deleted
   * (`plan_changed`).
   */
  expectedPlanId?: string;
}

export interface VersionDeletion {
  /** The versions deleted (a plan: that a clean-up would delete) as ranges, e.g. ["3-41", "45"]. */
  deleted: string[];
  /** How many versions `deleted` covers. */
  count: number;
  /** The versions up to `upTo` that stay, by reason, as ranges; a reason with none is absent. */
  skipped: Partial<Record<VersionProtection, string[]>>;
  /**
   * The fingerprint of the set of versions the plan deletes (for
   * `deleteVersions`: the set it planned under the app's row lock). The same
   * set always gives the same id.
   */
  planId: string;
}

/** The fingerprint of a set of version numbers to delete. */
function planIdOf(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  return createHash('sha256').update(`versions:${sorted.join(',')}`).digest('hex').slice(0, 24);
}

type Locked = { slug: string; workspaceId: string; lockedReason: string | null };

async function appForCleanup(ex: Executor, appId: string, lock: boolean): Promise<Locked> {
  const q = ex.select({ slug: apps.slug, workspaceId: apps.workspaceId, lockedReason: apps.lockedReason }).from(apps).where(eq(apps.id, appId));
  const [app] = lock ? await q.for('update') : await q;
  if (!app) throw new AppsError('not_found', `App ${appId} does not exist.`);
  if (app.lockedReason !== null) throw lockedByAdminError(app.lockedReason);
  return app;
}

function cleanupScope(upTo: number, opts: VersionDeletionOptions): SQL {
  if (!Number.isSafeInteger(upTo)) throw new RangeError('upTo must be an integer version number');
  return opts.failedOnly ? sql`v.number <= ${upTo} AND v.compile_status = 'error'` : sql`v.number <= ${upTo}`;
}

/** Of the versions in scope, the numbers that may go and the reason each other one stays. */
async function classify(ex: Executor, appId: string, scope: SQL): Promise<{ free: number[]; skipped: Partial<Record<VersionProtection, string[]>> }> {
  const res = await ex.execute(sql`
    SELECT v.number, ${protectionReason(appId)} AS reason FROM app_versions v
    WHERE v.app_id = ${appId} AND ${scope}
    ORDER BY v.number`);
  const free: number[] = [];
  const byReason = new Map<VersionProtection, number[]>();
  for (const r of rowsOf<{ number: number; reason: VersionProtection | null }>(res)) {
    if (r.reason === null) free.push(Number(r.number));
    else byReason.set(r.reason, [...(byReason.get(r.reason) ?? []), Number(r.number)]);
  }
  const skipped: Partial<Record<VersionProtection, string[]>> = {};
  for (const [reason, numbers] of byReason) skipped[reason] = versionRanges(numbers);
  return { free, skipped };
}

/**
 * What `deleteVersions` would do now: the versions up to `upTo` (only the
 * failed builds with `failedOnly`) that would go and why the others stay.
 * Deletes nothing; refuses like `deleteVersions` (`not_found`,
 * `app_locked_by_admin`).
 */
export async function planVersionDeletion(appId: string, upTo: number, opts: VersionDeletionOptions = {}): Promise<VersionDeletion> {
  const db = getDb();
  await appForCleanup(db, appId, false);
  const { free, skipped } = await classify(db, appId, cleanupScope(upTo, opts));
  return { deleted: versionRanges(free), count: free.length, skipped, planId: planIdOf(free) };
}

/**
 * A member's clean-up: delete the app's versions up to `upTo` (only the failed
 * builds with `failedOnly`) except those that stay (`VersionProtection`), in
 * batches under the app's row lock like the retention. Each batch is audited
 * `app.versions.delete` (meta: count, from, to, failedOnly); the version hosts
 * of the deleted versions stop answering at once. The freed bytes stop
 * counting against WORKSPACE_SOURCE_QUOTA. A taken-down app refuses with
 * `app_locked_by_admin`.
 *
 * The set that may go is worked out once, under the row lock of the first
 * batch, and no batch deletes outside it. With `expectedPlanId` that set must
 * be the one the member confirmed (`planVersionDeletion`'s `planId`);
 * otherwise nothing is deleted and the call refuses with `plan_changed`.
 */
export async function deleteVersions(
  appId: string,
  upTo: number,
  opts: VersionDeletionOptions,
  actor: Actor
): Promise<VersionDeletion> {
  const scope = cleanupScope(upTo, opts);
  const deleted: number[] = [];
  let skipped: Partial<Record<VersionProtection, string[]>> = {};
  let planned: number[] = [];
  let slug = '';
  for (let first = true; ; first = false) {
    const numbers = await getDb().transaction(async (tx) => {
      const app = await appForCleanup(tx, appId, true);
      slug = app.slug;
      if (first) {
        const plan = await classify(tx, appId, scope);
        if (opts.expectedPlanId !== undefined && opts.expectedPlanId !== planIdOf(plan.free)) {
          throw new AppsError(
            'plan_changed',
            'The versions this clean-up would delete changed since the plan was made (a version was written, published, kept or deleted in between); nothing was deleted.'
          );
        }
        skipped = plan.skipped;
        planned = plan.free;
      }
      if (planned.length === 0) return [];
      const batch = await deleteBatch(tx, appId, sql`${scope} AND v.number IN (${sql.join(planned.map((n) => sql`${n}`), sql`, `)})`);
      if (batch.length > 0) {
        await writeAudit(
          {
            workspaceId: app.workspaceId,
            actorUserId: actor.userId,
            actorKind: actor.kind,
            action: AUDIT_ACTIONS.appVersionsDelete,
            subjectType: 'app',
            target: app.slug,
            meta: { appId, count: batch.length, from: batch[0], to: batch[batch.length - 1], failedOnly: opts.failedOnly === true },
          },
          tx
        );
      }
      return batch;
    });
    deleted.push(...numbers);
    if (numbers.length < PRUNE_BATCH) break;
  }
  if (deleted.length > 0) await notifyAppChanged({ app_id: appId, slug, kind: 'version' });
  return { deleted: versionRanges(deleted), count: deleted.length, skipped, planId: planIdOf(planned) };
}

/** The hourly retention in the server process, under a Redis lease. Returns a stop function. */
export function startVersionRetention(opts: Omit<PruneVersionHistoryOptions, 'log'> & { log: (msg: string, errorText?: string) => void }): () => void {
  const run = async () => {
    try {
      const out = await withRedisLock(LOCK_KEY, Math.floor(VERSION_RETENTION_INTERVAL_MS / 1000) - 60, () => pruneVersionHistory(opts));
      if (!out.acquired) return;
      const r = out.result;
      if (r.versions > 0) opts.log(`version retention: deleted ${r.versions} old version(s) of ${r.apps} app(s)`);
      if (r.skipped > 0) opts.log(`version retention: left ${r.skipped} app(s) alone — their workspace's limits were unavailable`);
    } catch (err) {
      opts.log('version retention failed', dbErrorForLog(err));
    }
  };
  const timer = setInterval(() => void run(), VERSION_RETENTION_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
