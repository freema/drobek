import { expect, test } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, urlOf } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * NSO-348 (EXT-06): the auth module's sign-in provider slot on the dev stack.
 *
 * The dev stack runs no sign-in provider module (DROBEK_MODULES =
 * hello,auth,email,forms,data,proxy,files), so this spec covers what exists
 * without one:
 *
 *  - GET /__drobek/v1/auth/providers lists only the e-mail code;
 *  - POST begin for a provider the server does not run → 404
 *    provider_not_enabled (and still needs the SDK header);
 *  - the ONE IdP callback on the dashboard host answers a small no-store HTML
 *    page under a strict CSP for a bad state, GET and cross-site POST (the
 *    Origin check exempts it), and never sets a cookie;
 *  - GET complete with a bogus handoff code → 400 page, no session.
 *
 * The full begin → IdP → callback → handoff → complete flow needs a provider
 * module in the stack (the OIDC provider of EXT-07 against a mock IdP): it is
 * the `test.fixme` below, for EXT-09 to finish. The unit suite
 * (modules/auth/src/providers.test.ts) drives that flow with a fixture
 * provider and no network.
 */

interface Created {
  app_id: string;
  slug: string;
}

function sdkHeaders(host: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Origin: urlOf(host), 'X-Drobek-SDK': '1' };
}

test.describe.configure({ mode: 'serial' });

test.describe('auth sign-in providers (NSO-348) @local', () => {
  let mcp: McpClient;
  let host: string;

  test.afterAll(async () => {
    await mcp?.client.close();
  });

  test('an app lists only the e-mail code; begin refuses a provider the server does not run', async ({ page, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'auth-providers' });
    const created = await callTool(mcp.client, 'create_app', { name: 'Providers e2e', template: 'react-ts' });
    expect(created.isError, JSON.stringify(created.json)).toBe(false);
    host = previewHost((created.json as unknown as Created).slug);

    const list = await hostRequest(host, '/__drobek/v1/auth/providers');
    expect(list.status, list.body).toBe(200);
    expect(JSON.parse(list.body)).toEqual({ providers: [{ id: 'emailCode', label: 'E-mail code' }] });

    const begin = await hostRequest(host, '/__drobek/v1/auth/begin', {
      method: 'POST',
      headers: sdkHeaders(host),
      body: JSON.stringify({ provider: 'oidc', return_to: '/' }),
    });
    expect(begin.status, begin.body).toBe(404);
    expect(JSON.parse(begin.body)).toMatchObject({ error: 'provider_not_enabled' });

    const noSdk = await hostRequest(host, '/__drobek/v1/auth/begin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: urlOf(host) },
      body: JSON.stringify({ provider: 'oidc' }),
    });
    expect(noSdk.status).toBe(403);
    expect(JSON.parse(noSdk.body)).toMatchObject({ error: 'csrf_rejected' });
  });

  test('the dashboard-host callback answers a no-store HTML page for a bad state (GET and cross-site POST), never a cookie', async ({ request }) => {
    skipUnlessLocal();
    const get = await request.get(`${BASE_URL_WEB}/__drobek/auth/callback/oidc?state=junk&code=x`, { maxRedirects: 0 });
    expect(get.status()).toBe(400);
    expect(get.headers()['content-type']).toContain('text/html');
    expect(get.headers()['cache-control']).toBe('no-store');
    expect(get.headers()['content-security-policy']).toContain("default-src 'none'");
    expect(get.headers()['set-cookie']).toBeUndefined();
    expect(await get.text()).toContain('Sign-in expired');

    const post = await request.post(`${BASE_URL_WEB}/__drobek/auth/callback/oidc`, {
      headers: { Origin: 'https://idp.example', 'Content-Type': 'application/x-www-form-urlencoded' },
      data: 'RelayState=junk&SAMLResponse=PHg%2B',
      maxRedirects: 0,
    });
    expect(post.status()).toBe(400); // not 403: the Origin check exempts the IdP's form POST
    expect(post.headers()['set-cookie']).toBeUndefined();

    const bad = await request.get(`${BASE_URL_WEB}/__drobek/auth/callback/Not-A-Provider`, { maxRedirects: 0 });
    expect(bad.status()).toBe(404);
  });

  test('complete with a bogus handoff code → 400 page, no session', async () => {
    skipUnlessLocal();
    const r = await hostRequest(host, `/__drobek/v1/auth/complete?code=${'A'.repeat(43)}`);
    expect(r.status).toBe(400);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  // EXT-09: run with a provider module in DROBEK_MODULES (EXT-07's OIDC
  // provider against a mock IdP): <LoginGate> shows "Continue with <label>",
  // the browser goes begin → IdP → /__drobek/auth/callback/<id> → complete,
  // lands on return_to signed in (host-only cookie), and a replayed complete
  // URL, the code on the production host and a link opened in another browser
  // context (no flow cookie) all answer the 400 page.
  test.fixme('full provider sign-in through a real IdP redirect (needs a provider module in the stack — EXT-09)', async () => {});
});
