/**
 * A Redis lease: `SET key token NX EX ttl`, released only by its holder
 * (compare-and-delete), so an expired lease that another process re-acquired
 * is never deleted by the slow original holder.
 */
import { randomUUID } from 'node:crypto';
import { getRedis } from '@drobek/core';

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** Run `fn` while holding the lease; returns `{ acquired: false }` when someone else holds it. */
export async function withRedisLock<T>(
  key: string,
  ttlSec: number,
  fn: () => Promise<T>
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  const redis = getRedis();
  const token = randomUUID();
  const ok = await redis.set(key, token, 'EX', ttlSec, 'NX');
  if (ok !== 'OK') return { acquired: false };
  try {
    return { acquired: true, result: await fn() };
  } finally {
    await redis.eval(RELEASE, 1, key, token);
  }
}
