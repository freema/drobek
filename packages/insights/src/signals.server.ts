/**
 * Server-side serving signals: cheap, best-effort per-app+per-day
 * counters kept in Redis on the serving path — request volume, 5xx faults,
 * and 404s-by-path. Redis is the hot counter (drobek:signals:*, TTL'd so it
 * self-evicts as a rolling window); `flushDay` mirrors the current day into the
 * durable `app_daily_stats` table so app_logs reads survive a Redis flush.
 *
 * The failing paths of get_logs('requests') that are not a file 404
 * — a platform 4xx and every 5xx — live only in Redis: one hash per status
 * class, app and day (`drobek:signals:fail:<class>:<app_id>:<day>`, field =
 * the normalized path), capped at MAX_FAIL_PATH_KEYS distinct paths (the rest
 * funnel into `__other__`) and TTL'd like the counters, so they cover the whole
 * get_logs window. The file 404s keep their durable `path_404_counts`.
 *
 * incrementServingSignal is called from @drobek/serving and MUST never throw or
 * block the response — every path is wrapped and swallows its own errors.
 */
import { sql } from 'drizzle-orm';
import { getRedis } from '@drobek/core';
import { appDailyStats, getDb } from '@drobek/db';
import { LOGS_RETENTION_DAYS } from './limits.js';

/** `4xx` records only the path of a platform 4xx (the 4xx count lives in the module stats). */
export type ServingSignalKind = 'request' | '5xx' | '404' | '4xx';

/** Cap distinct 404 paths tracked per app/day (bounds hash cardinality). */
const MAX_404_KEYS = 200;
const OTHER_404 = '__other__';
const MAX_404_PATH_LEN = 256;
/** Cap distinct failing paths (platform 4xx / 5xx) tracked per class, app and day. */
export const MAX_FAIL_PATH_KEYS = 100;

export type FailClass = '4xx' | '5xx';

// The hot counters outlive the get_logs window so every day of it can
// still be flushed into app_daily_stats when it is read.
const SIGNAL_TTL_SEC = (LOGS_RETENTION_DAYS + 1) * 24 * 60 * 60;

/** UTC calendar day `YYYY-MM-DD` — the per-day bucket key. */
export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function reqKey(appId: string, day: string): string {
  return `drobek:signals:req:${appId}:${day}`;
}
function fault5xxKey(appId: string, day: string): string {
  return `drobek:signals:5xx:${appId}:${day}`;
}
function paths404Key(appId: string, day: string): string {
  return `drobek:signals:404:${appId}:${day}`;
}

/** The Redis hash of one app's failing paths of one status class on one UTC day. */
export function failPathsKey(cls: FailClass, appId: string, day: string): string {
  return `drobek:signals:fail:${cls}:${appId}:${day}`;
}

/** The three Redis counters of one app and day (request count, 5xx count, 404-by-path hash). */
export function servingSignalKeys(appId: string, day: string): { req: string; fault5xx: string; paths404: string } {
  return { req: reqKey(appId, day), fault5xx: fault5xxKey(appId, day), paths404: paths404Key(appId, day) };
}

/** One `app_daily_stats` row. */
export interface DailyStatsRow {
  appId: string;
  day: string;
  requestCount: number;
  count5xx: number;
  path404Counts: Record<string, number>;
}

/** The row of one day's Redis counters, or null when nothing was recorded that day. */
export function dailyStatsRow(
  appId: string,
  day: string,
  req: string | null,
  c5: string | null,
  p404: Record<string, string> | null
): DailyStatsRow | null {
  const path404Counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(p404 ?? {})) path404Counts[k] = Number(v) || 0;
  if (req === null && c5 === null && Object.keys(path404Counts).length === 0) return null;
  return { appId, day, requestCount: Number(req) || 0, count5xx: Number(c5) || 0, path404Counts };
}

/**
 * Upsert day rows into app_daily_stats in ONE statement (idempotent on
 * (app_id, day)). The Redis counters are cumulative for the day, so the row
 * takes the totals — but never lowers a stored count: each count, and each
 * path's 404 count, keeps the larger of the stored and the flushed value, so
 * counters that restart after a Redis flush cannot shrink a stored day.
 */
export async function upsertDailyStats(rows: DailyStatsRow[]): Promise<void> {
  if (rows.length === 0) return;
  await getDb()
    .insert(appDailyStats)
    .values(rows)
    .onConflictDoUpdate({
      target: [appDailyStats.appId, appDailyStats.day],
      set: {
        requestCount: sql`greatest(${appDailyStats.requestCount}, excluded.request_count)`,
        count5xx: sql`greatest(${appDailyStats.count5xx}, excluded.count_5xx)`,
        path404Counts: sql`(
          select coalesce(jsonb_object_agg(k, greatest(
            coalesce((${appDailyStats.path404Counts} ->> k)::numeric, 0),
            coalesce((excluded.path_404_counts ->> k)::numeric, 0)
          )), '{}'::jsonb)
          from (
            select jsonb_object_keys(${appDailyStats.path404Counts}) as k
            union
            select jsonb_object_keys(excluded.path_404_counts)
          ) as paths
        )`,
        updatedAt: new Date(),
      },
    });
}

/** Normalize an untrusted request path into a bounded hash field (no query, no fragment). */
export function normalizeSignalPath(path: string | undefined): string {
  if (!path) return '/';
  let p = path.split('?')[0].split('#')[0];
  if (!p.startsWith('/')) p = `/${p}`;
  return p.slice(0, MAX_404_PATH_LEN);
}

/**
 * Increment one serving counter for the current UTC day. Best-effort: any Redis
 * error is swallowed so the serve response is never affected.
 */
export async function incrementServingSignal(
  appId: string,
  kind: ServingSignalKind,
  path?: string
): Promise<void> {
  try {
    const r = getRedis();
    const day = utcDay();
    if (kind === 'request') {
      const k = reqKey(appId, day);
      const n = await r.incr(k);
      if (n === 1) await r.expire(k, SIGNAL_TTL_SEC);
    } else if (kind === '5xx') {
      const k = fault5xxKey(appId, day);
      const n = await r.incr(k);
      if (n === 1) await r.expire(k, SIGNAL_TTL_SEC);
      if (path !== undefined) await recordFailingPath(appId, '5xx', path, { redis: () => r as unknown as FailPathsRedis, day });
    } else if (kind === '4xx') {
      if (path !== undefined) await recordFailingPath(appId, '4xx', path, { redis: () => r as unknown as FailPathsRedis, day });
    } else {
      const k = paths404Key(appId, day);
      let field = normalizeSignalPath(path);
      // Bound cardinality: once the hash is full, funnel new paths to __other__.
      const exists = await r.hexists(k, field);
      if (!exists && (await r.hlen(k)) >= MAX_404_KEYS) field = OTHER_404;
      await r.hincrby(k, field, 1);
      await r.expire(k, SIGNAL_TTL_SEC);
    }
  } catch {
    /* signals are best-effort — never fail the serving response */
  }
}

/** The Redis commands the failing-path hashes use (ioredis satisfies it). */
export interface FailPathsRedis {
  hexists(key: string, field: string): Promise<number>;
  hlen(key: string): Promise<number>;
  hincrby(key: string, field: string, n: number): Promise<number>;
  expire(key: string, sec: number): Promise<number>;
}

/**
 * Count one failing request path of `appId` under its status class for the
 * current UTC day: the path is normalized (no query, no fragment, ≤ 256
 * chars), a new path past MAX_FAIL_PATH_KEYS counts as `__other__`.
 * Best-effort, never throws.
 */
export async function recordFailingPath(
  appId: string,
  cls: FailClass,
  path: string,
  opts: { redis?: () => FailPathsRedis; day?: string } = {}
): Promise<void> {
  try {
    const r = (opts.redis ?? (() => getRedis() as unknown as FailPathsRedis))();
    const k = failPathsKey(cls, appId, opts.day ?? utcDay());
    let field = normalizeSignalPath(path);
    if (!(await r.hexists(k, field)) && (await r.hlen(k)) >= MAX_FAIL_PATH_KEYS) field = OTHER_404;
    if ((await r.hincrby(k, field, 1)) === 1) await r.expire(k, SIGNAL_TTL_SEC);
  } catch {
    /* signals are best-effort */
  }
}

/**
 * Persist the current day's Redis counters into app_daily_stats (idempotent
 * upsert on (app_id, day)). Best-effort; called on the read path so the durable
 * table is fresh when app_logs is queried. Redis counters are cumulative for the
 * day, so the row takes the totals (never lower than what it already holds).
 */
export async function flushDay(appId: string, day: string): Promise<void> {
  try {
    const r = getRedis();
    const k = servingSignalKeys(appId, day);
    const [req, c5, p404] = await Promise.all([r.get(k.req), r.get(k.fault5xx), r.hgetall(k.paths404)]);
    const row = dailyStatsRow(appId, day, req, c5, p404);
    if (row) await upsertDailyStats([row]);
  } catch {
    /* durability backstop — a flush miss is bounded by the Redis window */
  }
}
