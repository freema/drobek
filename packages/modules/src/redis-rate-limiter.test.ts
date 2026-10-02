import { FakeRedis } from '@drobek/auth';
import type { FixedWindowRedis } from '@drobek/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisRateLimiter } from './runtime.js';

const MINUTE_MS = 60_000;
const KEY = 'drobek:rl:mod:echo:say:203.0.113.9';

let fake: FakeRedis;
const limiter = () => redisRateLimiter(() => fake as unknown as FixedWindowRedis);

beforeEach(() => {
  fake = new FakeRedis();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('redisRateLimiter', () => {
  it('counts within the window and tells the refused caller when it ends', async () => {
    const rl = limiter();
    expect(await rl('mod:echo:say:203.0.113.9', 2, MINUTE_MS)).toEqual({ ok: true, count: 1, retryAfterSec: 0 });
    expect(await fake.pttl(KEY)).toBe(MINUTE_MS);
    expect(await rl('mod:echo:say:203.0.113.9', 2, MINUTE_MS)).toEqual({ ok: true, count: 2, retryAfterSec: 0 });
    vi.advanceTimersByTime(20_500);
    expect(await rl('mod:echo:say:203.0.113.9', 2, MINUTE_MS)).toEqual({ ok: false, count: 3, retryAfterSec: 40 });
    vi.advanceTimersByTime(39_500);
    expect(await rl('mod:echo:say:203.0.113.9', 2, MINUTE_MS)).toEqual({ ok: true, count: 1, retryAfterSec: 0 });
  });

  it('gives a counter left without an expiry the window, after which it is gone', async () => {
    await fake.set(KEY, '1');
    const rl = limiter();
    expect(await rl('mod:echo:say:203.0.113.9', 5, MINUTE_MS)).toEqual({ ok: true, count: 2, retryAfterSec: 0 });
    expect(await fake.pttl(KEY)).toBe(MINUTE_MS);
    vi.advanceTimersByTime(MINUTE_MS);
    expect(await fake.get(KEY)).toBeNull();
    expect(await rl('mod:echo:say:203.0.113.9', 5, MINUTE_MS)).toEqual({ ok: true, count: 1, retryAfterSec: 0 });
  });

  it('refuses a full counter without an expiry for one window only', async () => {
    await fake.set(KEY, '99');
    const rl = limiter();
    expect(await rl('mod:echo:say:203.0.113.9', 5, MINUTE_MS)).toEqual({ ok: false, count: 100, retryAfterSec: 60 });
    vi.advanceTimersByTime(MINUTE_MS);
    expect((await rl('mod:echo:say:203.0.113.9', 5, MINUTE_MS)).ok).toBe(true);
  });
});
