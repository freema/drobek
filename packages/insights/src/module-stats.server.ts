/**
 * Module request counters (get_logs `requests`, NSO-323 M3): one response of
 * `/__drobek/v1/<module>/…` is counted in REDIS — one hash per app and UTC day
 * (`drobek:signals:mod:<app_id>:<day>`, field `<module>:<status class>`,
 * TTL'd like the serving signals) — never with a SQL statement per request.
 * The durable `module_request_stats` rows are written lazily:
 *
 *  - by the read (`queryRequestLog` flushes every day of its window), and
 *  - by the counter itself at most once per `MODULE_STATS_FLUSH_SEC` per app
 *    and day (a `SET NX EX` marker, `drobek:signals:modflush:<app_id>:<day>`),
 *    so the table stays fresh without a reader.
 *
 * The Redis counters are cumulative for the day, so a flush writes the totals;
 * `greatest()` keeps a row from going backwards when Redis lost its counters
 * (a flush of a restarted Redis only catches up once it passes the row).
 * Everything here is best-effort: a Redis or database error is swallowed so a
 * module response is never affected.
 */
import { sql } from 'drizzle-orm';
import { getRedis } from '@drobek/core';
import { getDb, moduleRequestStats } from '@drobek/db';
import { LOGS_RETENTION_DAYS } from './limits.js';
import { STATUS_CLASSES, statusClass, type StatusClass } from './logs.js';
import { utcDay } from './signals.server.js';

/** A counted day flushes into Postgres at most this often (seconds) — plus on every get_logs read. */
const MODULE_STATS_FLUSH_SEC = 60;
// The counters outlive the get_logs window so every day of it can still be flushed.
const MODULE_STATS_TTL_SEC = (LOGS_RETENTION_DAYS + 1) * 24 * 60 * 60;

/** The Redis commands the counters use (ioredis satisfies it). */
export interface ModuleStatsRedis {
  hincrby(key: string, field: string, n: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  expire(key: string, sec: number): Promise<number>;
  set(key: string, value: string, ex: 'EX', sec: number, nx: 'NX'): Promise<'OK' | null>;
}

export interface ModuleStatsOptions {
  now?: Date;
  /** The Redis to count in (default: the shared client). */
  redis?: () => ModuleStatsRedis;
  /** Flush a counted day at most every N seconds; 0 flushes on every count (tests). */
  flushEverySec?: number;
}

const sharedRedis = () => getRedis() as unknown as ModuleStatsRedis;

function countersKey(appId: string, day: string): string {
  return `drobek:signals:mod:${appId}:${day}`;
}
function flushMarkerKey(appId: string, day: string): string {
  return `drobek:signals:modflush:${appId}:${day}`;
}

/**
 * Count one module response of `appId`. Called by the module runtime for every
 * response of a MATCHED route of an active module (never a 429 or an unknown
 * route — the runtime filters those); best-effort, never throws.
 */
export async function recordModuleRequest(appId: string, module: string, status: number, opts: ModuleStatsOptions = {}): Promise<void> {
  try {
    const r = (opts.redis ?? sharedRedis)();
    const day = utcDay(opts.now ?? new Date());
    const key = countersKey(appId, day);
    if ((await r.hincrby(key, `${module}:${statusClass(status)}`, 1)) === 1) await r.expire(key, MODULE_STATS_TTL_SEC);
    const every = opts.flushEverySec ?? MODULE_STATS_FLUSH_SEC;
    if (every <= 0 || (await r.set(flushMarkerKey(appId, day), '1', 'EX', every, 'NX')) === 'OK') {
      await flushModuleRequests(appId, day, opts);
    }
  } catch {
    /* stats are best-effort */
  }
}

/**
 * Write the Redis totals of one app and day into `module_request_stats` (one
 * statement, idempotent). Best-effort; a day with no counters writes nothing.
 */
export async function flushModuleRequests(appId: string, day: string, opts: Pick<ModuleStatsOptions, 'redis'> = {}): Promise<void> {
  try {
    const counters = await (opts.redis ?? sharedRedis)().hgetall(countersKey(appId, day));
    const rows: { appId: string; module: string; statusClass: StatusClass; day: string; count: number }[] = [];
    for (const [field, raw] of Object.entries(counters ?? {})) {
      const at = field.lastIndexOf(':');
      const module = field.slice(0, at);
      const cls = field.slice(at + 1) as StatusClass;
      const count = Number(raw);
      if (at <= 0 || !STATUS_CLASSES.includes(cls) || !Number.isInteger(count) || count <= 0) continue;
      rows.push({ appId, module, statusClass: cls, day, count });
    }
    if (rows.length === 0) return;
    await getDb()
      .insert(moduleRequestStats)
      .values(rows)
      .onConflictDoUpdate({
        target: [moduleRequestStats.appId, moduleRequestStats.module, moduleRequestStats.statusClass, moduleRequestStats.day],
        set: { count: sql`greatest(${moduleRequestStats.count}, excluded.count)` },
      });
  } catch {
    /* a flush miss is caught up by the next flush (the counters are cumulative) */
  }
}

/** An in-process stand-in for the commands above (tests; `now` is the clock seam). */
export function memoryModuleStatsRedis(now: () => number = Date.now): ModuleStatsRedis {
  const hashes = new Map<string, Map<string, string>>();
  const expiry = new Map<string, number>();
  const strings = new Map<string, string>();
  const live = (k: string) => {
    const exp = expiry.get(k);
    if (exp !== undefined && exp <= now()) {
      hashes.delete(k);
      strings.delete(k);
      expiry.delete(k);
    }
  };
  return {
    async hincrby(k: string, field: string, n: number) {
      live(k);
      const h = hashes.get(k) ?? new Map<string, string>();
      hashes.set(k, h);
      const v = Number(h.get(field) ?? 0) + n;
      h.set(field, String(v));
      return v;
    },
    async hgetall(k: string) {
      live(k);
      return Object.fromEntries(hashes.get(k) ?? []);
    },
    async expire(k: string, sec: number) {
      live(k);
      if (!hashes.has(k) && !strings.has(k)) return 0;
      expiry.set(k, now() + sec * 1000);
      return 1;
    },
    async set(k: string, v: string, _ex: 'EX', sec: number, _nx: 'NX') {
      live(k);
      if (strings.has(k)) return null;
      strings.set(k, v);
      expiry.set(k, now() + sec * 1000);
      return 'OK' as const;
    },
  };
}
