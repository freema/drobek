/**
 * recordBeacon's two rate-limit buckets (NSO-327): the per-IP bucket is
 * checked BEFORE the per-app aggregate, so one client can never spend the
 * app's whole budget and silence its error log — while the aggregate still
 * bounds a flood that rotates IPs. PGlite for the insert, an in-memory
 * rateLimitRedis.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appErrors, apps, workspaces } from '@drobek/db';
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
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  rl.counts.clear();
  rl.order.length = 0;
  await db.delete(appErrors);
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
