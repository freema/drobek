/**
 * get_logs storage (NSO-327): `get_logs('requests')` flushes its whole window
 * (up to 31 days) in ONE Redis round trip and one statement per table, reads
 * never delete, and the periodic prune keeps every table inside its
 * retention for every app. PGlite + a pipelined in-memory Redis.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appCompiles, appDailyStats, appErrors, apps, moduleRequestStats, workspaces } from '@drobek/db';
import { eq } from 'drizzle-orm';
import { LOGS_RETENTION_DAYS } from './limits.js';
import { queryRequestLog, type RequestLogPipeline, type RequestLogRedis } from './logs.server.js';
import { DEFAULT_LOGS_PRUNE_INTERVAL_MS, logsPruneIntervalFromEnv, pruneLogs, startLogsPrune } from './prune.server.js';
import { freshDb, type TestDb } from './test/db.js';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-09-24T12:00:00Z');
const dayOf = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString().slice(0, 10);

let db: TestDb;
let pg: PGlite;
let appA: string;
let appB: string;

beforeAll(async () => {
  ({ db, pg } = await freshDb());
  const [ws] = await db.insert(workspaces).values({ kind: 'team', slug: 'logs-ws', name: 'Logs' }).returning();
  const [a] = await db.insert(apps).values({ workspaceId: ws.id, slug: 'app-a', name: 'A' }).returning();
  const [b] = await db.insert(apps).values({ workspaceId: ws.id, slug: 'app-b', name: 'B' }).returning();
  appA = a.id;
  appB = b.id;
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  for (const t of [appErrors, appCompiles, appDailyStats, moduleRequestStats]) await db.delete(t);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** An in-memory Redis with the pipelined reads the flush uses; counts every round trip. */
function pipelineRedis(strings: Map<string, string>, hashes: Map<string, Record<string, string>>) {
  const stats = { execs: 0, commands: 0 };
  const redis: RequestLogRedis = {
    pipeline() {
      const queued: (() => unknown)[] = [];
      const p: RequestLogPipeline = {
        get(key) {
          queued.push(() => strings.get(key) ?? null);
          return p;
        },
        hgetall(key) {
          queued.push(() => hashes.get(key) ?? {});
          return p;
        },
        async exec() {
          stats.execs += 1;
          stats.commands += queued.length;
          return queued.map((q) => [null, q()] as [null, unknown]);
        },
      };
      return p;
    },
  };
  return { redis, stats };
}

/** Count the SQL statements PGlite runs (drizzle's pglite session calls client.query). */
function countSql(): { count: () => number } {
  const q = vi.spyOn(pg, 'query');
  const e = vi.spyOn(pg, 'exec');
  return { count: () => q.mock.calls.length + e.mock.calls.length };
}

describe("get_logs('requests') flush", () => {
  it('flushes all 31 days of the window in one Redis round trip and one statement per table', async () => {
    const strings = new Map<string, string>();
    const hashes = new Map<string, Record<string, string>>();
    for (let d = 0; d <= LOGS_RETENTION_DAYS; d++) {
      const day = dayOf(d);
      strings.set(`drobek:signals:req:${appA}:${day}`, String(100 + d));
      strings.set(`drobek:signals:5xx:${appA}:${day}`, String(d));
      hashes.set(`drobek:signals:404:${appA}:${day}`, { '/missing': '2' });
      hashes.set(`drobek:signals:mod:${appA}:${day}`, { 'data:2xx': String(10 + d), 'auth:4xx': '1', 'junk': 'x' });
    }
    const { redis, stats } = pipelineRedis(strings, hashes);
    const sqlCalls = countSql();
    const entries = await queryRequestLog(appA, null, { now: NOW, redis: () => redis });

    expect(stats.execs).toBe(1);
    expect(stats.commands).toBe((LOGS_RETENTION_DAYS + 1) * 4);
    // Two upserts (app_daily_stats, module_request_stats) + the two reads — no per-day statement, no delete.
    expect(sqlCalls.count()).toBe(4);

    expect(entries).toHaveLength(LOGS_RETENTION_DAYS + 1);
    expect(entries[0]).toMatchObject({ day: dayOf(0), requests: 100, count_5xx: 0, count_404: 2, modules: { data: { '2xx': 10 }, auth: { '4xx': 1 } } });
    expect(entries.at(-1)).toMatchObject({ day: dayOf(LOGS_RETENTION_DAYS), requests: 100 + LOGS_RETENTION_DAYS });
  });

  it('the flush is idempotent, keeps module rows from going backwards and never deletes on read', async () => {
    const today = dayOf(0);
    await db.insert(appDailyStats).values({ appId: appA, day: dayOf(60), requestCount: 5, count5xx: 0, path404Counts: {} });
    await db.insert(moduleRequestStats).values({ appId: appA, module: 'data', statusClass: '2xx', day: today, count: 50 });
    const { redis, stats } = pipelineRedis(
      new Map([[`drobek:signals:req:${appA}:${today}`, '7']]),
      new Map([[`drobek:signals:mod:${appA}:${today}`, { 'data:2xx': '3' }]])
    );
    await queryRequestLog(appA, null, { now: NOW, redis: () => redis });
    const again = await queryRequestLog(appA, null, { now: NOW, redis: () => redis });
    expect(stats.execs).toBe(2);
    expect(again[0]).toMatchObject({ day: today, requests: 7, modules: { data: { '2xx': 50 } } });
    // The 60-day-old row is outside the window but still stored: only the prune deletes.
    expect(await db.select().from(appDailyStats).where(eq(appDailyStats.day, dayOf(60)))).toHaveLength(1);
  });

  it('a Redis failure skips the flush and still answers from Postgres', async () => {
    await db.insert(appDailyStats).values({ appId: appA, day: dayOf(1), requestCount: 9, count5xx: 1, path404Counts: {} });
    const broken: RequestLogRedis = {
      pipeline: () => {
        throw new Error('redis down');
      },
    };
    const entries = await queryRequestLog(appA, null, { now: NOW, redis: () => broken });
    expect(entries).toEqual([expect.objectContaining({ day: dayOf(1), requests: 9, count_5xx: 1 })]);
  });
});

describe('the periodic logs prune', () => {
  it('removes rows past their retention (30 days) for every app, and errors past the newest 500 per app', async () => {
    const at = (daysAgo: number, ms = 0) => new Date(NOW.getTime() - daysAgo * DAY_MS + ms);
    const err = (appId: string, createdAt: Date, i: number) => ({
      appId,
      type: 'error' as const,
      message: `e${i}`,
      url: 'https://x/',
      dedupKey: `k${i}`,
      createdAt,
    });
    // App A: 3 errors older than 30 days + 510 recent ones; app B: 10 recent — nobody ever read either.
    await db.insert(appErrors).values([0, 1, 2].map((i) => err(appA, at(31 + i), i)));
    await db.insert(appErrors).values(Array.from({ length: 510 }, (_, i) => err(appA, at(1, i * 1000), 100 + i)));
    await db.insert(appErrors).values(Array.from({ length: 10 }, (_, i) => err(appB, at(2, i), 1000 + i)));
    const compile = (appId: string, createdAt: Date) => ({ appId, versionNumber: 1, ok: true, errors: [], warningCount: 0, durationMs: 5, trigger: 'write_files' as const, createdAt });
    await db.insert(appCompiles).values([compile(appA, at(31)), compile(appA, at(29)), compile(appB, at(45))]);
    await db.insert(appDailyStats).values([
      { appId: appA, day: dayOf(31), requestCount: 1, count5xx: 0, path404Counts: {} },
      { appId: appA, day: dayOf(30), requestCount: 1, count5xx: 0, path404Counts: {} },
      { appId: appB, day: dayOf(90), requestCount: 1, count5xx: 0, path404Counts: {} },
    ]);
    await db.insert(moduleRequestStats).values([
      { appId: appB, module: 'data', statusClass: '2xx', day: dayOf(40), count: 1 },
      { appId: appB, module: 'data', statusClass: '2xx', day: dayOf(3), count: 1 },
    ]);

    const result = await pruneLogs({ now: NOW, env: {} });
    expect(result).toEqual({ errors: 3 + 10, compiles: 2, dailyStats: 2, moduleStats: 1 });

    const errorsA = await db.select().from(appErrors).where(eq(appErrors.appId, appA));
    expect(errorsA).toHaveLength(500);
    // The newest 500 survive: the 10 oldest recent ones (e100..e109) are gone.
    expect(errorsA.some((e) => e.message === 'e109')).toBe(false);
    expect(errorsA.some((e) => e.message === 'e110')).toBe(true);
    expect(await db.select().from(appErrors).where(eq(appErrors.appId, appB))).toHaveLength(10);
    expect((await db.select().from(appCompiles)).map((c) => c.appId)).toEqual([appA]);
    expect((await db.select().from(appDailyStats)).map((d) => d.day)).toEqual([dayOf(30)]);
    expect((await db.select().from(moduleRequestStats)).map((m) => m.day)).toEqual([dayOf(3)]);
    // A second pass has nothing left to do.
    expect(await pruneLogs({ now: NOW, env: {} })).toEqual({ errors: 0, compiles: 0, dailyStats: 0, moduleStats: 0 });
  });

  it('honours BEACON_RETENTION_DAYS / BEACON_MAX_EVENTS_PER_APP for the error buffer', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      appId: appA,
      type: 'error' as const,
      message: `m${i}`,
      url: 'https://x/',
      dedupKey: `d${i}`,
      createdAt: new Date(NOW.getTime() - i * DAY_MS),
    }));
    await db.insert(appErrors).values(rows);
    const r = await pruneLogs({ now: NOW, env: { BEACON_RETENTION_DAYS: '4', BEACON_MAX_EVENTS_PER_APP: '3' } });
    expect(r.errors).toBe(3);
    expect((await db.select().from(appErrors)).map((e) => e.message).sort()).toEqual(['m0', 'm1', 'm2']);
  });

  it('LOGS_PRUNE_INTERVAL_MS: production default 1 h, invalid values fall back', () => {
    expect(DEFAULT_LOGS_PRUNE_INTERVAL_MS).toBe(3_600_000);
    expect(logsPruneIntervalFromEnv({})).toBe(3_600_000);
    expect(logsPruneIntervalFromEnv({ LOGS_PRUNE_INTERVAL_MS: '60000' })).toBe(60_000);
    for (const bad of ['', '0', '-5', '1.5', 'x']) expect(logsPruneIntervalFromEnv({ LOGS_PRUNE_INTERVAL_MS: bad })).toBe(3_600_000);
  });

  it('startLogsPrune runs every interval under the lease (one replica) and logs what it removed', async () => {
    vi.useFakeTimers();
    const leases: [string, number][] = [];
    const log = vi.fn();
    const stop = startLogsPrune({
      log,
      env: { LOGS_PRUNE_INTERVAL_MS: '120000' },
      lease: async <T>(key: string, ttlSec: number, _fn: () => Promise<T>) => {
        leases.push([key, ttlSec]);
        return { acquired: false as const };
      },
    });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(leases).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(leases).toEqual([['drobek:lock:logs-prune', 60]]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(leases).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(leases).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();

    // A failing pass is logged, never thrown.
    const failing = startLogsPrune({
      log,
      env: { LOGS_PRUNE_INTERVAL_MS: '1000' },
      lease: async () => {
        throw new Error('redis down');
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    failing();
    expect(log).toHaveBeenCalledWith('logs prune failed', 'redis down');
  });
});
