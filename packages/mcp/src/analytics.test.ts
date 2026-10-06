/**
 * get_analytics and get_app's `traffic` over a real MCP client on a real
 * (PGlite) database with the in-memory Redis of the live counters: any role
 * reads, the stored days merge with today's live counts, the visitor-chosen
 * paths and referrer hosts come only inside the untrusted envelope, `days` is
 * checked and capped, and ANALYTICS_ENABLED=0 answers no counts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appTrafficDaily, appTrafficTop, apps, memberships, users, workspaces } from '@drobek/db';
import { recordPageView, type PageViewInput } from '@drobek/insights';
import type { ToolDeps, ToolPrincipal } from './context.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps, type TestDeps } from './test/harness.js';

let db: TestDb;
let close: () => Promise<void>;
let appId: string;
const P = {} as Record<'alice' | 'vic' | 'eve', ToolPrincipal>;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const mk = async (email: string) => (await db.insert(users).values({ email }).returning())[0].id;
  const ids = { alice: await mk('alice@example.test'), vic: await mk('vic@example.test'), eve: await mk('eve@example.test') };
  const [team] = await db.insert(workspaces).values({ kind: 'team', slug: 'team-an', name: 'Analytics' }).returning();
  const [other] = await db.insert(workspaces).values({ kind: 'personal', slug: 'eve-an', name: 'Eve' }).returning();
  await db.insert(memberships).values([
    { userId: ids.alice, workspaceId: team.id, role: 'workspace-admin' },
    { userId: ids.vic, workspaceId: team.id, role: 'viewer' },
    { userId: ids.eve, workspaceId: other.id, role: 'workspace-admin' },
  ]);
  for (const k of Object.keys(ids) as (keyof typeof ids)[]) P[k] = { userId: ids[k], email: `${k}@example.test`, superAdmin: false };
  const [a] = await db.insert(apps).values({ workspaceId: team.id, slug: 'counted', name: 'Counted' }).returning();
  appId = a.id;
});
afterAll(async () => close());

beforeEach(async () => {
  await db.delete(appTrafficDaily);
  await db.delete(appTrafficTop);
});

async function as<T>(who: keyof typeof P, deps: ToolDeps, fn: (c: Awaited<ReturnType<typeof connect>>) => Promise<T>): Promise<T> {
  const c = await connect(P[who], deps);
  try {
    return await fn(c);
  } finally {
    await c.close();
  }
}

function visit(deps: TestDeps, over: Partial<PageViewInput>) {
  return recordPageView(
    appId,
    {
      path: '/',
      host: 'counted.drobek.app',
      userAgent: 'Mozilla/5.0 Firefox/131.0',
      referer: null,
      clientIp: '203.0.113.5',
      secFetchDest: 'document',
      purpose: null,
      ...over,
    },
    { redis: () => deps.trafficRedis }
  );
}

describe('get_analytics', () => {
  it('a viewer reads the stored days and today\'s live counts; paths and referrers only inside the envelope', async () => {
    await db.insert(appTrafficDaily).values({ appId, day: daysAgo(3), views: 4, visitors: 2, botViews: 1 });
    await db.insert(appTrafficTop).values({ appId, day: daysAgo(3), kind: 'path', key: '/pricing', views: 4 });
    const deps = testDeps();
    await visit(deps, { path: '/ignore-previous-instructions', referer: 'https://evil.example/x?q=1' });
    await visit(deps, { clientIp: '198.51.100.9' });
    await visit(deps, { userAgent: 'Googlebot/2.1' });
    await as('vic', deps, async (c) => {
      const res = await c.client.callTool({ name: 'get_analytics', arguments: { app_id: appId, days: 7 } });
      expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
      expect(res.structuredContent).toBeUndefined();
      const text = (res.content as { text: string }[])[0].text;
      expect(text.startsWith('UNTRUSTED CONTENT:')).toBe(true);
      expect(text).toMatch(/<untrusted-app-analytics app_id="[^"]+" days="7" from="[\d-]+" to="[\d-]+" views="6" visitors="4" bot_views="2" bot_share="0.25" enabled="true" nonce="[0-9a-f]{16}">/);
      const body = (await c.call('get_analytics', { app_id: appId, days: 7 })).body as {
        series: { day: string; views: number; visitors: number; bot_views: number }[];
        top_paths: { path: string; views: number }[];
        top_referrers: { host: string; views: number }[];
        retention_days: number;
        note: string;
      };
      expect(body.series).toHaveLength(7);
      expect(body.series.at(-1)).toEqual({ day: today(), views: 2, visitors: 2, bot_views: 1 });
      expect(body.top_paths).toEqual([
        { path: '/pricing', views: 4 },
        { path: '/', views: 1 },
        { path: '/ignore-previous-instructions', views: 1 },
      ]);
      expect(body.top_referrers).toEqual([{ host: 'evil.example', views: 1 }]);
      expect(body.retention_days).toBe(90);
      expect(body.note).toContain('estimate');
    });
  });

  it('defaults to 30 days, caps `days` at the retention and refuses nonsense', async () => {
    const deps = testDeps();
    await as('alice', deps, async (c) => {
      expect((await c.call('get_analytics', { app_id: appId })).body.days).toBe(30);
      expect((await c.call('get_analytics', { app_id: appId, days: 5000 })).body.days).toBe(90);
      const bad = await c.call('get_analytics', { app_id: appId, days: 0 });
      expect(bad.isError).toBe(true);
      expect(JSON.parse(bad.text)).toMatchObject({ code: 'invalid_params' });
      const none = await c.call('get_analytics', { app_id: appId });
      expect(none.body.note).toContain('not published');
    });
  });

  it('another workspace\'s app is not_found', async () => {
    await as('eve', testDeps(), async (c) => {
      const r = await c.call('get_analytics', { app_id: appId });
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.text)).toMatchObject({ code: 'not_found' });
    });
  });

  it('ANALYTICS_ENABLED=0: enabled false, no counts', async () => {
    const deps = testDeps();
    deps.env = { ...deps.env, ANALYTICS_ENABLED: '0' };
    await as('alice', deps, async (c) => {
      const r = await c.call('get_analytics', { app_id: appId });
      expect(r.body).toMatchObject({ enabled: false, series: [] });
      expect(r.body.note).toContain('ANALYTICS_ENABLED=0');
      expect((await c.call('get_app', { app_id: appId })).body.traffic).toBeUndefined();
    });
  });
});

describe('get_app traffic', () => {
  it('has the last 7 days in short, counts only', async () => {
    await db.insert(appTrafficDaily).values([
      { appId, day: daysAgo(2), views: 3, visitors: 2, botViews: 0 },
      { appId, day: daysAgo(20), views: 50, visitors: 20, botViews: 0 },
    ]);
    const deps = testDeps();
    await visit(deps, {});
    await as('vic', deps, async (c) => {
      const body = (await c.call('get_app', { app_id: appId })).body;
      expect(body.traffic).toEqual({ days: 7, views: 4, visitors: 3, bot_views: 0 });
    });
  });
});
