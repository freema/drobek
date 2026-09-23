import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UNKNOWN_HOST_LIMIT,
  DEFAULT_UNKNOWN_HOST_WINDOW_MS,
  UnknownHostLimiter,
  unknownHostLimitsFromEnv,
} from './unknown-host.js';

describe('unknownHostLimitsFromEnv', () => {
  it('defaults, overrides, junk falls back', () => {
    expect(unknownHostLimitsFromEnv({})).toEqual({
      limit: DEFAULT_UNKNOWN_HOST_LIMIT,
      windowMs: DEFAULT_UNKNOWN_HOST_WINDOW_MS,
    });
    expect(unknownHostLimitsFromEnv({ APPS_UNKNOWN_HOST_LIMIT: '5', APPS_UNKNOWN_HOST_WINDOW_MS: '1000' })).toEqual({
      limit: 5,
      windowMs: 1000,
    });
    expect(unknownHostLimitsFromEnv({ APPS_UNKNOWN_HOST_LIMIT: '-1', APPS_UNKNOWN_HOST_WINDOW_MS: 'x' })).toEqual({
      limit: DEFAULT_UNKNOWN_HOST_LIMIT,
      windowMs: DEFAULT_UNKNOWN_HOST_WINDOW_MS,
    });
  });
});

describe('UnknownHostLimiter', () => {
  it('counts per IP, remembers a throttled IP until the window ends', async () => {
    let now = 0;
    const counts = new Map<string, number>();
    const l = new UnknownHostLimiter({
      limit: 2,
      windowMs: 10_000,
      now: () => now,
      counter: async (ip, limit) => {
        const n = (counts.get(ip) ?? 0) + 1;
        counts.set(ip, n);
        return n <= limit;
      },
    });
    expect(await l.allow('192.0.2.1')).toBe(true);
    expect(await l.allow('192.0.2.1')).toBe(true);
    expect(l.isThrottled('192.0.2.1')).toBe(false);
    expect(await l.allow('192.0.2.1')).toBe(false);
    expect(l.isThrottled('192.0.2.1')).toBe(true);
    expect(l.isThrottled('192.0.2.2')).toBe(false);
    expect(l.retryAfterSec).toBe(10);
    now += 10_001;
    expect(l.isThrottled('192.0.2.1')).toBe(false);
  });

  it('a null IP is never counted nor throttled', async () => {
    let calls = 0;
    const l = new UnknownHostLimiter({
      limit: 1,
      counter: async () => {
        calls++;
        return false;
      },
    });
    expect(await l.allow(null)).toBe(true);
    expect(l.isThrottled(null)).toBe(false);
    expect(calls).toBe(0);
  });
});
