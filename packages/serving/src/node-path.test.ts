/**
 * Path routing (APPS_ROUTING_MODE=path) over a real HTTP server: one apps host,
 * every app under /apps/<label>/. The app is decided by the server from the
 * literal first path segment; nothing on the apps host ever reaches the
 * dashboard, whatever the path, encoding or forwarding headers.
 */
import { request as httpRequest, createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppsHostMiddleware } from './node.js';
import { ServeStore, type ServeLoaders } from './store.server.js';

const HTML = '<!doctype html><html><head><title>t</title><script type="module" src="/main.js"></script></head><body><a href="/about">a</a></body></html>';
const OTHER = '<!doctype html><p>other</p>';
const loaders: ServeLoaders = {
  resolve: async (t) =>
    t.slug === 'shop'
      ? { app: { id: 'a1', slug: 'shop', workspaceId: 'ws1', visibility: 'public', frameAncestors: null }, version: { id: 'v1', number: 1 } }
      : t.slug === 'other'
        ? { app: { id: 'a2', slug: 'other', workspaceId: 'ws2', visibility: 'public', frameAncestors: null }, version: { id: 'v2', number: 1 } }
        : { app: null, version: null },
  loadFiles: async (versionId) => [
    { path: 'index.html', kind: 'source', sha256: (versionId === 'v1' ? 'h' : 'o').repeat(64), size: (versionId === 'v1' ? HTML : OTHER).length },
    ...(versionId === 'v1' ? [{ path: 'main.js', kind: 'source' as const, sha256: 'j'.repeat(64), size: 9 }] : []),
  ],
  loadBlobs: async () =>
    new Map([
      ['h'.repeat(64), Buffer.from(HTML)],
      ['o'.repeat(64), Buffer.from(OTHER)],
      ['j'.repeat(64), Buffer.from('console.1')],
    ]),
  loadPasswordHash: async () => null,
};

let server: Server;
let port: number;
let dashboardHits: string[] = [];
const APPS = 'apps.localhost:3041';

beforeAll(async () => {
  const mw = createAppsHostMiddleware({
    hosts: { appsDomain: APPS, dashboardHost: 'localhost:3041', mode: 'path' },
    store: new ServeStore({ loaders }),
    deps: { accessSecret: null, allowUnlockAttempt: async () => true, signal: () => {} },
    sharedScript: (req) =>
      req.path === '/__drobek/sdk.js' ? { status: 200, headers: { 'Content-Type': 'text/javascript' }, body: Buffer.from('export {}') } : null,
  });
  server = createServer((req, res) =>
    mw(req, res, () => {
      dashboardHits.push(`${req.headers.host}${req.url}`);
      res.end('dashboard');
    })
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function get(host: string, path: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, setHost: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setHeader('Host', host);
    req.end();
  });
}

describe('path routing', () => {
  it('serves an app under /apps/<slug>/ with <base> and prefixed root-absolute URLs', async () => {
    dashboardHits = [];
    const r = await get(APPS, '/apps/shop/');
    expect(r.status).toBe(200);
    expect(r.body).toContain('<head><base href="/apps/shop/"><meta name="drobek-base" content="/apps/shop/">');
    expect(r.body).toContain('src="/apps/shop/main.js"');
    expect(r.body).toContain('href="/apps/shop/about"');
    expect(r.headers['content-security-policy']).toBeTruthy();
    const js = await get(APPS, '/apps/shop/main.js');
    expect(js.status).toBe(200);
    expect(js.body).toBe('console.1');
    expect(dashboardHits).toEqual([]);
  });

  it('the injected preview + feedback scripts are prefixed exactly once and served under the base', async () => {
    const r = await get(APPS, '/apps/shop--preview/');
    expect(r.body).toContain('<script src="/apps/shop--preview/__drobek/preview.js"');
    expect(r.body).toContain('<script src="/apps/shop--preview/__drobek/feedback.js"');
    expect(r.body).not.toContain('/apps/shop--preview/apps/');
    expect((await get(APPS, '/apps/shop--preview/__drobek/preview.js')).status).toBe(200);
    expect((await get(APPS, '/apps/shop--preview/__drobek/feedback.js')).status).toBe(200);
  });

  it('a nested client route falls back to index.html of the same app', async () => {
    const r = await get(APPS, '/apps/shop/orders/42');
    expect(r.status).toBe(200);
    expect(r.body).toContain('<base href="/apps/shop/">');
  });

  it('the app comes from the path only: another app never answers for it', async () => {
    const r = await get(APPS, '/apps/other/');
    expect(r.body).toContain('<p>other</p>');
    expect(r.body).not.toContain('main.js');
    expect((await get(APPS, '/apps/other/main.js')).body).not.toBe('console.1');
  });

  it('redirects /apps/<label> to /apps/<label>/ (query kept); other methods are refused on the apps side', async () => {
    const r = await get(APPS, '/apps/shop?x=1');
    expect(r.status).toBe(308);
    expect(r.headers.location).toBe('/apps/shop/?x=1');
    const post = await get(APPS, '/apps/shop', {}, 'POST');
    expect([404, 405]).toContain(post.status);
    expect(post.body).not.toBe('dashboard');
  });

  it('serves the shared SDK at the root of the apps host', async () => {
    const r = await get(APPS, '/__drobek/sdk.js');
    expect(r.status).toBe(200);
    expect(r.body).toBe('export {}');
  });

  it('dashboard paths, encodings and traversal on the apps host are an apps-side 404, never the dashboard', async () => {
    dashboardHits = [];
    for (const p of [
      '/',
      '/mcp',
      '/api/apps',
      '/login',
      '/login/verify',
      '/oauth/authorize',
      '/oauth/token',
      '/.well-known/oauth-authorization-server',
      '/admin',
      '/workspaces',
      '/apps/',
      '/apps/%2e%2e/mcp',
      '/apps/../mcp',
      '/apps/shop%2F..%2Fmcp/',
      '/apps/nope-app/',
      '/apps/SHOP/',
      '/__drobek/v1/data/x',
      '/apps/shop/../../mcp',
      '/apps/shop/%2e%2e/%2e%2e/mcp',
    ]) {
      const r = await get(APPS, p);
      expect(r.status, p).toBe(404);
      expect(r.body, p).not.toBe('dashboard');
    }
    // A spoofed forwarding header changes nothing either.
    const spoofed = await get(APPS, '/mcp', { 'X-Forwarded-Host': 'localhost:3041', Forwarded: 'host=localhost:3041' });
    expect(spoofed.status).toBe(404);
    expect(dashboardHits).toEqual([]);
  });

  it('the dashboard host stays the dashboard, also for /apps/… paths', async () => {
    dashboardHits = [];
    const r = await get('localhost:3041', '/apps/shop/');
    expect(r.body).toBe('dashboard');
    expect(dashboardHits).toEqual(['localhost:3041/apps/shop/']);
  });

  it('refuses service-worker scripts (one origin is shared by every app)', async () => {
    const r = await get(APPS, '/apps/shop/main.js', { 'Service-Worker': 'script' });
    expect(r.status).toBe(404);
  });

  it('a port mismatch on the apps host is a 404, never an app or the dashboard', async () => {
    dashboardHits = [];
    const r = await get('apps.localhost:9999', '/apps/shop/');
    expect(r.status).toBe(404);
    expect(dashboardHits).toEqual([]);
  });
});
