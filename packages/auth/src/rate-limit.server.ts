import { getRedis, hitFixedWindow } from '@drobek/core';

/**
 * Fixed-window counter rate limit (Redis, `hitFixedWindow`: the counter and
 * its expiry in one MULTI, a key without an expiry gets the window again).
 * Keys are `drobek:`-prefixed — prod runs on a SHARED redis instance.
 */
export async function rateLimitRedis(
  bucket: string,
  key: string,
  limit: number,
  windowMs: number
): Promise<{ ok: boolean }> {
  const { count } = await hitFixedWindow(getRedis(), `drobek:rl:${bucket}:${key}`, windowMs);
  return { ok: count <= limit };
}
