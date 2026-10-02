/**
 * How much version history drobek keeps:
 *
 *   APP_VERSIONS_KEEP       the newest versions of each app the retention
 *                           keeps (default 200)
 *   WORKSPACE_SOURCE_QUOTA  bytes of the unique files (sources and their
 *                           built output) the versions of a workspace's live
 *                           apps may store (default 1 GiB)
 *
 * The retention (`pruneVersionHistory`, hourly under a Redis lease) deletes
 * the versions of an app older than its newest APP_VERSIONS_KEEP — never the
 * published version, a version whose asset set is kept for a rollback
 * (`assets_frozen_at`), the newest version that compiled (the one the preview
 * serves) or a version from the last hour (it still counts against the hourly
 * version rate). Each app is pruned under its row lock, so a write, restore or
 * publish never sees half of it; `version_files` go with their version
 * (cascade) and the blob GC removes the bytes nothing references any more.
 * Every prune is audited `app.versions.prune` (a system action).
 *
 * The quota is checked when a version is stored (`createVersion`, after the
 * app's row lock, under a per-workspace advisory lock so parallel writes in
 * one workspace cannot overshoot it): a version whose NEW unique bytes would
 * take the workspace past WORKSPACE_SOURCE_QUOTA is refused with
 * `limit_exceeded` and nothing is stored. A version that adds no bytes (a
 * restore, a revert) always fits. Deleted apps do not count.
 *
 * Both are in the limits catalogue (`CORE_LIMITS`, @drobek/modules), so a
 * limits provider can set them per workspace. The retention leaves a
 * workspace alone while the provider does not answer: the env fallback never
 * deletes history a plan keeps.
 */
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { AUDIT_ACTIONS, writeAudit } from '@drobek/audit';
import { appVersions, apps, dbErrorForLog, getDb, type DB } from '@drobek/db';
import { AppsError } from './errors.js';
import { notifyAppChanged } from './events.js';
import { withRedisLock } from './lock.server.js';
import { VERSION_RATE_WINDOW_SEC } from './version-rate.server.js';

export const DEFAULT_APP_VERSIONS_KEEP = 200;
export const DEFAULT_WORKSPACE_SOURCE_QUOTA = 1024 * 1024 * 1024;
export const VERSION_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** Versions one transaction of the retention deletes at most (the app's row lock is held meanwhile). */
const PRUNE_BATCH = 200;
const LOCK_KEY = 'drobek:lock:version-retention';

export interface VersionStorageLimits {
  /** APP_VERSIONS_KEEP */
  keep: number;
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
    sourceQuota: positiveInt(limits.WORKSPACE_SOURCE_QUOTA, base.sourceQuota),
  };
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
 * Why the app has no version `number`: it never existed, or the retention
 * deleted it (version numbers are never reused, so a missing number below the
 * newest one was deleted). `keep` = the workspace's APP_VERSIONS_KEEP, when
 * the caller knows it.
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
  return `Version ${number} is no longer stored: the history retention deleted it. An app keeps ${newest}, the published one and those kept for a rollback; the oldest version still stored is ${info.oldest}.`;
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
    const res = await tx.execute(sql`
      DELETE FROM app_versions WHERE id IN (
        SELECT v.id FROM app_versions v
        WHERE v.app_id = ${appId}
          AND v.number <= (SELECT max(number) FROM app_versions WHERE app_id = ${appId}) - ${keep}
          AND v.assets_frozen_at IS NULL
          AND v.id IS DISTINCT FROM (SELECT published_version_id FROM apps WHERE id = ${appId})
          AND v.id IS DISTINCT FROM (
            SELECT id FROM app_versions WHERE app_id = ${appId} AND compile_status = 'ok' ORDER BY number DESC LIMIT 1
          )
          AND v.created_at < localtimestamp - make_interval(secs => ${VERSION_RATE_WINDOW_SEC})
        ORDER BY v.number
        LIMIT ${PRUNE_BATCH}
      )
      RETURNING number`);
    const numbers = rowsOf<{ number: number }>(res)
      .map((r) => Number(r.number))
      .sort((a, b) => a - b);
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
