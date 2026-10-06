/**
 * App traffic analytics: counting rules on the in-memory Redis, unique
 * visitors, the daily salt, the path / referrer caps, the rollup into Postgres
 * (PGlite), the retention prune and the read that merges today's live counters.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appTrafficDaily, appTrafficTop, apps, workspaces } from '@drobek/db';
import { eq } from 'drizzle-orm';
import { TRAFFIC_OTHER, TRAFFIC_TOP_KEYS_MAX, type PageViewInput } from './traffic.js';
import {
  dailySalt,
  memoryTrafficRedis,
  pruneTraffic,
  queryTraffic,
  recordPageView,
  resetTrafficSaltCache,
  rollupTraffic,
  TRAFFIC_TTL_SEC,
  trafficKeys,
  visitorHash,
  type TrafficRedis,
} from './traffic.server.js';
import { freshDb, type TestDb } from './test/db.js';

const NOW = new Date('2026-10-06T12:00:00Z');
const TODAY = '2026-10-06';
const CHROME = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';

let db: TestDb;
let pg: PGlite;
let appA: string;
let appB: string;

beforeAll(async () => {
  ({ db, pg } = await freshDb());
  const [ws] = await db.insert(workspaces).values({ kind: 'team', slug: 'traffic-ws', name: 'Traffic' }).returning();
  const [a] = await db.insert(apps).values({ workspaceId: ws.id, slug: 'traffic-a', name: 'A' }).returning();
  const [b] = await db.insert(apps).values({ workspaceId: ws.id, slug: 'traffic-b', name: 'B' }).returning();
  appA = a.id;
  appB = b.id;
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await db.delete(appTrafficDaily);
  await db.delete(appTrafficTop);
  resetTrafficSaltCache();
});

function view(over: Partial<PageViewInput> = {}): PageViewInput {
  return {
    path: '/',
    host: 'traffic-a.apps.example.com',
    userAgent: CHROME,
    referer: null,
    clientIp: '203.0.113.7',
    secFetchDest: 'document',
    purpose: null,
    ...over,
  };
}

async function count(redis: TrafficRedis, appId: string, input: Partial<PageViewInput>, now = NOW) {
  await recordPageView(appId, view(input), { redis: () => redis, now });
}

describe('recordPageView', () => {
  it('counts people, unique visitors, paths and referrer hosts; bots apart; nothing of the visitor is kept', async () => {
    const r = memoryTrafficRedis();
    await count(r, appA, {});
    await count(r, appA, { path: '/about?email=a@b.c' });
    await count(r, appA, { clientIp: '198.51.100.1', referer: 'https://news.example/item?id=7' });
    await count(r, appA, { userAgent: FIREFOX, referer: 'https://traffic-a.apps.example.com/' });
    await count(r, appA, { userAgent: 'Googlebot/2.1' });
    await count(r, appA, { userAgent: 'drobek-smoke' });
    await count(r, appA, { secFetchDest: 'empty' });
    const [live] = await rollupAndRead(r);
    expect(live).toMatchObject({ views: 4, visitors: 3, bot_views: 1 });
    const t = await queryTraffic(appA, 7, { now: NOW, redis: () => r });
    expect(t.top_paths).toEqual([
      { path: '/', views: 3 },
      { path: '/about', views: 1 },
    ]);
    expect(t.top_referrers).toEqual([{ host: 'news.example', views: 1 }]);
    const stored = JSON.stringify(r.keys()) + JSON.stringify(await db.select().from(appTrafficTop));
    for (const leak of ['203.0.113.7', '198.51.100.1', 'Chrome', 'Firefox', 'email', 'item?id']) expect(stored).not.toContain(leak);
    expect(r.ttl.get(trafficKeys(appA, TODAY).views)).toBe(TRAFFIC_TTL_SEC);
  });

  it('the same visitor on another day is a new hash: the salt rotates daily and expires after the day', async () => {
    const r = memoryTrafficRedis();
    const today = await dailySalt(r, NOW);
    expect(await dailySalt(r, NOW)).toBe(today);
    const tomorrow = await dailySalt(r, new Date('2026-10-07T00:00:05Z'));
    expect(tomorrow).not.toBe(today);
    expect(today).toMatch(/^[0-9a-f]{64}$/);
    expect(r.ttl.get('drobek:traffic:salt:2026-10-06')).toBe(12 * 3600 + 60);
    expect(visitorHash(today, appA, '203.0.113.7', CHROME)).not.toBe(visitorHash(tomorrow, appA, '203.0.113.7', CHROME));
    expect(visitorHash(today, appA, '203.0.113.7', CHROME)).not.toBe(visitorHash(today, appB, '203.0.113.7', CHROME));
  });

  it('a second replica uses the salt the first one created', async () => {
    const r = memoryTrafficRedis();
    const first = await dailySalt(r, NOW);
    resetTrafficSaltCache();
    expect(await dailySalt(r, NOW)).toBe(first);
  });

  it('caps distinct paths and referrer hosts per app and day; the rest count as __other__', async () => {
    const r = memoryTrafficRedis();
    for (let i = 0; i < TRAFFIC_TOP_KEYS_MAX + 5; i++) await count(r, appA, { path: `/p/${i}`, referer: `https://r${i}.example/` });
    await count(r, appA, { path: '/p/0' });
    const t = await queryTraffic(appA, 1, { now: NOW, redis: () => r, topLimit: 1000 });
    expect(t.top_paths).toHaveLength(TRAFFIC_TOP_KEYS_MAX + 1);
    expect(t.top_paths.find((p) => p.path === TRAFFIC_OTHER)?.views).toBe(5);
    expect(t.top_paths.find((p) => p.path === '/p/0')?.views).toBe(2);
    expect(t.top_referrers.find((p) => p.host === TRAFFIC_OTHER)?.views).toBe(5);
  });

  it('never throws when Redis fails', async () => {
    const broken = { ...memoryTrafficRedis(), set: async () => Promise.reject(new Error('down')) } as TrafficRedis;
    await expect(recordPageView(appA, view(), { redis: () => broken, now: NOW })).resolves.toBeUndefined();
  });
});

async function rollupAndRead(r: TrafficRedis) {
  await rollupTraffic({ now: NOW, redis: () => r });
  return (await queryTraffic(appA, 1, { now: NOW, live: false })).series;
}

describe('rollupTraffic + queryTraffic', () => {
  it('stores every counted app and day; a repeated rollup and a restarted Redis never lower a stored day', async () => {
    const r = memoryTrafficRedis();
    await count(r, appA, {});
    await count(r, appB, {});
    await count(r, appA, { clientIp: '198.51.100.2' }, new Date('2026-10-05T09:00:00Z'));
    const out = await rollupTraffic({ now: NOW, redis: () => r });
    expect(out.stored).toBe(3);
    await rollupTraffic({ now: NOW, redis: () => r });
    const rows = await db.select().from(appTrafficDaily).where(eq(appTrafficDaily.appId, appA));
    expect(rows.map((x) => [x.day, x.views, x.visitors]).sort()).toEqual([
      ['2026-10-05', 1, 1],
      [TODAY, 1, 1],
    ]);
    const restarted = memoryTrafficRedis();
    await count(restarted, appA, {});
    await rollupTraffic({ now: NOW, redis: () => restarted });
    const t = await queryTraffic(appA, 7, { now: NOW, redis: () => restarted });
    expect(t.totals.views).toBe(2);
  });

  it('skips an app deleted for good', async () => {
    const r = memoryTrafficRedis();
    await count(r, 'gone-app', {});
    expect((await rollupTraffic({ now: NOW, redis: () => r })).stored).toBe(0);
  });

  it('the read merges today\'s live counters with the stored days, zero-filled', async () => {
    await db.insert(appTrafficDaily).values({ appId: appA, day: '2026-10-01', views: 10, visitors: 4, botViews: 2 });
    await db.insert(appTrafficTop).values({ appId: appA, day: '2026-10-01', kind: 'path', key: '/', views: 10 });
    const r = memoryTrafficRedis();
    await count(r, appA, {});
    await count(r, appA, { userAgent: 'curl/8.0' });
    const t = await queryTraffic(appA, 7, { now: NOW, redis: () => r });
    expect(t.series).toHaveLength(7);
    expect(t.from).toBe('2026-09-30');
    expect(t.series.find((d) => d.day === '2026-10-01')).toEqual({ day: '2026-10-01', views: 10, visitors: 4, bot_views: 2 });
    expect(t.series.at(-1)).toEqual({ day: TODAY, views: 1, visitors: 1, bot_views: 1 });
    expect(t.totals).toEqual({ views: 11, visitors: 5, bot_views: 3, bot_share: 0.214 });
    expect(t.top_paths).toEqual([{ path: '/', views: 11 }]);
  });

  it('a Redis failure on read leaves the stored days', async () => {
    await db.insert(appTrafficDaily).values({ appId: appA, day: TODAY, views: 3, visitors: 2, botViews: 0 });
    const broken = { ...memoryTrafficRedis(), pipeline: () => { throw new Error('down'); } } as TrafficRedis;
    const t = await queryTraffic(appA, 7, { now: NOW, redis: () => broken });
    expect(t.totals.views).toBe(3);
  });
});

describe('pruneTraffic', () => {
  it('removes the days past ANALYTICS_RETENTION_DAYS (default 90)', async () => {
    await db.insert(appTrafficDaily).values([
      { appId: appA, day: '2026-07-08', views: 1 },
      { appId: appA, day: '2026-07-09', views: 1 },
    ]);
    await db.insert(appTrafficTop).values({ appId: appA, day: '2026-07-01', kind: 'referrer', key: 'x.example', views: 1 });
    expect(await pruneTraffic({ now: NOW, env: {} })).toEqual({ prunedDays: 1, prunedTops: 1 });
    expect((await db.select().from(appTrafficDaily)).map((d) => d.day)).toEqual(['2026-07-09']);
    expect(await pruneTraffic({ now: NOW, env: { ANALYTICS_RETENTION_DAYS: '7' } })).toEqual({ prunedDays: 1, prunedTops: 0 });
  });
});
