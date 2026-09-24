import { beforeEach, describe, expect, it, vi } from 'vitest';

const rateLimitRedis = vi.fn(async (_bucket: string, _key: string, _limit: number, _windowMs: number) => ({ ok: true }));

vi.mock('@drobek/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/auth')>();
  return { ...actual, rateLimitRedis: (...a: Parameters<typeof rateLimitRedis>) => rateLimitRedis(...a) };
});

const countUnusedDcrClients = vi.fn(async () => 0);
vi.mock('../clients.server.js', () => ({
  countUnusedDcrClients: () => countUnusedDcrClients(),
  pruneUnusedDcrClients: vi.fn(async () => 0),
  createClient: vi.fn(async (c: { clientName: string; redirectUris: string[] }) => ({ clientId: 'dcr_test', ...c })),
}));

import { action } from './oauth.register.js';

const BODY = { client_name: 'Test client', redirect_uris: ['https://client.example/cb'] };

function register(headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request('http://localhost/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(BODY),
  });
  return action({ request, params: {}, context: {} } as unknown as Parameters<typeof action>[0]);
}

beforeEach(() => {
  rateLimitRedis.mockClear();
  rateLimitRedis.mockImplementation(async () => ({ ok: true }));
  countUnusedDcrClients.mockClear();
  countUnusedDcrClients.mockImplementation(async () => 0);
});

describe('POST /oauth/register per-IP limit (NSO-328)', () => {
  it('a resolved client IP is counted in its own oauth-register-ip bucket; over the limit → 429', async () => {
    expect((await register({ 'x-real-ip': '203.0.113.9' })).status).toBe(201);
    expect(rateLimitRedis).toHaveBeenCalledWith('oauth-register-ip', '203.0.113.9', 10, 3_600_000);

    rateLimitRedis.mockImplementation(async () => ({ ok: false }));
    const limited = await register({ 'x-real-ip': '203.0.113.9' });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: 'rate_limited' });
  });

  it('no client IP: the per-IP bucket is not consulted (no shared "unknown" key), the registration proceeds', async () => {
    const res = await register();
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ client_id: 'dcr_test', token_endpoint_auth_method: 'none' });
    expect(rateLimitRedis).not.toHaveBeenCalled();
  });

  it('no client IP: the unused-client cap still applies', async () => {
    countUnusedDcrClients.mockImplementation(async () => 1_000_000);
    const res = await register();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'temporarily_unavailable' });
    expect(rateLimitRedis).not.toHaveBeenCalled();
  });
});
