import { describe, expect, it } from 'vitest';
import { hitFixedWindow, peekFixedWindow, type FixedWindowRedis } from './fixed-window.js';

/** GET / SET PX NX / INCR / PTTL / PEXPIRE over a map with a movable clock. */
function fakeRedis() {
  const store = new Map<string, { value: number; expiresAt: number | null }>();
  const state = { now: 0, store };
  const live = (key: string) => {
    const e = store.get(key);
    if (e && e.expiresAt !== null && e.expiresAt <= state.now) store.delete(key);
    return store.get(key) ?? null;
  };
  const ops = {
    get(key: string) {
      const e = live(key);
      return e ? String(e.value) : null;
    },
    set(key: string, value: string, _px: 'PX', ms: number, _nx: 'NX') {
      if (live(key)) return null;
      store.set(key, { value: Number(value), expiresAt: state.now + ms });
      return 'OK';
    },
    incr(key: string) {
      const e = live(key);
      if (!e) {
        store.set(key, { value: 1, expiresAt: null });
        return 1;
      }
      e.value += 1;
      return e.value;
    },
    pttl(key: string) {
      const e = live(key);
      if (!e) return -2;
      return e.expiresAt === null ? -1 : e.expiresAt - state.now;
    },
  };
  const client = {
    multi() {
      const queued: (() => unknown)[] = [];
      const chain = {
        get: (key: string) => (queued.push(() => ops.get(key)), chain),
        set: (...a: Parameters<typeof ops.set>) => (queued.push(() => ops.set(...a)), chain),
        incr: (key: string) => (queued.push(() => ops.incr(key)), chain),
        pttl: (key: string) => (queued.push(() => ops.pttl(key)), chain),
        exec: async () => queued.map((op) => [null, op()]),
      };
      return chain;
    },
    async pexpire(key: string, ms: number) {
      const e = live(key);
      if (!e) return 0;
      e.expiresAt = state.now + ms;
      return 1;
    },
  };
  return { redis: client as unknown as FixedWindowRedis, state, ttl: (key: string) => ops.pttl(key) };
}

describe('hitFixedWindow', () => {
  it('creates the counter with the window as its expiry and counts within it', async () => {
    const { redis, state, ttl } = fakeRedis();
    expect(await hitFixedWindow(redis, 'k', 60_000)).toEqual({ count: 1, ttlMs: 60_000 });
    expect(ttl('k')).toBe(60_000);
    state.now = 10_000;
    expect(await hitFixedWindow(redis, 'k', 60_000)).toEqual({ count: 2, ttlMs: 50_000 });
    state.now = 60_000;
    expect(await hitFixedWindow(redis, 'k', 60_000)).toEqual({ count: 1, ttlMs: 60_000 });
  });

  it('gives a counter without an expiry the window, after which it is gone', async () => {
    const { redis, state, ttl } = fakeRedis();
    state.store.set('k', { value: 500, expiresAt: null });
    expect(await hitFixedWindow(redis, 'k', 60_000)).toEqual({ count: 501, ttlMs: 60_000 });
    expect(ttl('k')).toBe(60_000);
    state.now = 60_000;
    expect(ttl('k')).toBe(-2);
    expect(await hitFixedWindow(redis, 'k', 60_000)).toEqual({ count: 1, ttlMs: 60_000 });
  });

  it('throws the error of a failed command and does not touch the key', async () => {
    let pexpired = false;
    const chain = {
      set: () => chain,
      incr: () => chain,
      pttl: () => chain,
      exec: async () => [[null, null], [new Error('ERR value is not an integer or out of range'), null], [null, -1]],
    };
    const failing = {
      multi: () => chain,
      pexpire: async () => {
        pexpired = true;
        return 1;
      },
    } as unknown as FixedWindowRedis;
    await expect(hitFixedWindow(failing, 'k', 60_000)).rejects.toThrow('not an integer');
    expect(pexpired).toBe(false);
  });
});

describe('peekFixedWindow', () => {
  it('reads the count without counting and leaves the window alone', async () => {
    const { redis, state, ttl } = fakeRedis();
    expect(await peekFixedWindow(redis, 'k', 60_000)).toBe(0);
    expect(ttl('k')).toBe(-2);
    await hitFixedWindow(redis, 'k', 60_000);
    state.now = 15_000;
    expect(await peekFixedWindow(redis, 'k', 60_000)).toBe(1);
    expect(ttl('k')).toBe(45_000);
  });

  it('gives a full counter without an expiry the window, after which it is gone', async () => {
    const { redis, state, ttl } = fakeRedis();
    state.store.set('k', { value: 100, expiresAt: null });
    expect(await peekFixedWindow(redis, 'k', 60_000)).toBe(100);
    expect(ttl('k')).toBe(60_000);
    state.now = 60_000;
    expect(await peekFixedWindow(redis, 'k', 60_000)).toBe(0);
  });
});
