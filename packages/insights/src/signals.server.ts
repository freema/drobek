/**
 * Server-side serving signals (PHY-123): cheap, best-effort per-app+per-day
 * counters kept in Redis on the U7 serving path — request volume, 5xx faults,
 * and 404s-by-path. Redis is the hot counter (drobek:signals:*, TTL'd so it
 * self-evicts as a rolling window); `flushDay` mirrors the current day into the
 * durable `app_daily_stats` table so app_logs reads survive a Redis flush.
 *
 * incrementServingSignal is called from @drobek/serving and MUST never throw or
 * block the response — every path is wrapped and swallows its own errors.
 */
import { getRedis } from '@drobek/core';
import { appDailyStats, getDb } from '@drobek/db';
import { DEFAULT_RETENTION_DAYS } from './limits.js';

export type ServingSignalKind = 'request' | '5xx' | '404';

/** Cap distinct 404 paths tracked per app/day (bounds hash cardinality). */
const MAX_404_KEYS = 200;
const OTHER_404 = '__other__';
const MAX_404_PATH_LEN = 256;

const SIGNAL_TTL_SEC = (DEFAULT_RETENTION_DAYS + 1) * 24 * 60 * 60;

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

/** Normalize an untrusted request path into a bounded 404 hash field. */
function normalize404Path(path: string | undefined): string {
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
    } else {
      const k = paths404Key(appId, day);
      let field = normalize404Path(path);
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

/**
 * Persist the current day's Redis counters into app_daily_stats (idempotent
 * upsert on (app_id, day)). Best-effort; called on the read path so the durable
 * table is fresh when app_logs is queried. Redis counters are cumulative for the
 * day, so overwriting the row with the totals is correct.
 */
export async function flushDay(appId: string, day: string): Promise<void> {
  try {
    const r = getRedis();
    const [req, c5, p404] = await Promise.all([
      r.get(reqKey(appId, day)),
      r.get(fault5xxKey(appId, day)),
      r.hgetall(paths404Key(appId, day)),
    ]);
    const path404Counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(p404)) path404Counts[k] = Number(v) || 0;
    if (req === null && c5 === null && Object.keys(path404Counts).length === 0) {
      return; // nothing recorded for this day
    }
    const requestCount = Number(req) || 0;
    const count5xx = Number(c5) || 0;
    await getDb()
      .insert(appDailyStats)
      .values({ appId, day, requestCount, count5xx, path404Counts })
      .onConflictDoUpdate({
        target: [appDailyStats.appId, appDailyStats.day],
        set: { requestCount, count5xx, path404Counts, updatedAt: new Date() },
      });
  } catch {
    /* durability backstop — a flush miss is bounded by the Redis window */
  }
}
