/**
 * The Analytics tab's loader against a real PGlite database (the workspace
 * role gate is stubbed — requireWorkspaceRole has its own tests in
 * @drobek/tenancy): the stored days of the chosen range, the offered ranges
 * within the retention, the switch-off and a failed read shown as an error.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { appTrafficDaily, appTrafficTop, apps, setDbForTests, users, workspaces } from '@drobek/db';
import { queryTraffic } from '@drobek/insights';
import { noopLogger } from '@drobek/core';
import { loadModuleRuntime, memoryRateLimiter, setModuleRuntimeForTests } from '@drobek/modules';

const role = vi.hoisted(() => ({ user: { id: '', email: 'owner@example.com' }, ws: { id: '', slug: 'acme', name: 'Acme' } }));

vi.mock('@drobek/tenancy', () => ({
  requireWorkspaceRole: async (_request: Request, slug: string) => {
    if (slug !== role.ws.slug) throw new Response('Not found', { status: 404 });
    return { user: role.user, workspace: role.ws, membershipRole: 'viewer', superAdmin: false, effectiveRole: 'viewer' };
  },
}));

const tab = await import('./workspaces.$slug.apps.$appSlug.analytics.server.js');

const ENV = {
  APPS_DOMAIN: 'apps.example',
  PUBLIC_APP_URL: 'https://drobek.example',
  DROBEK_MASTER_KEY: '33'.repeat(32),
  DROBEK_MIGRATE_ON_START: '0',
};

let pg: PGlite;
let appId: string;
let env: NodeJS.ProcessEnv;
const db = () => drizzle(pg, { schema });
const params = { slug: 'acme', appSlug: 'shop-app' };
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const load = async (query = '') =>
  (await tab.loader({ request: new Request(`https://drobek.example/workspaces/acme/apps/shop-app/analytics${query}`), params, context: {} } as never)) as Awaited<
    ReturnType<typeof tab.loader>
  >;

beforeAll(async () => {
  pg = new PGlite();
  await migrate(db(), {
    migrationsFolder: fileURLToPath(new URL('../../../db/drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db());
  const [u] = await db().insert(users).values({ email: 'owner@example.com' }).returning();
  role.user = { id: u.id, email: u.email };
  const [w] = await db().insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
  role.ws = { id: w.id, slug: w.slug, name: w.name };
  const [a] = await db().insert(apps).values({ workspaceId: w.id, slug: 'shop-app', name: 'Shop' }).returning();
  appId = a.id;
  setModuleRuntimeForTests(
    await loadModuleRuntime({
      env: ENV,
      log: noopLogger,
      modules: [],
      skillsDir: null,
      deps: { rateLimit: memoryRateLimiter(), principal: async () => ({ kind: 'anon' }), email: { send: async () => {} } },
    })
  );
  tab.analyticsTabDeps.read = (id, days) => queryTraffic(id, days, { live: false });
  tab.analyticsTabDeps.env = () => env;
});

afterAll(async () => {
  setModuleRuntimeForTests(null);
  await pg.close();
});

beforeEach(async () => {
  env = { ...ENV };
  await db().delete(appTrafficDaily);
  await db().delete(appTrafficTop);
});

describe('Analytics tab loader', () => {
  it('shows the stored days of the range (30 by default), totals and the top lists', async () => {
    await db()
      .insert(appTrafficDaily)
      .values([
        { appId, day: today(), views: 5, visitors: 3, botViews: 5 },
        { appId, day: daysAgo(10), views: 2, visitors: 1, botViews: 0 },
        { appId, day: daysAgo(40), views: 100, visitors: 50, botViews: 0 },
      ]);
    await db()
      .insert(appTrafficTop)
      .values([
        { appId, day: today(), kind: 'path', key: '/', views: 4 },
        { appId, day: daysAgo(10), kind: 'path', key: '/about', views: 2 },
        { appId, day: today(), kind: 'referrer', key: 'news.example', views: 1 },
      ]);
    const d = await load();
    expect(d).toMatchObject({ enabled: true, days: 30, ranges: [7, 30, 90], retentionDays: 90, published: false, error: null });
    expect(d.traffic?.series).toHaveLength(30);
    expect(d.traffic?.totals).toEqual({ views: 7, visitors: 4, bot_views: 5, bot_share: 0.417 });
    expect(d.traffic?.top_paths).toEqual([
      { path: '/', views: 4 },
      { path: '/about', views: 2 },
    ]);
    expect(d.traffic?.top_referrers).toEqual([{ host: 'news.example', views: 1 }]);
    expect((await load('?days=7')).traffic?.totals.views).toBe(5);
    expect((await load('?days=90')).traffic?.totals.views).toBe(107);
    expect((await load('?days=12345')).days).toBe(30);
  });

  it('offers only the ranges within ANALYTICS_RETENTION_DAYS', async () => {
    env = { ...ENV, ANALYTICS_RETENTION_DAYS: '30' };
    const d = await load('?days=90');
    expect(d.ranges).toEqual([7, 30]);
    expect(d.days).toBe(30);
  });

  it('ANALYTICS_ENABLED=0: no read, the tab says it is off', async () => {
    env = { ...ENV, ANALYTICS_ENABLED: '0' };
    const d = await load();
    expect(d).toMatchObject({ enabled: false, traffic: null, error: null });
  });

  it('a failed read is an error, not an empty range', async () => {
    const read = tab.analyticsTabDeps.read;
    tab.analyticsTabDeps.read = async () => {
      throw new Error('db down');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const d = await load();
      expect(d.traffic).toBeNull();
      expect(d.error).toContain('could not be loaded');
    } finally {
      tab.analyticsTabDeps.read = read;
    }
  });

  it('an app of another workspace is a 404', async () => {
    const res = await tab
      .loader({ request: new Request('https://drobek.example/workspaces/other/apps/shop-app/analytics'), params: { slug: 'other', appSlug: 'shop-app' }, context: {} } as never)
      .catch((e: unknown) => e);
    expect((res as Response).status).toBe(404);
  });
});
