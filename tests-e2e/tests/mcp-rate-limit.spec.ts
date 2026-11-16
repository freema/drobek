import { expect, test } from '@playwright/test';
import { Redis } from 'ioredis';
import { BASE_URL_MCP } from '../playwright.config';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';
import { userIdByEmail } from './helpers/seed';

/**
 * The per-user `/mcp` request limit (MCP_REQUESTS_PER_USER_MINUTE, default
 * 600 per minute), read from the briefing create_app returned. The user's
 * Redis counter is filled up to the limit instead of sending hundreds of
 * requests:
 *  - every message of a legacy JSON-RPC batch counts, so a batch crossing
 *    the limit is refused whole;
 *  - the next request answers HTTP 429 with Retry-After and the JSON-RPC
 *    error `rate_limited` (message, hint, limit, retry_after_seconds) — raw,
 *    and through the SDK client as the error of the call;
 *  - a request without a valid credential is still a 401 and is not counted;
 *  - once the window is over (the counter gone) the user's calls work again.
 */

interface RateLimitedBody {
  jsonrpc: string;
  id: null;
  error: { code: number; message: string; data: Record<string, unknown> };
}

function limitFrom(briefing: string): number | null {
  const m = /MCP requests are rate-limited: at most (\d+) per minute per person/.exec(briefing);
  return m ? Number(m[1]) : null;
}

function redis(): Redis {
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6391', { maxRetriesPerRequest: 2, lazyConnect: true });
}

test('past MCP_REQUESTS_PER_USER_MINUTE a request answers 429 rate_limited with Retry-After; the window ending lets the user go on @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const mcp = await mcpClient(page, request, { tag: 'mcp-rate' });
  const r = redis();
  await r.connect();
  try {
    const created = await callTool(mcp.client, 'create_app', { name: 'Rate Limit E2E', template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const limit = limitFrom(created.json.briefing as string);
    test.skip(limit === null, 'MCP_REQUESTS_PER_USER_MINUTE is 0 on this stack');
    const perMinute = limit as number;
    expect(perMinute).toBeGreaterThanOrEqual(100);

    const key = `drobek:rl:mcp-user:${await userIdByEmail(mcp.email)}`;

    const post = (authorization?: string, body: unknown = { jsonrpc: '2.0', id: 7, method: 'tools/list' }) =>
      request.post(`${BASE_URL_MCP}/mcp`, {
        headers: {
          ...(authorization ? { Authorization: authorization } : {}),
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        data: JSON.stringify(body),
      });

    await r.set(key, String(perMinute - 2), 'PX', 30_000);
    const batch = [1, 2, 3].map((id) => ({ jsonrpc: '2.0', id, method: 'tools/list' }));
    expect((await post(`Bearer ${mcp.token}`, batch)).status()).toBe(429);
    expect(Number(await r.get(key))).toBe(perMinute + 1);

    await r.set(key, String(perMinute), 'PX', 30_000);

    const refused = await post(`Bearer ${mcp.token}`);
    expect(refused.status()).toBe(429);
    const retryAfter = Number(refused.headers()['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(30);
    const body = (await refused.json()) as RateLimitedBody;
    expect(body).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32000 } });
    expect(body.error.message).toContain(`at most ${perMinute} per minute per user`);
    expect(body.error.data).toMatchObject({
      code: 'rate_limited',
      limit: perMinute,
      window_seconds: 60,
      retry_after_seconds: retryAfter,
    });
    expect(String(body.error.data.hint)).toContain('do not retry in a loop');

    await expect(mcp.client.callTool({ name: 'list_apps', arguments: {} })).rejects.toThrow(/Too many MCP requests/);

    const before = Number(await r.get(key));
    expect((await post()).status()).toBe(401);
    expect((await post('Bearer drk_not-a-real-key')).status()).toBe(401);
    expect(Number(await r.get(key))).toBe(before);

    await r.del(key);
    const again = await callTool(mcp.client, 'list_apps', {});
    expect(again.isError, again.text.slice(0, 500)).toBe(false);
  } finally {
    r.disconnect();
    await mcp.client.close();
  }
});
