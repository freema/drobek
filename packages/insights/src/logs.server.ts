/**
 * get_logs (M1-07) — the stored half, over a RESOLVED app id (the MCP tool
 * authorizes the caller for the app first):
 *
 *  - recordCompile       — one `app_compiles` row per compile a write ran
 *                          (create_app / write_files; ok, failed or refused),
 *                          pruned to 30 days / the newest 200 per app;
 *  - (module request counters live in module-stats.server.ts — Redis, flushed
 *    into `module_request_stats` lazily and by queryRequestLog);
 *  - queryRuntimeLog / queryCompileLog / queryRequestLog — the three kinds.
 *
 * Every read is bounded to the retention window (30 days) and ≤ 100 entries.
 * Reads never delete: the periodic prune (prune.server.ts) keeps every table
 * inside its retention, also for apps nobody inspects (NSO-327).
 */
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { getRedis } from '@drobek/core';
import { appCompiles, appDailyStats, appErrors, getDb, moduleRequestStats } from '@drobek/db';
import { COMPILE_HISTORY_KEEP, LOGS_RETENTION_DAYS } from './limits.js';
import {
  COMPILE_LOG_LIMIT,
  capCompileErrors,
  compileEntries,
  daysBetween,
  requestEntries,
  runtimeEntries,
  type CompileEntry,
  type RequestsEntry,
  type RuntimeEntry,
} from './logs.js';
import { dedupErrors } from './shape.js';
import { moduleCountersKey, moduleStatRows, upsertModuleStats, type ModuleStatsRow } from './module-stats.server.js';
import { dailyStatsRow, servingSignalKeys, upsertDailyStats, utcDay, type DailyStatsRow } from './signals.server.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows scanned for the runtime dedup — the ring buffer keeps ≤ 500 per app anyway. */
const RUNTIME_SCAN_LIMIT = 1000;

/**
 * The start of a get_logs window: `since` when it is valid and inside the
 * retention window, else the start of the retention window (30 days back).
 */
export function logsWindowStart(since: Date | string | null | undefined, now: Date = new Date()): Date {
  const floor = new Date(now.getTime() - LOGS_RETENTION_DAYS * DAY_MS);
  if (since === null || since === undefined || since === '') return floor;
  const d = since instanceof Date ? since : new Date(since);
  if (Number.isNaN(d.getTime()) || d < floor) return floor;
  return d;
}

// ── writes ───────────────────────────────────────────────────────────────────

export interface RecordCompileInput {
  appId: string;
  /** The version the compile produced; null when the write was refused. */
  versionNumber: number | null;
  ok: boolean;
  errors: unknown;
  warningCount: number;
  durationMs: number;
  trigger: 'create_app' | 'write_files';
}

/** Store one compile of `appId` and prune its history (30 days / newest 200). */
export async function recordCompile(input: RecordCompileInput): Promise<void> {
  const db = getDb();
  await db.insert(appCompiles).values({
    appId: input.appId,
    versionNumber: input.versionNumber,
    ok: input.ok,
    errors: input.ok ? [] : capCompileErrors(input.errors),
    warningCount: Math.max(0, Math.floor(input.warningCount) || 0),
    durationMs: Math.max(0, Math.round(input.durationMs) || 0),
    trigger: input.trigger,
  });
  try {
    const cutoff = new Date(Date.now() - LOGS_RETENTION_DAYS * DAY_MS);
    await db.delete(appCompiles).where(and(eq(appCompiles.appId, input.appId), lt(appCompiles.createdAt, cutoff)));
    await db.execute(
      sql`delete from app_compiles where app_id = ${input.appId} and id not in (
            select id from app_compiles where app_id = ${input.appId}
            order by created_at desc limit ${COMPILE_HISTORY_KEEP}
          )`
    );
  } catch {
    /* prune is maintenance — never fail the write on it */
  }
}

// ── reads ────────────────────────────────────────────────────────────────────

/** Browser errors since `since` (deduped by message + stack head, with counts). */
export async function queryRuntimeLog(appId: string, since?: Date | string | null, now: Date = new Date()): Promise<RuntimeEntry[]> {
  const from = logsWindowStart(since, now);
  const rows = await getDb()
    .select({
      dedupKey: appErrors.dedupKey,
      type: appErrors.type,
      message: appErrors.message,
      stack: appErrors.stack,
      url: appErrors.url,
      createdAt: appErrors.createdAt,
      ts: appErrors.ts,
    })
    .from(appErrors)
    .where(and(eq(appErrors.appId, appId), gte(appErrors.createdAt, from)))
    .orderBy(desc(appErrors.createdAt))
    .limit(RUNTIME_SCAN_LIMIT);
  const stacks = new Map<string, string | null>();
  for (const r of rows) if (!stacks.has(r.dedupKey)) stacks.set(r.dedupKey, r.stack);
  return runtimeEntries(dedupErrors(rows).errors, stacks);
}

/** The last 50 compiles since `since`, newest first. */
export async function queryCompileLog(appId: string, since?: Date | string | null, now: Date = new Date()): Promise<CompileEntry[]> {
  const from = logsWindowStart(since, now);
  const rows = await getDb()
    .select({
      versionNumber: appCompiles.versionNumber,
      ok: appCompiles.ok,
      errors: appCompiles.errors,
      warningCount: appCompiles.warningCount,
      durationMs: appCompiles.durationMs,
      trigger: appCompiles.trigger,
      createdAt: appCompiles.createdAt,
    })
    .from(appCompiles)
    .where(and(eq(appCompiles.appId, appId), gte(appCompiles.createdAt, from)))
    .orderBy(desc(appCompiles.createdAt))
    .limit(COMPILE_LOG_LIMIT);
  return compileEntries(rows);
}

/** The pipelined Redis reads of the request-log flush (ioredis satisfies it). */
export interface RequestLogPipeline {
  get(key: string): RequestLogPipeline;
  hgetall(key: string): RequestLogPipeline;
  exec(): Promise<[Error | null, unknown][] | null>;
}

export interface RequestLogRedis {
  pipeline(): RequestLogPipeline;
}

export interface RequestLogOptions {
  now?: Date;
  /** Mirror the Redis day counters into app_daily_stats / module_request_stats first (default true; tests without Redis pass false). */
  flush?: boolean;
  /** The Redis to flush from (default: the shared client). */
  redis?: () => RequestLogRedis;
}

/**
 * Mirror the Redis counters of `days` (serving signals + module calls) into
 * app_daily_stats and module_request_stats: ONE pipelined Redis round trip
 * and at most one statement per table, however many days (NSO-327 — the
 * window is up to 31 days). Best-effort: a miss is caught up by the next
 * flush, the counters are cumulative.
 */
async function flushRequestDays(appId: string, days: string[], redis: () => RequestLogRedis): Promise<void> {
  if (days.length === 0) return;
  let results: [Error | null, unknown][];
  try {
    const p = redis().pipeline();
    for (const day of days) {
      const k = servingSignalKeys(appId, day);
      p.get(k.req).get(k.fault5xx).hgetall(k.paths404).hgetall(moduleCountersKey(appId, day));
    }
    results = (await p.exec()) ?? [];
  } catch {
    return;
  }
  const at = (i: number): unknown => {
    const r = results[i];
    return r && !r[0] ? r[1] : null;
  };
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const hash = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, string>) : null);
  const daily: DailyStatsRow[] = [];
  const modules: ModuleStatsRow[] = [];
  days.forEach((day, d) => {
    const row = dailyStatsRow(appId, day, str(at(4 * d)), str(at(4 * d + 1)), hash(at(4 * d + 2)));
    if (row) daily.push(row);
    modules.push(...moduleStatRows(appId, day, hash(at(4 * d + 3))));
  });
  await upsertDailyStats(daily).catch(() => undefined);
  await upsertModuleStats(modules).catch(() => undefined);
}

/** Daily totals (requests / 5xx / 404) + module calls by status class, newest day first. */
export async function queryRequestLog(
  appId: string,
  since?: Date | string | null,
  opts: RequestLogOptions = {}
): Promise<RequestsEntry[]> {
  const now = opts.now ?? new Date();
  const fromDay = utcDay(logsWindowStart(since, now));
  const today = utcDay(now);
  if (opts.flush !== false) {
    // The hot counters of every day in the window that still lives in Redis.
    await flushRequestDays(appId, daysBetween(fromDay, today), opts.redis ?? (() => getRedis() as unknown as RequestLogRedis));
  }
  const db = getDb();
  const [daily, modules] = await Promise.all([
    db
      .select({
        day: appDailyStats.day,
        requestCount: appDailyStats.requestCount,
        count5xx: appDailyStats.count5xx,
        path404Counts: appDailyStats.path404Counts,
      })
      .from(appDailyStats)
      .where(and(eq(appDailyStats.appId, appId), gte(appDailyStats.day, fromDay))),
    db
      .select({
        day: moduleRequestStats.day,
        module: moduleRequestStats.module,
        statusClass: moduleRequestStats.statusClass,
        count: moduleRequestStats.count,
      })
      .from(moduleRequestStats)
      .where(and(eq(moduleRequestStats.appId, appId), gte(moduleRequestStats.day, fromDay))),
  ]);
  return requestEntries(
    daily.map((d) => ({ ...d, path404Counts: d.path404Counts as Record<string, number> | null })),
    modules
  );
}
