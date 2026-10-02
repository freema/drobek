import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedis } from './fake-redis.js';

let fake: FakeRedis;

vi.mock('@drobek/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/core')>();
  return {
    ...actual,
    getRedis: () => fake as unknown as ReturnType<typeof actual.getRedis>,
  };
});

import { rateLimitRedis } from './rate-limit.server.js';

const HOUR_MS = 60 * 60 * 1000;
const GLOBAL_KEY = 'drobek:rl:otp-global-1h:all';

beforeEach(() => {
  fake = new FakeRedis();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('rateLimitRedis', () => {
  it('writes the counter with the window as its expiry on the first hit', async () => {
    expect(await rateLimitRedis('otp-global-1h', 'all', 2, HOUR_MS)).toEqual({ ok: true });
    expect(await fake.get(GLOBAL_KEY)).toBe('1');
    expect(await fake.pttl(GLOBAL_KEY)).toBe(HOUR_MS);
  });

  it('refuses past the limit until the window ends, then counts from one', async () => {
    for (let i = 0; i < 2; i += 1) expect((await rateLimitRedis('otp-global-1h', 'all', 2, HOUR_MS)).ok).toBe(true);
    expect((await rateLimitRedis('otp-global-1h', 'all', 2, HOUR_MS)).ok).toBe(false);
    vi.advanceTimersByTime(HOUR_MS - 1);
    expect((await rateLimitRedis('otp-global-1h', 'all', 2, HOUR_MS)).ok).toBe(false);
    vi.advanceTimersByTime(1);
    expect((await rateLimitRedis('otp-global-1h', 'all', 2, HOUR_MS)).ok).toBe(true);
    expect(await fake.get(GLOBAL_KEY)).toBe('1');
  });

  it('gives a counter left without an expiry the window, after which it is gone', async () => {
    await fake.set(GLOBAL_KEY, '5000');
    expect(await fake.pttl(GLOBAL_KEY)).toBe(-1);

    expect((await rateLimitRedis('otp-global-1h', 'all', 100, HOUR_MS)).ok).toBe(false);
    expect(await fake.pttl(GLOBAL_KEY)).toBe(HOUR_MS);

    vi.advanceTimersByTime(HOUR_MS);
    expect(await fake.get(GLOBAL_KEY)).toBeNull();
    expect((await rateLimitRedis('otp-global-1h', 'all', 100, HOUR_MS)).ok).toBe(true);
    expect(await fake.get(GLOBAL_KEY)).toBe('1');
  });

  it('keeps the window of a counter that has one', async () => {
    await rateLimitRedis('otp-global-1h', 'all', 100, HOUR_MS);
    vi.advanceTimersByTime(HOUR_MS / 2);
    await rateLimitRedis('otp-global-1h', 'all', 100, HOUR_MS);
    expect(await fake.pttl(GLOBAL_KEY)).toBe(HOUR_MS / 2);
  });

  it('fails when Redis is down', async () => {
    fake.failing = true;
    await expect(rateLimitRedis('otp-global-1h', 'all', 100, HOUR_MS)).rejects.toThrow('connection refused');
  });
});
