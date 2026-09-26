import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOriginCheckMiddleware, decideOriginCheck, type OriginCheckInput } from './origin-check.js';

/** The owner's production shape: dashboard on drobek.app, apps on *.drobek.app. */
const PROD = { appsDomain: 'drobek.app', dashboardHost: 'drobek.app' };

function check(over: Partial<OriginCheckInput>) {
  return decideOriginCheck({
    method: 'POST',
    path: '/workspaces/acme/apps/shop',
    origin: 'https://drobek.app',
    secFetchSite: 'same-origin',
    host: 'drobek.app',
    dashboardOrigin: 'https://drobek.app',
    hosts: PROD,
    ...over,
  });
}

describe('decideOriginCheck', () => {
  it('lets the dashboard post to itself', () => {
    expect(check({})).toEqual({ ok: true });
  });

  it('refuses a mutating request from an app origin (*.drobek.app)', () => {
    for (const origin of ['https://evil.drobek.app', 'https://shop--preview.drobek.app', 'https://a.b.drobek.app']) {
      expect(check({ origin, secFetchSite: 'same-site' }), origin).toEqual({ ok: false, reason: 'apps_origin' });
    }
  });

  it('refuses a foreign origin and an opaque (null) origin', () => {
    expect(check({ origin: 'https://attacker.example', secFetchSite: 'cross-site' })).toEqual({
      ok: false,
      reason: 'foreign_origin',
    });
    expect(check({ origin: 'null' })).toEqual({ ok: false, reason: 'null_origin' });
    expect(check({ origin: 'https://drobek.app.evil.example' })).toEqual({ ok: false, reason: 'foreign_origin' });
    expect(check({ origin: 'not a url' })).toEqual({ ok: false, reason: 'foreign_origin' });
  });

  it('safe methods are never checked', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(check({ method, origin: 'https://evil.drobek.app' }), method).toEqual({ ok: true });
    }
  });

  it('every mutating method is checked', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(check({ method, origin: 'https://evil.drobek.app' }).ok, method).toBe(false);
    }
  });

  it('exempts the token, registration and MCP endpoints (cross-origin by design, no cookies)', () => {
    for (const path of ['/oauth/token', '/oauth/register', '/mcp', '/mcp/anything']) {
      expect(check({ path, origin: 'https://claude.ai' }), path).toEqual({ ok: true });
      expect(check({ path, origin: 'https://evil.drobek.app' }), path).toEqual({ ok: true });
    }
    // …but not the consent form, which IS cookie-authenticated.
    expect(check({ path: '/oauth/authorize', origin: 'https://evil.drobek.app' }).ok).toBe(false);
    expect(check({ path: '/oauth/tokenx', origin: 'https://evil.drobek.app' }).ok).toBe(false);
  });

  it('exempts the end-user sign-in callback (an IdP posts from its own origin, NSO-348) — only that path', () => {
    expect(check({ path: '/__drobek/auth/callback/saml', origin: 'https://idp.example', secFetchSite: 'cross-site' })).toEqual({ ok: true });
    expect(check({ path: '/__drobek/auth/callbackx', origin: 'https://idp.example' }).ok).toBe(false);
    expect(check({ path: '/__drobek/auth/other', origin: 'https://idp.example' }).ok).toBe(false);
  });

  it('no Origin: allowed for non-browser clients, refused when the browser says cross/same-site', () => {
    expect(check({ origin: null, secFetchSite: null })).toEqual({ ok: true });
    expect(check({ origin: null, secFetchSite: 'same-origin' })).toEqual({ ok: true });
    expect(check({ origin: null, secFetchSite: 'same-site' })).toEqual({ ok: false, reason: 'cross_site_without_origin' });
    expect(check({ origin: null, secFetchSite: 'cross-site' })).toEqual({ ok: false, reason: 'cross_site_without_origin' });
  });

  it("a self-host reached under another name may post to itself (Origin = the request's Host)", () => {
    expect(
      check({ origin: 'http://10.0.0.5:3041', host: '10.0.0.5:3041', dashboardOrigin: 'https://drobek.example' })
    ).toEqual({ ok: true });
  });

  it('dev: the apps domain is apps.localhost:3041, the dashboard localhost:3041', () => {
    const dev = { appsDomain: 'apps.localhost:3041', dashboardHost: 'localhost:3041' };
    const base = { host: 'localhost:3041', dashboardOrigin: 'http://localhost:3041', hosts: dev };
    expect(check({ ...base, origin: 'http://localhost:3041' })).toEqual({ ok: true });
    expect(check({ ...base, origin: 'http://shop--preview.apps.localhost:3041' })).toEqual({
      ok: false,
      reason: 'apps_origin',
    });
  });
});

describe('createOriginCheckMiddleware', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const mw = createOriginCheckMiddleware({ hosts: PROD, dashboardOrigin: 'https://drobek.app' });
    server = createServer((req, res) => mw(req, res, () => res.end('passed')));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  function send(method: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { Host: 'drobek.app', ...headers } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('403s a POST from an app origin, passes the dashboard origin and GETs', async () => {
    expect(await send('POST', '/auth/logout', { Origin: 'https://evil.drobek.app' })).toEqual({
      status: 403,
      body: 'Forbidden: cross-origin request refused',
    });
    expect((await send('POST', '/auth/logout', { Origin: 'https://drobek.app' })).body).toBe('passed');
    expect((await send('GET', '/me', { Origin: 'https://evil.drobek.app' })).body).toBe('passed');
    expect((await send('POST', '/oauth/token?x=1', { Origin: 'https://evil.drobek.app' })).body).toBe('passed');
  });
});
