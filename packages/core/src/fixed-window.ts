import type { Redis } from 'ioredis';

/** The client calls a fixed-window counter makes. */
export type FixedWindowRedis = Pick<Redis, 'multi' | 'pexpire'>;

export interface FixedWindowHit {
  /** The hits in the current window, this one included. */
  count: number;
  /** Milliseconds until the window ends. */
  ttlMs: number;
}

type Replies = [error: Error | null, result: unknown][] | null;

function results(key: string, replies: Replies): unknown[] {
  if (!replies) throw new Error(`fixed-window counter ${key}: transaction aborted`);
  for (const [err] of replies) if (err) throw err;
  return replies.map(([, result]) => result);
}

/**
 * Count one hit in the fixed window at `key`. One MULTI creates the key with
 * its expiry (`SET 0 PX NX`), increments it and reads the remaining time, so
 * a counter is never written without an expiry. A key that has none anyway
 * (an older counter, a hand-written key) gets the full window on its next
 * hit, so no counter outlives its window for good.
 */
export async function hitFixedWindow(redis: FixedWindowRedis, key: string, windowMs: number): Promise<FixedWindowHit> {
  const [, count, pttl] = results(key, await redis.multi().set(key, '0', 'PX', windowMs, 'NX').incr(key).pttl(key).exec());
  let ttlMs = Number(pttl);
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    await redis.pexpire(key, windowMs);
    ttlMs = windowMs;
  }
  return { count: Number(count), ttlMs };
}

/**
 * The hits in the fixed window at `key` without counting one (0 when there
 * is none). A check that only reads must repair too: a full counter without
 * an expiry would otherwise refuse every request and never be hit again, so
 * it gets the window here as in `hitFixedWindow`.
 */
export async function peekFixedWindow(redis: FixedWindowRedis, key: string, windowMs: number): Promise<number> {
  const [value, pttl] = results(key, await redis.multi().get(key).pttl(key).exec());
  if (value !== null && Number(pttl) === -1) await redis.pexpire(key, windowMs);
  return Number(value ?? 0) || 0;
}
