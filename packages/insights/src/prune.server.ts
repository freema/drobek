/**
 * The get_logs retention prune (NSO-327): a periodic job in the server process
 * (apps/server jobs, one replica per interval via a Redis lease) that keeps
 * every get_logs table inside its retention for EVERY app — also for apps
 * nobody inspects. Reads never delete.
 *
 *  - `app_errors` (the browser errors of the beacon): older than
 *    BEACON_RETENTION_DAYS (30), and past the newest BEACON_MAX_EVENTS_PER_APP
 *    (500) of each app — the beacon also trims its app on insert;
 *  - `app_compiles`: older than LOGS_RETENTION_DAYS (30) — the newest 200 per
 *    app are kept by recordCompile on insert;
 *  - `app_daily_stats` / `module_request_stats`: days older than
 *    LOGS_RETENTION_DAYS (30).
 *
 * LOGS_PRUNE_INTERVAL_MS (1 h) is the operator's.
 */
import { lt, sql } from 'drizzle-orm';
import { appCompiles, appDailyStats, appErrors, getDb, moduleRequestStats } from '@drobek/db';
import { LOGS_RETENTION_DAYS, beaconLimitsFromEnv } from './limits.js';
import { utcDay } from './signals.server.js';

export const DEFAULT_LOGS_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_KEY = 'drobek:lock:logs-prune';

/** LOGS_PRUNE_INTERVAL_MS (the production default when unset or invalid). */
export function logsPruneIntervalFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LOGS_PRUNE_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_LOGS_PRUNE_INTERVAL_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LOGS_PRUNE_INTERVAL_MS;
}

/** Rows removed by one prune, per table. */
export interface LogsPruneResult {
  errors: number;
  compiles: number;
  dailyStats: number;
  moduleStats: number;
}

/** One pass over every app (no per-app loop: four age deletes + one rank delete). */
export async function pruneLogs(opts: { now?: Date; env?: NodeJS.ProcessEnv } = {}): Promise<LogsPruneResult> {
  const now = opts.now ?? new Date();
  const limits = beaconLimitsFromEnv(opts.env);
  const db = getDb();

  const errorCutoff = new Date(now.getTime() - limits.retentionDays * DAY_MS);
  const aged = await db.delete(appErrors).where(lt(appErrors.createdAt, errorCutoff)).returning({ id: appErrors.id });
  // The newest N of each app survive (ties on created_at broken by id, stable).
  const overCap = await db
    .delete(appErrors)
    .where(
      sql`${appErrors.id} in (
        select id from (
          select id, row_number() over (partition by app_id order by created_at desc, id desc) as rn from app_errors
        ) ranked where rn > ${limits.maxEventsPerApp}
      )`
    )
    .returning({ id: appErrors.id });

  const logsCutoff = new Date(now.getTime() - LOGS_RETENTION_DAYS * DAY_MS);
  const oldestDay = utcDay(logsCutoff);
  const compiles = await db.delete(appCompiles).where(lt(appCompiles.createdAt, logsCutoff)).returning({ id: appCompiles.id });
  const dailyStats = await db.delete(appDailyStats).where(lt(appDailyStats.day, oldestDay)).returning({ appId: appDailyStats.appId });
  const moduleStats = await db
    .delete(moduleRequestStats)
    .where(lt(moduleRequestStats.day, oldestDay))
    .returning({ appId: moduleRequestStats.appId });

  return {
    errors: aged.length + overCap.length,
    compiles: compiles.length,
    dailyStats: dailyStats.length,
    moduleStats: moduleStats.length,
  };
}

/** Run `fn` on one replica only (the server passes `withRedisLock` from @drobek/apps). */
export type LogsPruneLease = <T>(key: string, ttlSec: number, fn: () => Promise<T>) => Promise<{ acquired: true; result: T } | { acquired: false }>;

/**
 * The periodic prune in the server process (every LOGS_PRUNE_INTERVAL_MS).
 * Returns a stop function.
 */
export function startLogsPrune(opts: {
  log: (msg: string, err?: unknown) => void;
  lease?: LogsPruneLease;
  env?: NodeJS.ProcessEnv;
}): () => void {
  const intervalMs = logsPruneIntervalFromEnv(opts.env);
  const once = () => pruneLogs({ env: opts.env });
  const run = async () => {
    try {
      const out = opts.lease
        ? await opts.lease(LOCK_KEY, Math.max(1, Math.floor(intervalMs / 1000) - 60), once)
        : { acquired: true as const, result: await once() };
      if (out.acquired) {
        const r = out.result;
        if (r.errors + r.compiles + r.dailyStats + r.moduleStats > 0) {
          opts.log(
            `logs prune: removed ${r.errors} browser error(s), ${r.compiles} compile(s), ${r.dailyStats} daily stat row(s), ${r.moduleStats} module stat row(s)`
          );
        }
      }
    } catch (err) {
      opts.log('logs prune failed', err);
    }
  };
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
