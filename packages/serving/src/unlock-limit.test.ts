/**
 * The password gate's attempt limiter (NSO-328): per app + client IP, then per
 * app over all clients; a request without a resolved client IP never shares a
 * per-IP bucket with other clients — only the per-app cap applies to it.
 */
import { describe, expect, it } from 'vitest';
import { UNLOCK_APP_ATTEMPTS, UNLOCK_ATTEMPTS, UNLOCK_WINDOW_MS } from './handler.js';
import { unlockAttemptAllowed } from './node.js';

function memoryCounter() {
  const counts = new Map<string, number>();
  const calls: Array<{ bucket: string; key: string; limit: number; windowMs: number }> = [];
  const counter = async (bucket: string, key: string, limit: number, windowMs: number) => {
    calls.push({ bucket, key, limit, windowMs });
    const n = (counts.get(`${bucket}:${key}`) ?? 0) + 1;
    counts.set(`${bucket}:${key}`, n);
    return { ok: n <= limit };
  };
  return { counter, counts, calls };
}

describe('unlockAttemptAllowed', () => {
  it('a known IP: UNLOCK_ATTEMPTS per app + IP, another IP is unaffected', async () => {
    const c = memoryCounter();
    for (let i = 0; i < UNLOCK_ATTEMPTS; i += 1) expect(await unlockAttemptAllowed('a1', '203.0.113.1', c.counter)).toBe(true);
    expect(await unlockAttemptAllowed('a1', '203.0.113.1', c.counter)).toBe(false);
    expect(await unlockAttemptAllowed('a1', '203.0.113.2', c.counter)).toBe(true);
    expect(c.calls[0]).toEqual({ bucket: 'app-unlock', key: 'a1:203.0.113.1', limit: UNLOCK_ATTEMPTS, windowMs: UNLOCK_WINDOW_MS });
    // A refused per-IP attempt does not spend the app-wide budget.
    expect(c.counts.get('app-unlock-app:a1')).toBe(UNLOCK_ATTEMPTS + 1);
  });

  it('no client IP: no per-IP bucket is consulted (no shared "unknown" key), the attempt proceeds', async () => {
    const c = memoryCounter();
    for (let i = 0; i < UNLOCK_ATTEMPTS * 3; i += 1) expect(await unlockAttemptAllowed('a1', null, c.counter)).toBe(true);
    expect(c.calls.every((x) => x.bucket === 'app-unlock-app')).toBe(true);
    expect([...c.counts.keys()].some((k) => k.includes('unknown'))).toBe(false);
  });

  it('no client IP: the per-app cap still applies — and per app, not across apps', async () => {
    const c = memoryCounter();
    for (let i = 0; i < UNLOCK_APP_ATTEMPTS; i += 1) await unlockAttemptAllowed('a1', null, c.counter);
    expect(await unlockAttemptAllowed('a1', null, c.counter)).toBe(false);
    expect(await unlockAttemptAllowed('a1', '203.0.113.3', c.counter)).toBe(false);
    expect(await unlockAttemptAllowed('a2', null, c.counter)).toBe(true);
  });
});
