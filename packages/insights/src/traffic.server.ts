/**
 * App traffic analytics — counting in Redis, the hourly rollup into Postgres,
 * the retention prune and the read model (dashboard Analytics tab, Overview,
 * MCP get_app / get_analytics).
 *
 * Per app and UTC day, in Redis (TTL TRAFFIC_TTL_SEC):
 *   drobek:traffic:v:<app>:<day>  page views of people   (INCR)
 *   drobek:traffic:b:<app>:<day>  page views of bots     (INCR)
 *   drobek:traffic:u:<app>:<day>  unique visitors        (HyperLogLog)
 *   drobek:traffic:p:<app>:<day>  views per page path    (hash, ≤ 200 + __other__)
 *   drobek:traffic:r:<app>:<day>  views per referrer host (hash, ≤ 200 + __other__)
 *   drobek:traffic:apps:<day>     the apps counted that day (set, for the rollup)
 *
 * The visitor estimate: PFADD of sha256(salt, app id, client IP, user agent),
 * where the salt is random per UTC day and lives ONLY in Redis
 * (`drobek:traffic:salt:<day>`, expiring right after the day) and in this
 * process's memory for that day — never in Postgres, never in a log. Once the
 * salt is gone, yesterday's hashes cannot be tied to anyone; the HyperLogLog
 * keeps no element anyway. No cookie, no storage on the visitor's device.
 *
 * Every write is best-effort and never throws: the serving response is never
 * affected. The rollup and the reads take the larger of the stored and the
 * live count, so a restarted Redis cannot lower a stored day.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gte, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { getRedis } from '@drobek/core';
import { appTrafficDaily, appTrafficTop, apps, dbErrorForLog, getDb, isForeignKeyViolation } from '@drobek/db';
import { daysBetween } from './logs.js';
import { utcDay } from './signals.server.js';
import {
  TRAFFIC_OTHER,
  TRAFFIC_TOP_KEYS_MAX,
  analyticsRetentionDays,
  classifyPageView,
  referrerHost,
  shapeTraffic,
  trafficPath,
  trafficRange,
  type PageViewInput,
  type TrafficView,
} from './traffic.js';

const DAY_MS = 86_400_000;
/** The Redis counters live 8 days: the hourly rollup re-reads the last ROLLUP_DAYS of them. */
export const TRAFFIC_TTL_SEC = 8 * 24 * 60 * 60;
/** Days the rollup re-reads from Redis (a rollup that did not run for a while still catches up). */
const ROLLUP_DAYS = 7;
/** Days a read takes live from Redis (today, and yesterday until the rollup stored it). */
const LIVE_DAYS = 2;
const ROLLUP_INTERVAL_MS = 60 * 60 * 1000;
/** The first rollup a minute after start, so a server restarted more often than hourly still stores its days. */
const ROLLUP_FIRST_DELAY_MS = 60_000;
const ROLLUP_LOCK_KEY = 'drobek:lock:analytics-rollup';
const APPS_CHUNK = 200;

export function trafficKeys(appId: string, day: string) {
  return {
    views: `drobek:traffic:v:${appId}:${day}`,
    bots: `drobek:traffic:b:${appId}:${day}`,
    visitors: `drobek:traffic:u:${appId}:${day}`,
    paths: `drobek:traffic:p:${appId}:${day}`,
    referrers: `drobek:traffic:r:${appId}:${day}`,
  };
}
function trafficAppsKey(day: string): string {
  return `drobek:traffic:apps:${day}`;
}
function saltKey(day: string): string {
  return `drobek:traffic:salt:${day}`;
}

/** A queued batch of Redis commands (ioredis' pipeline satisfies it). */
interface TrafficPipeline {
  incr(key: string): TrafficPipeline;
  expire(key: string, sec: number): TrafficPipeline;
  sadd(key: string, member: string): TrafficPipeline;
  pfadd(key: string, element: string): TrafficPipeline;
  pfcount(key: string): TrafficPipeline;
  hincrby(key: string, field: string, n: number): TrafficPipeline;
  hexists(key: string, field: string): TrafficPipeline;
  hlen(key: string): TrafficPipeline;
  hgetall(key: string): TrafficPipeline;
  get(key: string): TrafficPipeline;
  exec(): Promise<[Error | null, unknown][] | null>;
}

/** The Redis commands analytics uses (ioredis satisfies it). */
export interface TrafficRedis {
  pipeline(): TrafficPipeline;
  set(key: string, value: string, ex: 'EX', sec: number, nx: 'NX'): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  smembers(key: string): Promise<string[]>;
}

const sharedRedis = () => getRedis() as unknown as TrafficRedis;

async function run(p: TrafficPipeline): Promise<unknown[]> {
  const out = await p.exec();
  if (!out) throw new Error('redis pipeline aborted');
  return out.map(([err, v]) => {
    if (err) throw err;
    return v;
  });
}

// ── the daily salt ───────────────────────────────────────────────────────────

const saltCache = new Map<string, string>();

/** Seconds from `now` to just after the end of its UTC day. */
function secondsLeftInDay(now: Date): number {
  const end = Date.parse(`${utcDay(now)}T00:00:00Z`) + DAY_MS;
  return Math.max(60, Math.ceil((end - now.getTime()) / 1000) + 60);
}

/**
 * The visitor-hash salt of `now`'s UTC day: created at random by the first
 * replica that needs it (SET NX), shared through Redis, gone after the day.
 */
export async function dailySalt(redis: TrafficRedis, now: Date = new Date()): Promise<string> {
  const day = utcDay(now);
  const cached = saltCache.get(day);
  if (cached) return cached;
  const fresh = randomBytes(32).toString('hex');
  await redis.set(saltKey(day), fresh, 'EX', secondsLeftInDay(now), 'NX');
  const salt = (await redis.get(saltKey(day))) ?? fresh;
  saltCache.clear();
  saltCache.set(day, salt);
  return salt;
}

/** Forget the in-process copy of the salt (tests). */
export function resetTrafficSaltCache(): void {
  saltCache.clear();
}

/** The HyperLogLog element of one visitor of one app on one day (never stored anywhere else). */
export function visitorHash(salt: string, appId: string, clientIp: string | null, userAgent: string | null): string {
  return createHash('sha256')
    .update(`${salt}\u0000${appId}\u0000${clientIp ?? ''}\u0000${userAgent ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

// ── counting ─────────────────────────────────────────────────────────────────

export interface RecordPageViewOptions {
  now?: Date;
  redis?: () => TrafficRedis;
}

/**
 * Count one successful HTML document response of the production host or a
 * custom domain. Best-effort: never throws, never blocks the response.
 */
export async function recordPageView(appId: string, input: PageViewInput, opts: RecordPageViewOptions = {}): Promise<void> {
  try {
    const cls = classifyPageView(input);
    if (cls === 'skip') return;
    const r = (opts.redis ?? sharedRedis)();
    const now = opts.now ?? new Date();
    const day = utcDay(now);
    const k = trafficKeys(appId, day);
    const appsKey = trafficAppsKey(day);
    if (cls === 'bot') {
      await run(r.pipeline().incr(k.bots).expire(k.bots, TRAFFIC_TTL_SEC).sadd(appsKey, appId).expire(appsKey, TRAFFIC_TTL_SEC));
      return;
    }
    const salt = await dailySalt(r, now);
    const path = trafficPath(input.path);
    const ref = referrerHost(input.referer, input.host);
    const [pathKnown, pathCount, refKnown, refCount] = await run(
      r
        .pipeline()
        .hexists(k.paths, path)
        .hlen(k.paths)
        .hexists(k.referrers, ref ?? '')
        .hlen(k.referrers)
    );
    const pathField = Number(pathKnown) === 1 || Number(pathCount) < TRAFFIC_TOP_KEYS_MAX ? path : TRAFFIC_OTHER;
    const p = r
      .pipeline()
      .incr(k.views)
      .expire(k.views, TRAFFIC_TTL_SEC)
      .pfadd(k.visitors, visitorHash(salt, appId, input.clientIp, input.userAgent))
      .expire(k.visitors, TRAFFIC_TTL_SEC)
      .hincrby(k.paths, pathField, 1)
      .expire(k.paths, TRAFFIC_TTL_SEC)
      .sadd(appsKey, appId)
      .expire(appsKey, TRAFFIC_TTL_SEC);
    if (ref !== null) {
      const refField = Number(refKnown) === 1 || Number(refCount) < TRAFFIC_TOP_KEYS_MAX ? ref : TRAFFIC_OTHER;
      p.hincrby(k.referrers, refField, 1).expire(k.referrers, TRAFFIC_TTL_SEC);
    }
    await run(p);
  } catch {
    /* analytics are best-effort — never fail the serving response */
  }
}

// ── live counters ────────────────────────────────────────────────────────────

/** One app's counters of one day as Redis holds them. */
interface LiveTrafficDay {
  views: number;
  visitors: number;
  botViews: number;
  paths: Record<string, number>;
  referrers: Record<string, number>;
}

function numbers(h: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries((h ?? {}) as Record<string, string>)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}

/** The live counters of `pairs` (app, day) in ONE pipeline; a pair with nothing counted is null. */
async function readLiveTraffic(redis: TrafficRedis, pairs: { appId: string; day: string }[]): Promise<(LiveTrafficDay | null)[]> {
  if (pairs.length === 0) return [];
  const p = redis.pipeline();
  for (const { appId, day } of pairs) {
    const k = trafficKeys(appId, day);
    p.get(k.views).get(k.bots).pfcount(k.visitors).hgetall(k.paths).hgetall(k.referrers);
  }
  const out = await run(p);
  return pairs.map((_, i) => {
    const [v, b, u, paths, refs] = out.slice(i * 5, i * 5 + 5);
    const day: LiveTrafficDay = {
      views: Number(v) || 0,
      botViews: Number(b) || 0,
      visitors: Number(u) || 0,
      paths: numbers(paths),
      referrers: numbers(refs),
    };
    return day.views === 0 && day.botViews === 0 ? null : day;
  });
}

// ── rollup + prune ───────────────────────────────────────────────────────────

/** Store the live days into Postgres (idempotent; a count never goes down). */
async function storeTrafficDays(rows: { appId: string; day: string; live: LiveTrafficDay }[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  await db
    .insert(appTrafficDaily)
    .values(rows.map((r) => ({ appId: r.appId, day: r.day, views: r.live.views, visitors: r.live.visitors, botViews: r.live.botViews })))
    .onConflictDoUpdate({
      target: [appTrafficDaily.appId, appTrafficDaily.day],
      set: {
        views: sql`greatest(${appTrafficDaily.views}, excluded.views)`,
        visitors: sql`greatest(${appTrafficDaily.visitors}, excluded.visitors)`,
        botViews: sql`greatest(${appTrafficDaily.botViews}, excluded.bot_views)`,
        updatedAt: new Date(),
      },
    });
  const tops = rows.flatMap((r) => [
    ...Object.entries(r.live.paths).map(([key, views]) => ({ appId: r.appId, day: r.day, kind: 'path' as const, key, views })),
    ...Object.entries(r.live.referrers).map(([key, views]) => ({ appId: r.appId, day: r.day, kind: 'referrer' as const, key, views })),
  ]);
  for (let i = 0; i < tops.length; i += 1000) {
    await db
      .insert(appTrafficTop)
      .values(tops.slice(i, i + 1000))
      .onConflictDoUpdate({
        target: [appTrafficTop.appId, appTrafficTop.day, appTrafficTop.kind, appTrafficTop.key],
        set: { views: sql`greatest(${appTrafficTop.views}, excluded.views)` },
      });
  }
}

export interface TrafficRollupResult {
  /** (app, day) pairs stored. */
  stored: number;
  /** Daily rows and top rows removed by the retention. */
  prunedDays: number;
  prunedTops: number;
}

/**
 * The hourly job: store the last ROLLUP_DAYS of every counted app into
 * app_traffic_daily / app_traffic_top (apps deleted for good are skipped; a
 * chunk whose app is purged mid-run waits for the next run),
 * then remove the days past ANALYTICS_RETENTION_DAYS.
 */
export async function rollupTraffic(opts: { now?: Date; env?: NodeJS.ProcessEnv; redis?: () => TrafficRedis } = {}): Promise<TrafficRollupResult> {
  const now = opts.now ?? new Date();
  const r = (opts.redis ?? sharedRedis)();
  const db = getDb();
  const today = utcDay(now);
  const days = daysBetween(utcDay(new Date(now.getTime() - (ROLLUP_DAYS - 1) * DAY_MS)), today);
  let stored = 0;
  for (const day of days) {
    const ids = await r.smembers(trafficAppsKey(day));
    for (let i = 0; i < ids.length; i += APPS_CHUNK) {
      const chunk = ids.slice(i, i + APPS_CHUNK);
      const existing = new Set((await db.select({ id: apps.id }).from(apps).where(inArray(apps.id, chunk))).map((a) => a.id));
      const pairs = chunk.filter((id) => existing.has(id)).map((appId) => ({ appId, day }));
      const live = await readLiveTraffic(r, pairs);
      const rows = pairs.flatMap((p, j) => (live[j] ? [{ ...p, live: live[j]! }] : []));
      try {
        await storeTrafficDays(rows);
        stored += rows.length;
      } catch (err) {
        if (!isForeignKeyViolation(err)) throw err;
      }
    }
  }
  const pruned = await pruneTraffic({ now, env: opts.env });
  return { stored, ...pruned };
}

/** Remove the days older than ANALYTICS_RETENTION_DAYS. */
export async function pruneTraffic(opts: { now?: Date; env?: NodeJS.ProcessEnv } = {}): Promise<{ prunedDays: number; prunedTops: number }> {
  const now = opts.now ?? new Date();
  const oldest = trafficRange(analyticsRetentionDays(opts.env), now).from;
  const db = getDb();
  const d = await db.delete(appTrafficDaily).where(lt(appTrafficDaily.day, oldest)).returning({ appId: appTrafficDaily.appId });
  const t = await db.delete(appTrafficTop).where(lt(appTrafficTop.day, oldest)).returning({ appId: appTrafficTop.appId });
  return { prunedDays: d.length, prunedTops: t.length };
}

/** Run `fn` on one replica only (the server passes `withRedisLock` from @drobek/apps). */
type TrafficLease = <T>(key: string, ttlSec: number, fn: () => Promise<T>) => Promise<{ acquired: true; result: T } | { acquired: false }>;

/** The hourly rollup + prune in the server process. Returns a stop function. */
export function startTrafficRollup(opts: { log: (msg: string, error?: string) => void; lease?: TrafficLease; env?: NodeJS.ProcessEnv }): () => void {
  const once = () => rollupTraffic({ env: opts.env });
  const tick = async () => {
    try {
      const out = opts.lease ? await opts.lease(ROLLUP_LOCK_KEY, Math.floor(ROLLUP_INTERVAL_MS / 1000) - 60, once) : { acquired: true as const, result: await once() };
      if (out.acquired && out.result.prunedDays + out.result.prunedTops > 0) {
        opts.log(`analytics: removed ${out.result.prunedDays} day row(s) and ${out.result.prunedTops} top row(s) past the retention`);
      }
    } catch (err) {
      opts.log('analytics rollup failed', dbErrorForLog(err));
    }
  };
  const first = setTimeout(() => void tick(), ROLLUP_FIRST_DELAY_MS);
  first.unref();
  const timer = setInterval(() => void tick(), ROLLUP_INTERVAL_MS);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

// ── reads ────────────────────────────────────────────────────────────────────

export interface QueryTrafficOptions {
  now?: Date;
  /** Merge the live Redis counters of today and yesterday (default true). */
  live?: boolean;
  redis?: () => TrafficRedis;
  /** Entries of each top list (default 10; 0 = totals and series only). */
  topLimit?: number;
}

function addTo(m: Map<string, number>, key: string, n: number): void {
  m.set(key, (m.get(key) ?? 0) + n);
}

/**
 * The traffic of `appId` over the last `days` UTC days (today included):
 * the stored days, with today and yesterday merged from the live counters
 * (the larger of stored and live per count), so the view is current without
 * waiting for the rollup. A Redis failure leaves the stored days.
 */
export async function queryTraffic(appId: string, days: number, opts: QueryTrafficOptions = {}): Promise<TrafficView> {
  const now = opts.now ?? new Date();
  const range = trafficRange(days, now);
  const liveDays = opts.live === false ? [] : range.days.slice(-LIVE_DAYS);
  const topLimit = opts.topLimit ?? undefined;
  const wantTops = topLimit !== 0;
  const db = getDb();

  const storedDaily = await db
    .select({ day: appTrafficDaily.day, views: appTrafficDaily.views, visitors: appTrafficDaily.visitors, botViews: appTrafficDaily.botViews })
    .from(appTrafficDaily)
    .where(and(eq(appTrafficDaily.appId, appId), gte(appTrafficDaily.day, range.from)));
  const daily = new Map(storedDaily.map((d) => [d.day, { views: d.views, visitors: d.visitors, botViews: d.botViews }]));

  const paths = new Map<string, number>();
  const referrers = new Map<string, number>();
  const liveTops = new Map<string, { paths: Map<string, number>; referrers: Map<string, number> }>();
  for (const day of liveDays) liveTops.set(day, { paths: new Map(), referrers: new Map() });

  if (wantTops) {
    const summed = await db
      .select({ kind: appTrafficTop.kind, key: appTrafficTop.key, views: sql<number>`sum(${appTrafficTop.views})::int` })
      .from(appTrafficTop)
      .where(
        and(
          eq(appTrafficTop.appId, appId),
          gte(appTrafficTop.day, range.from),
          ...(liveDays.length > 0 ? [notInArray(appTrafficTop.day, liveDays)] : [])
        )
      )
      .groupBy(appTrafficTop.kind, appTrafficTop.key);
    for (const t of summed) addTo(t.kind === 'path' ? paths : referrers, t.key, Number(t.views) || 0);
    if (liveDays.length > 0) {
      const storedLive = await db
        .select({ day: appTrafficTop.day, kind: appTrafficTop.kind, key: appTrafficTop.key, views: appTrafficTop.views })
        .from(appTrafficTop)
        .where(and(eq(appTrafficTop.appId, appId), inArray(appTrafficTop.day, liveDays)));
      for (const t of storedLive) {
        const bucket = liveTops.get(t.day)!;
        (t.kind === 'path' ? bucket.paths : bucket.referrers).set(t.key, t.views);
      }
    }
  }

  if (liveDays.length > 0) {
    let live: (LiveTrafficDay | null)[] = [];
    try {
      live = await readLiveTraffic((opts.redis ?? sharedRedis)(), liveDays.map((day) => ({ appId, day })));
    } catch {
      live = [];
    }
    liveDays.forEach((day, i) => {
      const l = live[i];
      if (l) {
        const s = daily.get(day);
        daily.set(day, {
          views: Math.max(s?.views ?? 0, l.views),
          visitors: Math.max(s?.visitors ?? 0, l.visitors),
          botViews: Math.max(s?.botViews ?? 0, l.botViews),
        });
        const bucket = liveTops.get(day)!;
        for (const [key, n] of Object.entries(l.paths)) bucket.paths.set(key, Math.max(bucket.paths.get(key) ?? 0, n));
        for (const [key, n] of Object.entries(l.referrers)) bucket.referrers.set(key, Math.max(bucket.referrers.get(key) ?? 0, n));
      }
    });
  }
  for (const bucket of liveTops.values()) {
    for (const [key, n] of bucket.paths) addTo(paths, key, n);
    for (const [key, n] of bucket.referrers) addTo(referrers, key, n);
  }

  return shapeTraffic({ range, daily, paths, referrers, ...(topLimit !== undefined ? { topLimit } : {}) });
}

/** An in-memory TrafficRedis (unit tests; HyperLogLog = an exact set). */
export function memoryTrafficRedis(): TrafficRedis & { keys: () => string[]; ttl: Map<string, number> } {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, number>>();
  const sets = new Map<string, Set<string>>();
  const ttl = new Map<string, number>();
  const setOf = (k: string) => {
    let s = sets.get(k);
    if (!s) sets.set(k, (s = new Set()));
    return s;
  };
  const hashOf = (k: string) => {
    let h = hashes.get(k);
    if (!h) hashes.set(k, (h = new Map()));
    return h;
  };
  const redis: TrafficRedis & { keys: () => string[]; ttl: Map<string, number> } = {
    ttl,
    keys: () => [...strings.keys(), ...hashes.keys(), ...sets.keys()],
    pipeline() {
      const queued: (() => unknown)[] = [];
      const p: TrafficPipeline = {
        incr(k) {
          queued.push(() => {
            const n = Number(strings.get(k) ?? 0) + 1;
            strings.set(k, String(n));
            return n;
          });
          return p;
        },
        expire(k, sec) {
          queued.push(() => (ttl.set(k, sec), 1));
          return p;
        },
        sadd(k, m) {
          queued.push(() => (setOf(k).has(m) ? 0 : (setOf(k).add(m), 1)));
          return p;
        },
        pfadd(k, e) {
          queued.push(() => (setOf(k).has(e) ? 0 : (setOf(k).add(e), 1)));
          return p;
        },
        pfcount(k) {
          queued.push(() => sets.get(k)?.size ?? 0);
          return p;
        },
        hincrby(k, f, n) {
          queued.push(() => {
            const v = (hashOf(k).get(f) ?? 0) + n;
            hashOf(k).set(f, v);
            return v;
          });
          return p;
        },
        hexists(k, f) {
          queued.push(() => (hashes.get(k)?.has(f) ? 1 : 0));
          return p;
        },
        hlen(k) {
          queued.push(() => hashes.get(k)?.size ?? 0);
          return p;
        },
        hgetall(k) {
          queued.push(() => Object.fromEntries([...(hashes.get(k) ?? new Map<string, number>())].map(([f, v]) => [f, String(v)])));
          return p;
        },
        get(k) {
          queued.push(() => strings.get(k) ?? null);
          return p;
        },
        async exec() {
          return queued.map((q) => [null, q()] as [null, unknown]);
        },
      };
      return p;
    },
    async set(k, v, _ex, sec, _nx) {
      if (strings.has(k)) return null;
      strings.set(k, v);
      ttl.set(k, sec);
      return 'OK';
    },
    async get(k) {
      return strings.get(k) ?? null;
    },
    async smembers(k) {
      return [...(sets.get(k) ?? [])];
    },
  };
  return redis;
}
