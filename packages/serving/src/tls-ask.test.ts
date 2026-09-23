/**
 * Caddy's on-demand TLS `ask` endpoint (M0-07): the pure decision, and the
 * node:http handler over a real HTTP server exactly as Caddy calls it
 * (`GET http://drobek:3000/api/internal/tls/ask?token=…&domain=<host>`).
 */
import { request as httpRequest, createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HostConfig } from '@drobek/apps';
import { noopLogger } from '@drobek/core';
import {
  TLS_ASK_PATH,
  decideTlsAsk,
  tlsAskConfigError,
  tlsAskCustomHost,
  tlsAskSlug,
  tlsAskToken,
  tlsAskTokenMatches,
  type TlsAskDeps,
} from './tls-ask.js';
import { createTlsAskHandler } from './tls-ask.server.js';

const TOKEN = 'a'.repeat(24) + '0123456789abcdef';
const PROD_HOSTS: HostConfig = { appsDomain: 'drobek.app', dashboardHost: 'drobek.app' };
const LIVE = new Set(['shop', 'my-app']);
const appExists = async (slug: string) => LIVE.has(slug);
/** M3-01: the verified custom domains (the domains table in production). */
const VERIFIED = new Set(['firma.test', 'shop.firma.cz']);
const customDomainAllowed = async (hostname: string) => VERIFIED.has(hostname);

describe('tlsAskToken / tlsAskConfigError', () => {
  it('unset is allowed at startup but disables the endpoint', () => {
    expect(tlsAskToken({})).toBeNull();
    expect(tlsAskConfigError({})).toBeNull();
  });

  it('a valid token is returned trimmed', () => {
    expect(tlsAskToken({ TLS_ASK_TOKEN: ` ${TOKEN} ` })).toBe(TOKEN);
    expect(tlsAskConfigError({ TLS_ASK_TOKEN: TOKEN })).toBeNull();
  });

  it('a short or non-URL-safe token refuses startup (and never authorizes)', () => {
    expect(tlsAskToken({ TLS_ASK_TOKEN: 'short' })).toBeNull();
    expect(tlsAskConfigError({ TLS_ASK_TOKEN: 'short' })).toMatch(/TLS_ASK_TOKEN must be at least 32/);
    expect(tlsAskConfigError({ TLS_ASK_TOKEN: `${TOKEN}&domain=x` })).toMatch(/URL-safe/);
  });
});

describe('tlsAskTokenMatches', () => {
  it('matches only the exact token', () => {
    expect(tlsAskTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tlsAskTokenMatches(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(tlsAskTokenMatches(TOKEN, TOKEN.slice(1))).toBe(false);
    expect(tlsAskTokenMatches(TOKEN, '')).toBe(false);
    expect(tlsAskTokenMatches(TOKEN, null)).toBe(false);
  });
});

describe('tlsAskSlug', () => {
  it('maps the three app host forms under APPS_DOMAIN to the slug', () => {
    expect(tlsAskSlug('shop.drobek.app', PROD_HOSTS)).toBe('shop');
    expect(tlsAskSlug('shop--preview.drobek.app', PROD_HOSTS)).toBe('shop');
    expect(tlsAskSlug('shop--v12.drobek.app', PROD_HOSTS)).toBe('shop');
    expect(tlsAskSlug('SHOP.Drobek.App.', PROD_HOSTS)).toBe('shop');
  });

  it('refuses the dashboard apex, deeper names, malformed labels and foreign hosts', () => {
    expect(tlsAskSlug('drobek.app', PROD_HOSTS)).toBeNull();
    expect(tlsAskSlug('a.shop.drobek.app', PROD_HOSTS)).toBeNull();
    expect(tlsAskSlug('shop--beta.drobek.app', PROD_HOSTS)).toBeNull();
    expect(tlsAskSlug('ab.drobek.app', PROD_HOSTS)).toBeNull();
    expect(tlsAskSlug('shop.example.com', PROD_HOSTS)).toBeNull();
    expect(tlsAskSlug('shop.drobek.app.evil.com', PROD_HOSTS)).toBeNull();
    expect(tlsAskSlug('203.0.113.7', PROD_HOSTS)).toBeNull();
    expect(tlsAskSlug('shop.drobek.app:443', PROD_HOSTS)).toBeNull();
    expect(tlsAskSlug('', PROD_HOSTS)).toBeNull();
    expect(tlsAskSlug(null, PROD_HOSTS)).toBeNull();
  });

  it('ignores a port on APPS_DOMAIN (Caddy asks with the bare SNI name)', () => {
    const hosts = { appsDomain: 'apps.localhost:8443', dashboardHost: 'localhost:8443' };
    expect(tlsAskSlug('shop--preview.apps.localhost', hosts)).toBe('shop');
  });
});

describe('tlsAskCustomHost (M3-01)', () => {
  it('a dotted public name outside APPS_DOMAIN and the dashboard is a custom-domain candidate', () => {
    expect(tlsAskCustomHost('firma.test', PROD_HOSTS)).toBe('firma.test');
    expect(tlsAskCustomHost('Shop.Firma.CZ.', PROD_HOSTS)).toBe('shop.firma.cz');
  });

  it('never for app hosts, the dashboard, IPs, ports, single labels or localhost', () => {
    for (const d of ['shop.drobek.app', 'drobek.app', 'www.drobek.app', '203.0.113.7', 'firma.test:443', 'drobek', 'x.localhost', '', null]) {
      expect(tlsAskCustomHost(d, PROD_HOSTS), String(d)).toBeNull();
    }
  });
});

describe('decideTlsAsk', () => {
  const deps: TlsAskDeps = { expectedToken: TOKEN, hosts: PROD_HOSTS, appExists, customDomainAllowed };
  const ask = (domain: string | null, token: string | null = TOKEN, requestHost = 'drobek:3000') =>
    decideTlsAsk({ domain, token, requestHost }, deps);

  it('existing slug → 200 (prod, preview and version hosts)', async () => {
    expect(await ask('shop.drobek.app')).toBe(200);
    expect(await ask('shop--preview.drobek.app')).toBe(200);
    expect(await ask('my-app--v3.drobek.app')).toBe(200);
  });

  it('non-existing slug → 404', async () => {
    expect(await ask('nope.drobek.app')).toBe(404);
  });

  it('no token → 401, wrong token → 401', async () => {
    expect(await ask('shop.drobek.app', null)).toBe(401);
    expect(await ask('shop.drobek.app', '')).toBe(401);
    expect(await ask('shop.drobek.app', 'b'.repeat(40))).toBe(401);
  });

  it('M3-01: a verified custom domain → 200; unverified / unknown → 404 (no certificate)', async () => {
    expect(await ask('firma.test')).toBe(200);
    expect(await ask('shop.firma.cz')).toBe(200);
    expect(await ask('pending.firma.cz')).toBe(404);
    expect(await ask('firma.test', 'wrong'.repeat(8))).toBe(401);
    // Without the lookup (older wiring) nothing outside APPS_DOMAIN is allowed.
    expect(await decideTlsAsk({ domain: 'firma.test', token: TOKEN, requestHost: 'drobek:3000' }, { ...deps, customDomainAllowed: undefined })).toBe(404);
  });

  it('hostname outside APPS_DOMAIN → 404 (and the dashboard host → 404)', async () => {
    expect(await ask('shop.example.com')).toBe(404);
    expect(await ask('drobek.app')).toBe(404);
    expect(await ask(null)).toBe(404);
  });

  it('TLS_ASK_TOKEN unset → 404 for everything (fail closed)', async () => {
    const off = { ...deps, expectedToken: null };
    expect(await decideTlsAsk({ domain: 'shop.drobek.app', token: TOKEN, requestHost: 'drobek:3000' }, off)).toBe(404);
    expect(await decideTlsAsk({ domain: 'shop.drobek.app', token: null, requestHost: 'drobek:3000' }, off)).toBe(404);
  });

  it('never answers on the public dashboard host, even with the right token', async () => {
    expect(await ask('shop.drobek.app', TOKEN, 'drobek.app')).toBe(404);
    expect(await ask('shop.drobek.app', TOKEN, 'DROBEK.APP:443')).toBe(404);
    expect(await ask('shop.drobek.app', TOKEN, 'bad host')).toBe(404);
  });

  it('does not touch the database before the token and the host check out', async () => {
    const seen: string[] = [];
    const spy: TlsAskDeps = {
      ...deps,
      appExists: async (s) => (seen.push(s), true),
      customDomainAllowed: async (h) => (seen.push(h), true),
    };
    await decideTlsAsk({ domain: 'shop.drobek.app', token: 'wrong', requestHost: 'drobek:3000' }, spy);
    await decideTlsAsk({ domain: 'firma.test', token: 'wrong', requestHost: 'drobek:3000' }, spy);
    await decideTlsAsk({ domain: 'firma.test', token: TOKEN, requestHost: 'drobek.app' }, spy);
    await decideTlsAsk({ domain: '203.0.113.7', token: TOKEN, requestHost: 'drobek:3000' }, spy);
    expect(seen).toEqual([]);
  });
});

describe('GET /api/internal/tls/ask over HTTP', () => {
  let server: Server;
  let port: number;
  let failing = false;

  beforeAll(async () => {
    const handler = createTlsAskHandler({
      token: TOKEN,
      hosts: PROD_HOSTS,
      appExists: async (slug) => {
        if (failing) throw new Error('db down');
        return LIVE.has(slug);
      },
      customDomainAllowed,
      log: noopLogger,
    });
    server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  function get(path: string, host = 'drobek:3000', headers: Record<string, string> = {}) {
    return new Promise<{ status: number; body: string; cache: string | undefined }>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path, headers: { host, ...headers }, setHost: false },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body, cache: res.headers['cache-control'] as string })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });
  }
  const q = (domain: string, token: string | null = TOKEN) =>
    `${TLS_ASK_PATH}?${token === null ? '' : `token=${token}&`}domain=${encodeURIComponent(domain)}`;

  it('existing slug → 200, uncacheable', async () => {
    const r = await get(q('shop--preview.drobek.app'));
    expect(r).toMatchObject({ status: 200, body: 'ok', cache: 'no-store' });
  });

  it('non-existing slug → 404', async () => {
    expect((await get(q('ghost.drobek.app'))).status).toBe(404);
  });

  it('no token → 401; wrong token → 401', async () => {
    expect((await get(q('shop.drobek.app', null))).status).toBe(401);
    expect((await get(q('shop.drobek.app', 'x'.repeat(40)))).status).toBe(401);
  });

  it('the token header works too', async () => {
    const r = await get(q('shop.drobek.app', null), 'drobek:3000', { 'x-drobek-tls-ask-token': TOKEN });
    expect(r.status).toBe(200);
  });

  it('hostname outside APPS_DOMAIN → 404 unless it is a verified custom domain (M3-01)', async () => {
    expect((await get(q('shop.example.com'))).status).toBe(404);
    expect((await get(q('firma.test'))).status).toBe(200);
  });

  it('a repeated token or domain parameter is refused', async () => {
    expect((await get(`${TLS_ASK_PATH}?token=${TOKEN}&token=${TOKEN}&domain=shop.drobek.app`)).status).toBe(401);
    expect((await get(`${q('shop.drobek.app')}&domain=ghost.drobek.app`)).status).toBe(404);
  });

  it('on the public dashboard host → 404', async () => {
    expect((await get(q('shop.drobek.app'), 'drobek.app')).status).toBe(404);
  });

  it('a lookup failure fails closed (503, no certificate)', async () => {
    failing = true;
    try {
      expect((await get(q('shop.drobek.app'))).status).toBe(503);
    } finally {
      failing = false;
    }
  });

  it('TLS_ASK_TOKEN unset → 404 even with a token', async () => {
    const off = createServer(
      createTlsAskHandler({ token: null, hosts: PROD_HOSTS, appExists, customDomainAllowed, log: noopLogger })
    );
    await new Promise<void>((r) => off.listen(0, '127.0.0.1', r));
    const offPort = (off.address() as { port: number }).port;
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: offPort, path: q('shop.drobek.app'), headers: { host: 'drobek:3000' }, setHost: false },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          }
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(404);
    } finally {
      await new Promise<void>((r) => off.close(() => r()));
    }
  });
});
