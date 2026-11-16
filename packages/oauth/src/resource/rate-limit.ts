/**
 * The per-user request limit of `/mcp` (MCP_REQUESTS_PER_USER_MINUTE): a
 * fixed one-minute window in Redis (`hitFixedWindow`, the counter and its
 * expiry in one MULTI), keyed by the user the credential belongs to — so all
 * of one person's API keys and OAuth connections share one budget, and minting
 * another key or registering another client does not raise it. It is counted
 * only after the request authenticated, so a request without a valid
 * credential never spends anyone's budget. A Redis failure lets the request
 * through (the endpoint logs it), as the other request throttles do.
 */
import { errorDoc } from '@drobek/agent-dx';
import { getRedis, hitFixedWindow, type FixedWindowHit } from '@drobek/core';
import { mcpRequestsPerUserMinute } from '@drobek/mcp';

const MCP_RATE_WINDOW_MS = 60_000;

/** Counts one hit at `key` in a fixed window of `windowMs`. */
export type McpRateCounter = (key: string, windowMs: number) => Promise<FixedWindowHit>;

export interface McpRateLimit {
  /** Requests per user per minute; 0 = no limit. */
  perMinute: number;
  counter: McpRateCounter;
}

export type McpRateDecision =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number; firstRefusal: boolean };

/** MCP_REQUESTS_PER_USER_MINUTE over the shared Redis client. */
export function mcpRateLimitFromEnv(env: NodeJS.ProcessEnv = process.env): McpRateLimit {
  return {
    perMinute: mcpRequestsPerUserMinute(env),
    counter: (key, windowMs) => hitFixedWindow(getRedis(), key, windowMs),
  };
}

function mcpRateKey(userId: string): string {
  return `drobek:rl:mcp-user:${userId}`;
}

/** Count one request of `userId`; `onError` gets a counter failure, which lets the request through. */
export async function checkMcpRate(
  limit: McpRateLimit,
  userId: string,
  onError: (err: unknown) => void
): Promise<McpRateDecision> {
  if (limit.perMinute <= 0) return { ok: true };
  let hit: FixedWindowHit;
  try {
    hit = await limit.counter(mcpRateKey(userId), MCP_RATE_WINDOW_MS);
  } catch (err) {
    onError(err);
    return { ok: true };
  }
  if (hit.count <= limit.perMinute) return { ok: true };
  return {
    ok: false,
    retryAfterSeconds: Math.min(MCP_RATE_WINDOW_MS / 1000, Math.max(1, Math.ceil(hit.ttlMs / 1000))),
    firstRefusal: hit.count === limit.perMinute + 1,
  };
}

const CATALOGUE_ENTRY = 'rate_limited (429 on /mcp)';

/** The JSON-RPC error of a refused request: the catalogue's code, message and hint, plus the numbers. */
export function rateLimitedError(perMinute: number, retryAfterSeconds: number): {
  code: number;
  message: string;
  data: Record<string, unknown>;
} {
  const message = `Too many MCP requests: at most ${perMinute} per minute per user, over all of the user's connections and API keys (MCP_REQUESTS_PER_USER_MINUTE). Nothing of this request ran. Wait ${retryAfterSeconds} seconds, then go on; do not retry in a loop.`;
  return {
    code: -32000,
    message,
    data: {
      code: 'rate_limited',
      message,
      hint: errorDoc(CATALOGUE_ENTRY)?.fix ?? '',
      limit: perMinute,
      window_seconds: MCP_RATE_WINDOW_MS / 1000,
      retry_after_seconds: retryAfterSeconds,
    },
  };
}
