/**
 * The node:http adapter + host dispatch over a real HTTP server: dashboard
 * hosts fall through to `next()` (the dashboard), app hosts are answered here
 * and never reach it, invalid Hosts get a 400. Requests go to 127.0.0.1 with an
 * explicit Host header — exactly what a browser sends for `*.localhost`.
 */
import { request as httpRequest, createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BEACON_PATH as INSIGHTS_BEACON_PATH, handleBeacon, type BeaconRecorder } from '@drobek/insights';
import { BEACON_PATH } from './handler.js';
import { createAppsHostMiddleware } from './node.js';
import { ServeStore, type ServeLoaders } from './store.server.js';

const HTML = '<!doctype html><h1>hi</h1>';
const loaders: ServeLoaders = {
  resolve: async (t) =>
    t.slug === 'shop'
      ? { app: { id: 'a1', slug: 'shop', workspaceId: 'ws1', visibility: 'public', frameAncestors: null }, version: { id: 'v1', number: 1 } }
      : { app: null, version: null },
  loadFiles: async () => [{ path: 'index.html', kind: 'source', sha256: 'h'.repeat(64), size: HTML.length }],
  loadBlobs: async () => new Map([['h'.repeat(64), Buffer.from(HTML)]]),
  loadPasswordHash: async () => null,
};

let server: Server;
let port: number;
let dashboardHits: string[];

beforeAll(async () => {
  dashboardHits = [];
  const mw = createAppsHostMiddleware({
    hosts: { appsDomain: 'apps.localhost:3041', dashboardHost: 'localhost:3041' },
    store: new ServeStore({ loaders }),
    deps: { accessSecret: null, allowUnlockAttempt: async () => true, signal: () => {} },
  });
  server = createServer((req, res) =>
    mw(req, res, () => {
      dashboardHits.push(String(req.headers.host));
      res.setHeader('Set-Cookie', '__Host-drobek_session=x; Path=/; Secure; HttpOnly');
      res.end('dashboard');
    })
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function get(
  host: string | null,
  path = '/',
  headers: Record<string, string> = {},
  method = 'GET'
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, setHost: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (host !== null) req.setHeader('Host', host);
    req.end();
  });
}

describe('host dispatch', () => {
  it('an app host is answered by the apps handler and never reaches the dashboard', async () => {
    dashboardHits = [];
    const r = await get('shop--preview.apps.localhost:3041', '/');
    expect(r.status).toBe(200);
    expect(r.body).toBe(HTML);
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-robots-tag']).toBe('noindex');
    // Dashboard paths on an app host are app paths, not dashboard routes.
    for (const p of ['/mcp', '/login', '/oauth/token', '/workspaces', '/health']) {
      await get('shop.apps.localhost:3041', p);
    }
    expect(dashboardHits).toEqual([]);
  });

  it('the dashboard host goes to the dashboard (and never serves an app)', async () => {
    dashboardHits = [];
    const r = await get('localhost:3041', '/acme/app/shop');
    expect(r.body).toBe('dashboard');
    expect(dashboardHits).toEqual(['localhost:3041']);
  });

  it('a dashboard session cookie sent to an app host changes nothing; no Set-Cookie', async () => {
    const plain = await get('shop.apps.localhost:3041', '/');
    const withSession = await get('shop.apps.localhost:3041', '/', {
      Cookie: `__Host-drobek_session=${'a'.repeat(96)}; drobek_session=${'b'.repeat(96)}`,
    });
    expect(withSession.status).toBe(plain.status);
    expect(withSession.body).toBe(plain.body);
    expect(withSession.headers['set-cookie']).toBeUndefined();
    expect(plain.headers['set-cookie']).toBeUndefined();
  });

  it('X-Forwarded-Host cannot move a request between sides', async () => {
    dashboardHits = [];
    const r = await get('localhost:3041', '/', { 'X-Forwarded-Host': 'shop.apps.localhost:3041' });
    expect(r.body).toBe('dashboard');
    const a = await get('shop.apps.localhost:3041', '/', { 'X-Forwarded-Host': 'localhost:3041' });
    expect(a.body).toBe(HTML);
  });

  it('malformed / crafted Hosts: 400 or an apps-side 404, never the dashboard with app bytes', async () => {
    dashboardHits = [];
    const bad = await get('shop--preview.apps.localhost:3041.attacker', '/');
    expect(bad.status).toBe(400);
    expect(bad.headers['content-security-policy']).toBeTruthy();
    const deep = await get('a.shop.apps.localhost:3041', '/');
    expect(deep.status).toBe(404);
    const unknown = await get('nope-app.apps.localhost:3041', '/');
    expect(unknown.status).toBe(404);
    expect(unknown.headers['content-security-policy']).toBeTruthy();
    const upper = await get('SHOP.APPS.LOCALHOST.:3041', '/');
    expect(upper.body).toBe(HTML);
    expect(dashboardHits).toEqual([]);
  });

  it('path traversal on an app host is a 404', async () => {
    for (const p of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc%2fpasswd']) {
      expect((await get('shop.apps.localhost:3041', p)).status, p).toBe(404);
    }
  });

  it('an unlock POST with an oversized body is refused cleanly', async () => {
    const r = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/__drobek/password',
          method: 'POST',
          headers: { Host: 'shop.apps.localhost:3041', 'Content-Type': 'application/x-www-form-urlencoded' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        }
      );
      req.on('error', reject);
      req.end(`password=${'x'.repeat(10_000)}`);
    });
    // shop is public → the unlock path just redirects home.
    expect(r).toBe(303);
  });
});

/**
 * The browser error beacon on the apps origin (M1-07) over a real socket —
 * incl. the PHY-76 regression: an over-cap body (9 KiB, declared or chunked)
 * answers 413 and the process keeps serving (no stream cancel / destroy crash).
 */
describe('POST /__drobek/v1/_beacon', () => {
  let beaconServer: Server;
  let beaconPort: number;
  const stored: Parameters<BeaconRecorder>[0][] = [];
  const record: BeaconRecorder = async (input) => {
    stored.push(input);
    return { stored: 1 };
  };

  beforeAll(async () => {
    const mw = createAppsHostMiddleware({
      hosts: { appsDomain: 'apps.localhost:3041', dashboardHost: 'localhost:3041' },
      store: new ServeStore({ loaders }),
      deps: {
        accessSecret: null,
        allowUnlockAttempt: async () => true,
        signal: () => {},
        beacon: (req, app) => handleBeacon(req, app.id, { record }),
      },
    });
    beaconServer = createServer((req, res) => mw(req, res, () => res.end('dashboard')));
    await new Promise<void>((r) => beaconServer.listen(0, '127.0.0.1', r));
    beaconPort = (beaconServer.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => beaconServer.close(() => r()));
  });

  function post(body: Buffer | string, opts: { chunked?: boolean; headers?: Record<string, string> } = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const headers: Record<string, string> = { Host: 'shop--preview.apps.localhost:3041', 'Content-Type': 'application/json', ...opts.headers };
      if (!opts.chunked) headers['Content-Length'] = String(buf.length);
      const req = httpRequest({ host: '127.0.0.1', port: beaconPort, path: BEACON_PATH, method: 'POST', headers, setHost: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      // The server may answer 413 and stop reading before we finish writing.
      req.on('error', (err: NodeJS.ErrnoException) => (err.code === 'ECONNRESET' || err.code === 'EPIPE' ? resolve(-1) : reject(err)));
      if (opts.chunked) {
        for (let i = 0; i < buf.length; i += 1024) req.write(buf.subarray(i, i + 1024));
        req.end();
      } else {
        req.end(buf);
      }
    });
  }

  function getIndex(): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: beaconPort, path: '/', method: 'GET', headers: { Host: 'shop.apps.localhost:3041' }, setHost: false },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('is the same path in serving and insights', () => {
    expect(BEACON_PATH).toBe(INSIGHTS_BEACON_PATH);
  });

  it('stores a batch for the app behind the Host (204)', async () => {
    stored.length = 0;
    const status = await post(JSON.stringify({ events: [{ type: 'error', message: 'boom' }] }), {
      headers: { Origin: 'http://shop--preview.apps.localhost:3041' },
    });
    expect(status).toBe(204);
    expect(stored.map((s) => s.appId)).toEqual(['a1']);
  });

  it('9 KiB declared → 413, 9 KiB chunked → 413, and the process keeps serving', async () => {
    stored.length = 0;
    const nine = Buffer.alloc(9 * 1024, 0x78);
    expect(await post(nine)).toBe(413);
    expect(await post(nine, { chunked: true })).toBe(413);
    // Many at once: still no crash, still answering.
    const burst = await Promise.all(Array.from({ length: 10 }, () => post(nine, { chunked: true })));
    for (const s of burst) expect([413, -1]).toContain(s);
    expect(await getIndex()).toBe(200);
    expect(stored).toEqual([]);
  });

  it('a cross-origin POST is refused (403); GET is 405; an unknown app is a 404', async () => {
    expect(await post('{}', { headers: { Origin: 'https://evil.example' } })).toBe(403);
    const get = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: beaconPort, path: BEACON_PATH, method: 'GET', headers: { Host: 'shop.apps.localhost:3041' }, setHost: false },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(get).toBe(405);
    expect(await post('{}', { headers: { Host: 'nope-app.apps.localhost:3041' } })).toBe(404);
  });
});

/** M3-01: custom-domain candidates are resolved through the domains table (faked here). */
describe('custom domains', () => {
  let customServer: Server;
  let customPort: number;
  let hits: string[];
  let lookups: string[];
  const customLoaders: ServeLoaders = {
    ...loaders,
    resolve: async (t) =>
      t.slug === 'shop'
        ? {
            app: { id: 'a1', slug: 'shop', workspaceId: 'ws1', visibility: 'public', frameAncestors: null, primaryDomain: t.kind === 'prod' || t.kind === 'custom' ? 'firma.test' : null },
            version: { id: 'v1', number: 1 },
          }
        : { app: null, version: null },
    resolveCustomHost: async (hostname) => {
      lookups.push(hostname);
      if (hostname === 'boom.test') throw new Error('db down');
      if (hostname === 'firma.test') return { slug: 'shop' };
      if (hostname === 'pending.test') return { slug: null };
      return null;
    },
  };

  beforeAll(async () => {
    const mw = createAppsHostMiddleware({
      hosts: { appsDomain: 'apps.localhost:3041', dashboardHost: 'localhost:3041' },
      store: new ServeStore({ loaders: customLoaders }),
      deps: { accessSecret: null, allowUnlockAttempt: async () => true, signal: () => {} },
    });
    customServer = createServer((req, res) =>
      mw(req, res, () => {
        hits.push(String(req.headers.host));
        res.end('dashboard');
      })
    );
    await new Promise<void>((r) => customServer.listen(0, '127.0.0.1', r));
    customPort = (customServer.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => customServer.close(() => r()));
  });

  function fetchHost(host: string, path = '/'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: customPort, path, method: 'GET', headers: { Host: host }, setHost: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('a verified domain serves the app (published, indexable); the lookup is cached', async () => {
    hits = [];
    lookups = [];
    const r = await fetchHost('firma.test:3041');
    expect(r.status).toBe(200);
    expect(r.body).toBe(HTML);
    expect(r.headers['x-robots-tag']).toBeUndefined();
    await fetchHost('FIRMA.test.:3041', '/deep/link');
    expect(lookups).toEqual(['firma.test']);
    expect(hits).toEqual([]);
  });

  it('a registered but unverified domain is an apps-side 404; an unknown name stays the dashboard', async () => {
    hits = [];
    const pending = await fetchHost('pending.test:3041');
    expect(pending.status).toBe(404);
    expect(pending.headers['content-security-policy']).toBeTruthy();
    expect((await fetchHost('unknown.test:3041')).body).toBe('dashboard');
    // Not candidates at all: other ports, internal names.
    expect((await fetchHost('firma.test:9999')).body).toBe('dashboard');
    expect((await fetchHost('drobek:3000')).body).toBe('dashboard');
    expect(hits).toEqual(['unknown.test:3041', 'firma.test:9999', 'drobek:3000']);
  });

  it('a failed lookup is a 503, never the dashboard', async () => {
    hits = [];
    const r = await fetchHost('boom.test:3041');
    expect(r.status).toBe(503);
    expect(hits).toEqual([]);
  });

  it('the production host of an app with a primary domain 302s to it (apps scheme + port)', async () => {
    const r = await fetchHost('shop.apps.localhost:3041', '/p?q=1');
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('http://firma.test:3041/p?q=1');
    expect((await fetchHost('shop--preview.apps.localhost:3041')).status).toBe(200);
  });
});

describe('platform body streams + streamed responses (the files module)', () => {
  let platformServer: Server;
  let platformPort: number;
  const seen = { read: 0 };

  beforeAll(async () => {
    const mw = createAppsHostMiddleware({
      hosts: { appsDomain: 'apps.localhost:3041', dashboardHost: 'localhost:3041' },
      store: new ServeStore({ loaders }),
      deps: {
        accessSecret: null,
        allowUnlockAttempt: async () => true,
        signal: () => {},
        platform: async (req) => {
          if (req.method === 'GET') {
            return { status: 200, headers: { 'Content-Type': 'text/plain' }, body: Readable.from([Buffer.from('streamed '), Buffer.from('body')]) };
          }
          // Read at most 1 MiB, then give up: the rest must be discarded, not buffered, and the answer must arrive.
          const stream = req.bodyStream!();
          seen.read = 0;
          for await (const chunk of stream) {
            seen.read += chunk.length;
            if (seen.read > 1024 * 1024) break;
          }
          return { status: 413, headers: { 'Content-Type': 'application/json' }, body: '{"error":"payload_too_large"}' };
        },
      },
    });
    platformServer = createServer((req, res) => mw(req, res, () => res.end('dashboard')));
    await new Promise<void>((r) => platformServer.listen(0, '127.0.0.1', r));
    platformPort = (platformServer.address() as { port: number }).port;
  });
  afterAll(async () => {
    platformServer.closeAllConnections(); // the client agent keeps its socket alive
    await new Promise<void>((r) => platformServer.close(() => r()));
  });

  /** Settles once the answer arrived AND the whole body was written (an early answer precedes the end of the upload). */
  function send(method: string, body?: Buffer): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      let answer: { status: number; body: string } | null = null;
      let written = false;
      const settle = () => answer && written && resolve(answer);
      const req = httpRequest(
        { host: '127.0.0.1', port: platformPort, path: '/__drobek/v1/files', method, headers: { Host: 'shop.apps.localhost:3041' } },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (text += c));
          res.on('end', () => {
            answer = { status: res.statusCode ?? 0, body: text };
            settle();
          });
        }
      );
      req.on('error', reject);
      req.on('finish', () => {
        written = true;
        settle();
      });
      req.end(body);
    });
  }

  it('a route that stops reading answers normally; the unread rest is discarded (the client still gets the answer)', async () => {
    const r = await send('POST', Buffer.alloc(8 * 1024 * 1024, 1));
    expect(r).toEqual({ status: 413, body: '{"error":"payload_too_large"}' });
    expect(seen.read).toBeGreaterThan(1024 * 1024);
    expect(seen.read).toBeLessThan(3 * 1024 * 1024);
    // The connection is still usable afterwards.
    expect((await send('GET')).status).toBe(200);
  });

  it('a Readable body is piped to the client', async () => {
    expect(await send('GET')).toEqual({ status: 200, body: 'streamed body' });
  });
});
