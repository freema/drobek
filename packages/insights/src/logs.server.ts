/**
 * get_logs (M1-07) — the stored half, over a RESOLVED app id (the MCP tool
 * authorizes the caller for the app first):
 *
 *  - recordCompile       — one `app_compiles` row per compile a write ran
 *                          (create_app / write_files; ok, failed or refused),
 *                          pruned to 30 days / the newest 200 per app;
 *  - recordModuleRequest — `module_request_stats` += 1 for (app, module,
 *                          status class, UTC day); best-effort, never throws;
 *  - queryRuntimeLog / queryCompileLog / queryRequestLog — the three kinds.
 *
 * Every read is bounded to the retention window (30 days) and ≤ 100 entries.
 */
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { appCompiles, appDailyStats, appErrors, getDb, moduleRequestStats } from '@drobek/db';
import { COMPILE_HISTORY_KEEP, LOGS_RETENTION_DAYS } from './limits.js';
import {
  COMPILE_LOG_LIMIT,
  capCompileErrors,
  compileEntries,
  daysBetween,
  requestEntries,
  runtimeEntries,
  statusClass,
  type CompileEntry,
  type RequestsEntry,
  type RuntimeEntry,
} from './logs.js';
import { dedupErrors } from './shape.js';
import { flushDay, utcDay } from './signals.server.js';

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

/**
 * Count one module response (`/__drobek/v1/<module>/…`) of `appId`. Called by
 * the module runtime for every response of an ACTIVE module; best-effort —
 * a failed upsert is swallowed so the module response is never affected.
 */
export async function recordModuleRequest(
  appId: string,
  module: string,
  status: number,
  now: Date = new Date()
): Promise<void> {
  try {
    await getDb()
      .insert(moduleRequestStats)
      .values({ appId, module, statusClass: statusClass(status), day: utcDay(now), count: 1 })
      .onConflictDoUpdate({
        target: [moduleRequestStats.appId, moduleRequestStats.module, moduleRequestStats.statusClass, moduleRequestStats.day],
        set: { count: sql`${moduleRequestStats.count} + 1` },
      });
  } catch {
    /* stats are best-effort */
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

export interface RequestLogOptions {
  now?: Date;
  /** Mirror the Redis day counters into app_daily_stats first (default true; tests without Redis pass false). */
  flush?: boolean;
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
    for (const day of daysBetween(fromDay, today)) await flushDay(appId, day);
  }
  const db = getDb();
  const oldest = utcDay(new Date(now.getTime() - LOGS_RETENTION_DAYS * DAY_MS));
  try {
    await db.delete(moduleRequestStats).where(and(eq(moduleRequestStats.appId, appId), lt(moduleRequestStats.day, oldest)));
    await db.delete(appDailyStats).where(and(eq(appDailyStats.appId, appId), lt(appDailyStats.day, oldest)));
  } catch {
    /* retention sweep is best-effort */
  }
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
