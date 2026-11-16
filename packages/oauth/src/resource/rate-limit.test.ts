import { describe, expect, it, vi } from 'vitest';
import { errorDoc } from '@drobek/agent-dx';
import type { FixedWindowHit } from '@drobek/core';
import { checkMcpRate, mcpRateLimitFromEnv, rateLimitedError, type McpRateCounter } from './rate-limit.js';

function fixed(hit: FixedWindowHit): { counter: McpRateCounter; keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    counter: async (key, windowMs) => {
      keys.push(`${key}@${windowMs}`);
      return hit;
    },
  };
}

describe('checkMcpRate', () => {
  it('counts the request under the user id in a one-minute window and lets it through up to the limit', async () => {
    const { counter, keys } = fixed({ count: 5, ttlMs: 40_000 });
    expect(await checkMcpRate({ perMinute: 5, counter }, 'user-1', () => {})).toEqual({ ok: true });
    expect(keys).toEqual(['drobek:rl:mcp-user:user-1@60000']);
  });

  it('refuses past the limit with the seconds left in the window; the first refusal of a window is marked', async () => {
    expect(await checkMcpRate({ perMinute: 5, counter: fixed({ count: 6, ttlMs: 41_200 }).counter }, 'u', () => {})).toEqual({
      ok: false,
      retryAfterSeconds: 42,
      firstRefusal: true,
    });
    expect(await checkMcpRate({ perMinute: 5, counter: fixed({ count: 9, ttlMs: 10 }).counter }, 'u', () => {})).toEqual({
      ok: false,
      retryAfterSeconds: 1,
      firstRefusal: false,
    });
  });

  it('0 turns the limit off: nothing is counted', async () => {
    const counter = vi.fn<McpRateCounter>();
    expect(await checkMcpRate({ perMinute: 0, counter }, 'u', () => {})).toEqual({ ok: true });
    expect(counter).not.toHaveBeenCalled();
  });

  it('a counter failure (Redis down) lets the request through and is handed to onError', async () => {
    const onError = vi.fn();
    const boom = new Error('redis down');
    const decision = await checkMcpRate({ perMinute: 1, counter: async () => Promise.reject(boom) }, 'u', onError);
    expect(decision).toEqual({ ok: true });
    expect(onError).toHaveBeenCalledWith(boom);
  });
});

describe('mcpRateLimitFromEnv', () => {
  it('reads MCP_REQUESTS_PER_USER_MINUTE', () => {
    expect(mcpRateLimitFromEnv({}).perMinute).toBe(600);
    expect(mcpRateLimitFromEnv({ MCP_REQUESTS_PER_USER_MINUTE: '0' }).perMinute).toBe(0);
  });
});

describe('rateLimitedError', () => {
  it('is a JSON-RPC error whose data carries the catalogue code, message, hint and the numbers', () => {
    const err = rateLimitedError(600, 17);
    expect(err.code).toBe(-32000);
    expect(err.message).toContain('at most 600 per minute per user');
    expect(err.message).toContain('MCP_REQUESTS_PER_USER_MINUTE');
    expect(err.message).toContain('Wait 17 seconds');
    expect(err.data).toEqual({
      code: 'rate_limited',
      message: err.message,
      hint: errorDoc('rate_limited (429 on /mcp)')?.fix,
      limit: 600,
      window_seconds: 60,
      retry_after_seconds: 17,
    });
    expect(String(err.data.hint)).toContain('do not retry in a loop');
  });
});
