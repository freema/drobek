import { describe, expect, it } from 'vitest';
import { LOGS_RETENTION_DAYS } from './limits.js';
import { MAX_FAIL_PATH_KEYS, failPathsKey, normalizeSignalPath, recordFailingPath, type FailPathsRedis } from './signals.server.js';

function fakeRedis(): FailPathsRedis & { hashes: Map<string, Map<string, number>>; ttl: Map<string, number> } {
  const hashes = new Map<string, Map<string, number>>();
  const ttl = new Map<string, number>();
  const h = (k: string) => {
    let m = hashes.get(k);
    if (!m) hashes.set(k, (m = new Map()));
    return m;
  };
  return {
    hashes,
    ttl,
    hexists: async (k, f) => (hashes.get(k)?.has(f) ? 1 : 0),
    hlen: async (k) => hashes.get(k)?.size ?? 0,
    hincrby: async (k, f, n) => {
      const next = (h(k).get(f) ?? 0) + n;
      h(k).set(f, next);
      return next;
    },
    expire: async (k, sec) => {
      ttl.set(k, sec);
      return 1;
    },
  };
}

describe('normalizeSignalPath', () => {
  it('keeps the path only: no query, no fragment, a leading slash, ≤ 256 chars', () => {
    expect(normalizeSignalPath('/a/b?token=secret#x')).toBe('/a/b');
    expect(normalizeSignalPath('/a#frag?x')).toBe('/a');
    expect(normalizeSignalPath('favicon.ico')).toBe('/favicon.ico');
    expect(normalizeSignalPath(undefined)).toBe('/');
    expect(normalizeSignalPath(`/${'x'.repeat(1000)}`)).toHaveLength(256);
  });
});

describe('recordFailingPath (NSO-380)', () => {
  const day = '2026-09-29';

  it('counts per status class, app and day, TTL = the logs retention + 1 day', async () => {
    const r = fakeRedis();
    await recordFailingPath('app_a', '5xx', '/__drobek/v1/proxy/x?key=1', { redis: () => r, day });
    await recordFailingPath('app_a', '5xx', '/__drobek/v1/proxy/x', { redis: () => r, day });
    await recordFailingPath('app_a', '4xx', '/__drobek/v1/data/y', { redis: () => r, day });
    expect(Object.fromEntries(r.hashes.get(failPathsKey('5xx', 'app_a', day))!)).toEqual({ '/__drobek/v1/proxy/x': 2 });
    expect(Object.fromEntries(r.hashes.get(failPathsKey('4xx', 'app_a', day))!)).toEqual({ '/__drobek/v1/data/y': 1 });
    expect(r.ttl.get(failPathsKey('5xx', 'app_a', day))).toBe((LOGS_RETENTION_DAYS + 1) * 86_400);
  });

  it('caps distinct paths per app and day: a random scan funnels into __other__', async () => {
    const r = fakeRedis();
    for (let i = 0; i < MAX_FAIL_PATH_KEYS + 50; i++) {
      await recordFailingPath('app_a', '4xx', `/scan/${i}`, { redis: () => r, day });
    }
    await recordFailingPath('app_a', '4xx', '/scan/0', { redis: () => r, day });
    const hash = r.hashes.get(failPathsKey('4xx', 'app_a', day))!;
    expect(hash.size).toBe(MAX_FAIL_PATH_KEYS + 1);
    expect(hash.get('__other__')).toBe(50);
    expect(hash.get('/scan/0')).toBe(2);
  });

  it('never throws when Redis fails', async () => {
    const broken = { ...fakeRedis(), hexists: async () => Promise.reject(new Error('down')) };
    await expect(recordFailingPath('app_a', '5xx', '/x', { redis: () => broken, day })).resolves.toBeUndefined();
  });
});
