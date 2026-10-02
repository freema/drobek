/**
 * recordBeacon's two rate-limit buckets: the per-IP bucket is
 * checked BEFORE the per-app aggregate, so one client can never spend the
 * app's whole budget and silence its error log — while the aggregate still
 * bounds a flood that rotates IPs. Page loads are counted per version behind
 * their own buckets, and every stored error carries its page's version.
 * PGlite for the insert, an in-memory rateLimitRedis.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appErrors, apps, appVersionLoads, appVersions, workspaces } from '@drobek/db';
import { eq } from 'drizzle-orm';

const rl = vi.hoisted(() => ({ counts: new Map<string, number>(), order: [] as string[] }));

vi.mock('@drobek/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/auth')>();
  return {
    ...actual,
    rateLimitRedis: async (bucket: string, key: string, limit: number) => {
      const k = `${bucket}:${key}`;
      rl.order.push(k);
      const n = (rl.counts.get(k) ?? 0) + 1;
      rl.counts.set(k, n);
      return { ok: n <= limit };
    },
  };
});

import { recordBeacon } from './beacon.server.js';
import { queryRenderCounts, queryRuntimeLog } from './logs.server.js';
import { freshDb, type TestDb } from './test/db.js';

let db: TestDb;
let pg: PGlite;
let appId: string;

const ENV = { BEACON_RATE_LIMIT: '5', BEACON_APP_RATE_LIMIT: '20', BEACON_RATE_WINDOW_MS: '60000' } as NodeJS.ProcessEnv;
const batch = (message: string) => ({ events: [{ type: 'error', message, url: 'https://shop.apps.example/', ts: Date.now() }] });

async function beacon(ip: string, message = 'boom'): Promise<'stored' | 'rate_limited'> {
  try {
    await recordBeacon({ appId, batch: batch(message), ip, env: ENV });
    return 'stored';
  } catch (err) {
    if ((err as { code?: string }).code === 'rate_limited') return 'rate_limited';
    throw err;
  }
}

beforeAll(async () => {
  ({ db, pg } = await freshDb());
  const [ws] = await db.insert(workspaces).values({ kind: 'team', slug: 'beacon-ws', name: 'Beacon' }).returning();
  const [app] = await db.insert(apps).values({ workspaceId: ws.id, slug: 'shop', name: 'Shop' }).returning();
  appId = app.id;
  await db.insert(appVersions).values([1, 2].map((number) => ({ appId, number, actorKind: 'agent' as const, compileStatus: 'ok' as const })));
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  rl.counts.clear();
  rl.order.length = 0;
  await db.delete(appErrors);
  await db.delete(appVersionLoads);
});

describe('recordBeacon rate limits', () => {
  it('checks the per-IP bucket first: one IP past its cap never spends the app bucket', async () => {
    const results = [];
    for (let i = 0; i < 50; i++) results.push(await beacon('203.0.113.1', `e${i}`));
    expect(results.filter((r) => r === 'stored')).toHaveLength(5);
    expect(results.slice(5).every((r) => r === 'rate_limited')).toBe(true);
    expect(rl.order[0]).toBe(`beacon:${appId}:203.0.113.1`);
    // Only the 5 requests the per-IP bucket let through reached the app bucket.
    expect(rl.counts.get(`beacon:app:${appId}`)).toBe(5);
    // So the app still reports errors from everyone else.
    expect(await beacon('198.51.100.2', 'another user')).toBe('stored');
    const rows = await db.select().from(appErrors).where(eq(appErrors.appId, appId));
    expect(rows).toHaveLength(6);
  });

  it('the per-app aggregate still bounds a flood that rotates IPs', async () => {
    const results = [];
    for (let i = 0; i < 25; i++) results.push(await beacon(`10.0.0.${i}`, `rot${i}`));
    expect(results.filter((r) => r === 'stored')).toHaveLength(20);
    expect(results.slice(20).every((r) => r === 'rate_limited')).toBe(true);
  });
});

describe('recordBeacon page loads and versions', () => {
  const load = (version?: number, events: unknown[] = []) => ({ ...(version === undefined ? {} : { version }), load: true, events });

  it('counts a page load per version, a count only — and only a version the app has', async () => {
    expect(await recordBeacon({ appId, batch: load(2), ip: '203.0.113.1', env: ENV })).toEqual({ stored: 0, loadCounted: true });
    expect(await recordBeacon({ appId, batch: load(2), ip: '203.0.113.2', env: ENV })).toEqual({ stored: 0, loadCounted: true });
    expect(await recordBeacon({ appId, batch: load(1), ip: '203.0.113.1', env: ENV })).toEqual({ stored: 0, loadCounted: true });
    // A made-up version stores nothing; a bad one is no version at all.
    expect((await recordBeacon({ appId, batch: load(99), ip: '203.0.113.1', env: ENV })).loadCounted).toBe(false);
    expect((await recordBeacon({ appId, batch: { version: 'x', load: true, events: [] }, ip: '203.0.113.1', env: ENV })).loadCounted).toBe(false);

    const rows = await db.select().from(appVersionLoads).where(eq(appVersionLoads.appId, appId));
    expect(rows.map((r) => [r.versionNumber, r.pageLoads]).sort()).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(Object.keys(rows[0]).sort()).toEqual(['appId', 'pageLoads', 'updatedAt', 'versionNumber']);
    expect(await db.select().from(appErrors)).toHaveLength(0);
  });

  it('a page that does not say its version is counted under the version the host serves', async () => {
    expect((await recordBeacon({ appId, batch: load(), ip: '203.0.113.1', servedVersion: 1, env: ENV })).loadCounted).toBe(true);
    expect((await recordBeacon({ appId, batch: load(), ip: '203.0.113.1', servedVersion: null, env: ENV })).loadCounted).toBe(false);
    expect((await queryRenderCounts(appId, 1)).page_loads).toBe(1);
  });

  it('page loads have their own buckets: a busy page never spends the error budget', async () => {
    for (let i = 0; i < 12; i++) await recordBeacon({ appId, batch: load(2), ip: '203.0.113.1', env: ENV });
    // The per-IP load cap (5) bounds what one client counts …
    expect((await queryRenderCounts(appId, 2)).page_loads).toBe(5);
    expect(rl.counts.get(`beacon-load:${appId}:203.0.113.1`)).toBe(12);
    // … and the error buckets were never touched: errors are still stored.
    expect(rl.counts.get(`beacon:${appId}:203.0.113.1`)).toBeUndefined();
    expect(await beacon('203.0.113.1', 'still reported')).toBe('stored');
  });

  it('every stored error carries the version of its page; the render counts are per version', async () => {
    const ev = (message: string, type = 'error') => ({ type, message, url: 'https://shop--preview.apps.example/', ts: Date.now() });
    await recordBeacon({ appId, batch: load(1, [ev('old page')]), ip: '203.0.113.1', env: ENV });
    await recordBeacon({
      appId,
      batch: { version: 2, events: [ev('Failed to load script: https://shop--preview.apps.example/missing.js', 'resource'), ev('Content-Security-Policy blocked https://evil.example/x.js (script-src-elem)', 'csp')] },
      ip: '203.0.113.1',
      env: ENV,
    });
    await recordBeacon({ appId, batch: { events: [ev('host fallback')] }, ip: '203.0.113.1', servedVersion: 2, env: ENV });
    await recordBeacon({ appId, batch: { events: [ev('nobody knows')] }, ip: '203.0.113.1', env: ENV });

    const rows = await db.select().from(appErrors).where(eq(appErrors.appId, appId));
    const byMessage = new Map(rows.map((r) => [r.message, r]));
    expect(byMessage.get('old page')!.versionNumber).toBe(1);
    expect(byMessage.get('host fallback')!.versionNumber).toBe(2);
    expect(byMessage.get('nobody knows')!.versionNumber).toBeNull();
    expect(rows.find((r) => r.type === 'resource')).toMatchObject({ versionNumber: 2 });
    expect(rows.find((r) => r.type === 'csp')).toMatchObject({ versionNumber: 2 });

    expect(await queryRenderCounts(appId, 1)).toEqual({ page_loads: 1, errors: 1 });
    expect(await queryRenderCounts(appId, 2)).toEqual({ page_loads: 0, errors: 3 });

    const entries = await queryRuntimeLog(appId);
    expect(entries.find((e) => e.message === 'old page')).toMatchObject({ version: 1 });
    expect(entries.find((e) => e.type === 'resource')).toMatchObject({ version: 2, message: 'Failed to load script: https://shop--preview.apps.example/missing.js' });
  });
});
