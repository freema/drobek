import { getRedis } from '@drobek/core';

/**
 * Fixed-window counter rate limit (Redis, atomic INCR + PEXPIRE).
 * Keys are `drobek:`-prefixed — prod runs on a SHARED redis instance.
 */
export async function rateLimitRedis(
  bucket: string,
  key: string,
  limit: number,
  windowMs: number
): Promise<{ ok: boolean }> {
  const r = getRedis();
  const redisKey = `drobek:rl:${bucket}:${key}`;
  const n = await r.incr(redisKey);
  if (n === 1) {
    await r.pexpire(redisKey, windowMs);
  }
  return { ok: n <= limit };
}
