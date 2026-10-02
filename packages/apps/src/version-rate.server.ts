/**
 * The rate limit on new versions. A new version is a row and, for a write, up
 * to COMPILE_MAX_TOTAL_BYTES of new blobs in Postgres, so they are capped:
 *
 *   VERSIONS_PER_APP_HOUR   versions of one app within the last hour (default 600)
 *   VERSIONS_PER_USER_HOUR  versions one person made within the last hour, in
 *                           every app and workspace (default 1200)
 *
 * Every new version counts: write_files and create_app's version 1, a restore
 * (MCP or the dashboard), a gallery copy. Past either limit the call answers
 * `rate_limited` with `retry_after_seconds` — when the oldest version of the
 * full window leaves it — and nothing is stored.
 *
 * createVersion and restore check inside their transaction, after the app's
 * row lock (one app's versions are serialized) and under a per-person advisory
 * lock, so parallel writes cannot overshoot either limit. `assertVersionRate`
 * is the same check ahead of expensive work (the compile, a new app row). The
 * window runs on the database clock, like `app_versions.created_at`.
 *
 * Both are in the limits catalogue (`CORE_LIMITS`, @drobek/modules), so a
 * limits provider can set them per workspace: callers pass the values of the
 * workspace of the app being written (`versionRateLimitsOf`), which also caps
 * the person's versions there.
 */
import { desc, eq, sql, type SQL } from 'drizzle-orm';
import { appVersions, getDb, type DB } from '@drobek/db';
import { AppsError } from './errors.js';

export const DEFAULT_VERSIONS_PER_APP_HOUR = 600;
export const DEFAULT_VERSIONS_PER_USER_HOUR = 1200;
/** The window both limits count in. */
export const VERSION_RATE_WINDOW_SEC = 3600;

export interface VersionRateLimits {
  /** VERSIONS_PER_APP_HOUR */
  perApp: number;
  /** VERSIONS_PER_USER_HOUR */
  perUser: number;
}

type Executor = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

function positiveInt(raw: unknown, fallback: number): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** The server-wide limits (no workspace): the env, else the defaults. */
export function versionRateLimits(env: NodeJS.ProcessEnv = process.env): VersionRateLimits {
  return {
    perApp: positiveInt(env.VERSIONS_PER_APP_HOUR, DEFAULT_VERSIONS_PER_APP_HOUR),
    perUser: positiveInt(env.VERSIONS_PER_USER_HOUR, DEFAULT_VERSIONS_PER_USER_HOUR),
  };
}

/** A workspace's limits as the module runtime answers them (`workspaceLimits`); a missing value falls back to the env. */
export function versionRateLimitsOf(limits: Readonly<Record<string, number>>, env: NodeJS.ProcessEnv = process.env): VersionRateLimits {
  const base = versionRateLimits(env);
  return {
    perApp: positiveInt(limits.VERSIONS_PER_APP_HOUR, base.perApp),
    perUser: positiveInt(limits.VERSIONS_PER_USER_HOUR, base.perUser),
  };
}

/**
 * Seconds until the `max`-th newest version of `where` (by `order`) leaves the
 * window; 0 when there are fewer, or it is already out — another version fits.
 */
async function windowFull(db: Executor, where: SQL | undefined, order: SQL, max: number): Promise<number> {
  const [row] = await db
    .select({
      seconds: sql<number>`ceil(extract(epoch from ${appVersions.createdAt} + make_interval(secs => ${VERSION_RATE_WINDOW_SEC}) - localtimestamp))::int`.mapWith(Number),
    })
    .from(appVersions)
    .where(where)
    .orderBy(order)
    .offset(max - 1)
    .limit(1);
  return row && row.seconds > 0 ? row.seconds : 0;
}

function refusal(limit: 'VERSIONS_PER_APP_HOUR' | 'VERSIONS_PER_USER_HOUR', max: number, retryAfter: number): AppsError {
  const who =
    limit === 'VERSIONS_PER_APP_HOUR'
      ? `This app got ${max} new versions within the last hour`
      : `You made ${max} new versions within the last hour, across all your apps`;
  return new AppsError('rate_limited', `${who} (${limit}) — nothing was stored. Try again in ${Math.ceil(retryAfter / 60)} min.`, {
    details: { limit, value: max, retry_after_seconds: retryAfter },
  });
}

async function check(db: Executor, target: { appId?: string; userId: string | null }, limits: VersionRateLimits): Promise<void> {
  if (target.appId) {
    const wait = await windowFull(db, eq(appVersions.appId, target.appId), desc(appVersions.number), limits.perApp);
    if (wait > 0) throw refusal('VERSIONS_PER_APP_HOUR', limits.perApp, wait);
  }
  if (target.userId) {
    const wait = await windowFull(db, eq(appVersions.createdByUserId, target.userId), desc(appVersions.createdAt), limits.perUser);
    if (wait > 0) throw refusal('VERSIONS_PER_USER_HOUR', limits.perUser, wait);
  }
}

/**
 * `rate_limited` when one more version of `appId` (when given) or by
 * `userId` (when not null) would pass its limit — the check ahead of work
 * whose result createVersion / restore would refuse.
 */
export async function assertVersionRate(
  target: { appId?: string; userId: string | null },
  limits: VersionRateLimits = versionRateLimits()
): Promise<void> {
  await check(getDb(), target, limits);
}

/** The check inside createVersion / restore, after the app's row lock: the person's versions are serialized too. */
export async function assertVersionRateLocked(
  tx: Executor,
  appId: string,
  userId: string | null,
  limits: VersionRateLimits
): Promise<void> {
  if (userId) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`drobek:versions:${userId}`}::text))`);
  await check(tx, { appId, userId }, limits);
}
