/**
 * recordBeacon's rate limits (NSO-328): the per-app aggregate always applies;
 * the per-app + IP bucket only with a resolved client IP — a beacon without
 * one never lands in a shared `unknown` bucket. An empty batch stops before
 * the DB, so no database is needed here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const counts = new Map<string, number>();
const rateLimitRedis = vi.fn(async (bucket: string, key: string, limit: number, _windowMs: number) => {
  const n = (counts.get(`${bucket}:${key}`) ?? 0) + 1;
  counts.set(`${bucket}:${key}`, n);
  return { ok: n <= limit };
});

vi.mock('@drobek/auth', () => ({
  rateLimitRedis: (...a: Parameters<typeof rateLimitRedis>) => rateLimitRedis(...a),
}));

import { recordBeacon } from './beacon.server.js';
import { beaconLimitsFromEnv } from './limits.js';

const ENV = { BEACON_RATE_LIMIT: '3', BEACON_APP_RATE_LIMIT: '5' } as NodeJS.ProcessEnv;

beforeEach(() => {
  counts.clear();
  rateLimitRedis.mockClear();
});

function keys(): string[] {
  return rateLimitRedis.mock.calls.map(([bucket, key]) => `${bucket}:${key}`);
}

describe('recordBeacon rate limits without a client IP', () => {
  it('a resolved IP: counted per app + IP and per app', async () => {
    await expect(recordBeacon({ appId: 'a1', batch: [], ip: '203.0.113.9', env: ENV })).resolves.toEqual({ stored: 0 });
    expect(keys().sort()).toEqual(['beacon:a1:203.0.113.9', 'beacon:app:a1']);
  });

  it('no client IP: the per-IP bucket is not consulted (no shared "unknown" key), the beacon proceeds', async () => {
    for (let i = 0; i < 5; i += 1) {
      await expect(recordBeacon({ appId: 'a1', batch: [], ip: null, env: ENV })).resolves.toEqual({ stored: 0 });
    }
    expect(new Set(keys())).toEqual(new Set(['beacon:app:a1']));
  });

  it('no client IP: the per-app aggregate still applies', async () => {
    const appLimit = beaconLimitsFromEnv(ENV).appRateLimit;
    for (let i = 0; i < appLimit; i += 1) await recordBeacon({ appId: 'a2', batch: [], ip: null, env: ENV });
    await expect(recordBeacon({ appId: 'a2', batch: [], ip: null, env: ENV })).rejects.toMatchObject({ code: 'rate_limited' });
  });
});
