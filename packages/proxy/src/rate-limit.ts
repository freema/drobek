/**
 * Per-(workspace, user, upstream) rate limit for proxy calls (PHY-59) — a
 * fixed-window Redis counter (the same primitive @drobek/data uses; "token
 * bucket" in the loose sense of a per-caller quota per window). Keys are
 * `drobek:rl:proxy:<workspaceId>:<userId>:<upstreamId>` — drobek-prefixed
 * because prod runs a SHARED redis.
 */
import { rateLimitRedis } from '@drobek/auth';
import { ProxyError } from './errors.js';

export const DEFAULT_PROXY_RATE_LIMIT = 120;
export const DEFAULT_PROXY_RATE_WINDOW_MS = 60_000;

function intEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Consume one token for this caller+upstream; throws rate_limited when exceeded. */
export async function enforceProxyRateLimit(
  keyParts: { workspaceId: string; userId: string; upstreamId: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const limit = intEnv(env.PROXY_RATE_LIMIT, DEFAULT_PROXY_RATE_LIMIT);
  const windowMs = intEnv(env.PROXY_RATE_WINDOW_MS, DEFAULT_PROXY_RATE_WINDOW_MS);
  const key = `${keyParts.workspaceId}:${keyParts.userId}:${keyParts.upstreamId}`;
  const { ok } = await rateLimitRedis('proxy', key, limit, windowMs);
  if (!ok) {
    throw new ProxyError('rate_limited', 'too many proxy requests; slow down and retry');
  }
}
