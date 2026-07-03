/**
 * Write rate-limit for the Data API (U10, PHY-55) — a fixed-window Redis
 * counter enforced on EVERY write (create/update/delete) regardless of the
 * collection access mode. Bucket key is `drobek:rl:data:<appId>` (drobek-prefixed
 * — prod runs a SHARED redis). Reads are not rate-limited here.
 */
import { rateLimitRedis } from '@drobek/auth';
import { DataError } from './errors.js';

export const DEFAULT_WRITE_LIMIT = 120;
export const DEFAULT_WRITE_WINDOW_MS = 60_000;

function intEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Consume one write token for `appId`; throws `rate_limited` when exceeded. */
export async function enforceWriteRateLimit(
  appId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const limit = intEnv(env.DATA_WRITE_RATE_LIMIT, DEFAULT_WRITE_LIMIT);
  const windowMs = intEnv(env.DATA_WRITE_RATE_WINDOW_MS, DEFAULT_WRITE_WINDOW_MS);
  const { ok } = await rateLimitRedis('data', appId, limit, windowMs);
  if (!ok) {
    throw new DataError(
      'rate_limited',
      'too many data writes for this app; slow down and retry'
    );
  }
}
