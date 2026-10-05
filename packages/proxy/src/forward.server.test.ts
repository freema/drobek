/**
 * forwardToUpstream against a real local HTTP server: an upstream
 * that encodes its body despite `Accept-Encoding: identity` is decoded (gzip,
 * deflate — zlib or raw — and br) and the DECODED size is held to the cap;
 * the relayed headers are the allow-list; a redirect is followed only within
 * the upstream's origin and prefixes.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProxyError } from './errors.js';
import { encryptSecret } from './crypto.server.js';
import { decodeBody, forwardToUpstream } from './forward.server.js';
import type { UpstreamRecord } from './upstreams.server.js';

const JSON_BODY = JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item ${i}` })) });

let server: http.Server;
let port: number;
const seen: { method: string; path: string; key: string | undefined }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    seen.push({ method: req.method ?? '', path, key: req.headers['x-api-key'] as string | undefined });
    const redirect = (status: number, location: string) => {
      res.writeHead(status, { location, 'content-type': 'text/plain' });
      res.end('moved');
    };
    const hops = /^\/hops\/(\d+)$/.exec(path);
    if (hops) {
      const n = Number(hops[1]);
      return n === 0 ? (res.writeHead(200, { 'content-type': 'text/plain' }), res.end('landed')) : redirect(302, `/hops/${n - 1}`);
    }
    switch (path) {
      case '/sport/fotbal-vysledky':
        return redirect(301, `http://127.0.0.1:${port}/sport/fotbal-vysledky/`);
      case '/sport/fotbal-vysledky/':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('scores');
      case '/rss':
        return redirect(301, '/rss/');
      case '/rss/':
        res.writeHead(200, { 'content-type': 'application/rss+xml' });
        return res.end('<rss/>');
      case '/cross-host':
        return redirect(302, `http://localhost:${port}/sport/fotbal-vysledky/`);
      case '/cross-scheme':
        return redirect(302, `https://127.0.0.1:${port}/rss/`);
      case '/cross-port':
        return redirect(302, `http://127.0.0.1:${port + 1}/rss/`);
      case '/outside':
        return redirect(302, '/private/data?token=1');
      case '/ping':
        return redirect(302, '/pong');
      case '/pong':
        return redirect(302, '/ping');
      case '/self':
        return redirect(307, '/self');
      case '/no-location':
        res.writeHead(302, { 'content-type': 'text/plain' });
        return res.end('moved');
      case '/choices':
        return redirect(300, '/rss/');
      case '/not-modified':
        res.writeHead(304);
        return res.end();
      case '/post-303':
        return redirect(303, '/echo');
      case '/post-302':
        return redirect(302, '/echo');
      case '/post-307':
        return redirect(307, '/echo');
      case '/echo': {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        return;
      }
    }
    const send = (encoding: string, body: Buffer, extra: Record<string, string> = {}) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding, 'content-length': String(body.length), ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const raw = Buffer.from(JSON_BODY);
    switch (path) {
      case '/gzip':
        return send('gzip', zlib.gzipSync(raw));
      case '/deflate':
        return send('deflate', zlib.deflateSync(raw));
      case '/deflate-raw':
        return send('deflate', zlib.deflateRawSync(raw));
      case '/br':
        return send('br', zlib.brotliCompressSync(raw));
      case '/layered':
        // Applied in order: gzip first, then br — undone right to left.
        return send('gzip, br', zlib.brotliCompressSync(zlib.gzipSync(raw)));
      case '/bomb':
        // ~10 KiB on the wire, 8 MiB decoded.
        return send('gzip', zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024)));
      case '/compress':
        return send('compress', raw);
      case '/garbage':
        return send('gzip', Buffer.from('this is not gzip'));
      case '/headers':
        res.writeHead(201, {
          'content-type': 'text/plain',
          location: 'https://upstream.internal:8443/v1/next',
          'clear-site-data': '"*"',
          refresh: '0; url=/',
          link: '</evil.js>; rel=preload; as=script',
          'strict-transport-security': 'max-age=1',
          'service-worker-allowed': '/',
          'x-request-id': 'req_42',
          'cache-control': 'max-age=600',
        });
        return res.end('moved');
      default:
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('plain');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ PROXY_ALLOWED_HOSTS: '127.0.0.1', PROXY_ALLOWED_PORTS: String(port), ...over }) as NodeJS.ProcessEnv;

const upstream = (over: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_1',
  workspaceId: 'ws_1',
  name: 'local',
  baseUrl: `http://127.0.0.1:${port}`,
  allowedMethods: ['GET', 'HEAD'],
  allowedPathPrefixes: ['/'],
  authType: 'none',
  authHeaderName: null,
  allowedAppIds: [],
  allowStreaming: false,
  secret: null,
  ...over,
});

const get = (path: string, method = 'GET', e: NodeJS.ProcessEnv = env()) =>
  forwardToUpstream({ upstream: upstream(), method, subpath: path, search: '', headers: new Headers(), env: e });

describe('forwardToUpstream — an encoded upstream body is decoded', () => {
  for (const path of ['/gzip', '/deflate', '/deflate-raw', '/br', '/layered']) {
    it(`${path} → the plain JSON, no Content-Encoding relayed`, async () => {
      const r = await get(path);
      expect(r.status).toBe(200);
      expect(r.body?.toString('utf8')).toBe(JSON_BODY);
      expect(JSON.parse(r.body!.toString('utf8')).items).toHaveLength(50);
      const names = Object.keys(r.headers).map((k) => k.toLowerCase());
      expect(names).not.toContain('content-encoding');
      expect(names).not.toContain('content-length');
      expect(r.headers['content-type']).toBe('application/json');
    });
  }

  it('the DECODED size is capped: a small gzip that inflates past the cap → upstream_error', async () => {
    const err = await get('/bomb', 'GET', env({ PROXY_MAX_RESPONSE_BYTES: String(1024 * 1024) })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProxyError);
    expect((err as ProxyError).code).toBe('upstream_error');
    expect((err as Error).message).toMatch(/size cap/);
  });

  it('an unsupported or broken encoding → upstream_error (never relayed as if plain)', async () => {
    const unsupported = await get('/compress').catch((e: unknown) => e);
    expect((unsupported as ProxyError).code).toBe('upstream_error');
    expect((unsupported as Error).message).toMatch(/Content-Encoding "compress"/);
    const broken = await get('/garbage').catch((e: unknown) => e);
    expect((broken as ProxyError).code).toBe('upstream_error');
    expect((broken as Error).message).toMatch(/could not be decoded/);
  });

  it('HEAD is not decoded (no body)', async () => {
    const r = await get('/gzip', 'HEAD');
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
  });

  it('decodeBody: identity and no header are pass-through', async () => {
    const buf = Buffer.from('x');
    expect(await decodeBody(buf, undefined, 10)).toBe(buf);
    expect(await decodeBody(buf, 'identity', 10)).toBe(buf);
  });
});

describe('forwardToUpstream — relayed headers', () => {
  it('only allow-listed headers pass; an absolute Location is dropped; never cached', async () => {
    const r = await get('/headers');
    expect(r.status).toBe(201);
    const { date, ...rest } = r.headers; // Node's server adds Date by itself
    expect(date).toBeTruthy();
    expect(rest).toEqual({
      'content-type': 'text/plain',
      'x-request-id': 'req_42',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });
});

describe('forwardToUpstream — a caller\'s lower response cap', () => {
  const capped = (path: string, maxResponseBytes: number | undefined, e: NodeJS.ProcessEnv = env()) =>
    forwardToUpstream({ upstream: upstream(), method: 'GET', subpath: path, search: '', headers: new Headers(), env: e, maxResponseBytes });

  it('a cap below the body → upstream_error; the same call without one passes', async () => {
    const err = await capped('/gzip', 100).catch((e: unknown) => e);
    expect((err as ProxyError).code).toBe('upstream_error');
    const r = await capped('/gzip', undefined);
    expect(r.body?.toString('utf8')).toBe(JSON_BODY);
  });

  it('never raises the operator cap: the smaller of the two applies', async () => {
    const err = await capped('/bomb', 64 * 1024 * 1024, env({ PROXY_MAX_RESPONSE_BYTES: String(1024 * 1024) })).catch((e: unknown) => e);
    expect((err as ProxyError).code).toBe('upstream_error');
  });
});

describe('forwardToUpstream — redirects', () => {
  const call = (path: string, over: Partial<UpstreamRecord> = {}, method = 'GET', body?: Buffer, e: NodeJS.ProcessEnv = env()) =>
    forwardToUpstream({ upstream: upstream(over), method, subpath: path, search: '', headers: new Headers({ 'content-type': 'text/plain' }), body, env: e });
  const refused = async (p: Promise<unknown>): Promise<ProxyError> => {
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProxyError);
    expect((err as ProxyError).code).toBe('upstream_redirect');
    return err as ProxyError;
  };
  const prefixes = { allowedPathPrefixes: ['/rss', '/sport/fotbal-vysledky'] };

  it('a trailing-slash redirect inside the prefixes is followed (absolute and relative Location)', async () => {
    const sport = await call('/sport/fotbal-vysledky', prefixes);
    expect(sport.status).toBe(200);
    expect(sport.body?.toString('utf8')).toBe('scores');
    const rss = await call('/rss', prefixes);
    expect(rss.status).toBe(200);
    expect(rss.body?.toString('utf8')).toBe('<rss/>');
    expect(Object.keys(rss.headers).map((k) => k.toLowerCase())).not.toContain('location');
  });

  it('another host, scheme or port → upstream_redirect naming only the path', async () => {
    for (const path of ['/cross-host', '/cross-scheme', '/cross-port']) {
      const before = seen.length;
      const err = await refused(call(path));
      expect(err.details).toEqual({ location_path: path === '/cross-host' ? '/sport/fotbal-vysledky/' : '/rss/' });
      expect(err.message).not.toContain('localhost');
      expect(err.message).not.toContain('https:');
      expect(err.message).toMatch(/register the target host as its own upstream/);
      expect(seen.length - before, path).toBe(1);
    }
  });

  it('a path outside the allowed prefixes → upstream_redirect without the query', async () => {
    const err = await refused(call('/outside', { allowedPathPrefixes: ['/outside'] }));
    expect(err.details).toEqual({ location_path: '/private/data' });
    expect(err.message).toMatch(/allow that path prefix/);
  });

  it('at most 3 hops; a loop is refused', async () => {
    const three = await call('/hops/3');
    expect(three.body?.toString('utf8')).toBe('landed');
    const four = await refused(call('/hops/4'));
    expect(four.message).toMatch(/more than 3 redirects/);
    expect((await refused(call('/ping'))).message).toMatch(/loop/);
    expect((await refused(call('/self'))).message).toMatch(/loop/);
  });

  it('a redirect without Location, a 300 → upstream_redirect; a 304 passes', async () => {
    expect((await refused(call('/no-location'))).details).toEqual({ location_path: null });
    await refused(call('/choices'));
    const nm = await call('/not-modified');
    expect(nm.status).toBe(304);
  });

  it('303 and 302 after a POST become a GET without the body; 307 resends method and body', async () => {
    const methods = { allowedMethods: ['GET', 'POST'] };
    for (const path of ['/post-303', '/post-302']) {
      const r = await call(path, methods, 'POST', Buffer.from('payload'));
      const echoed = JSON.parse(r.body!.toString('utf8')) as { method: string; headers: Record<string, string>; body: string };
      expect(echoed.method, path).toBe('GET');
      expect(echoed.body).toBe('');
      expect(echoed.headers['content-type']).toBeUndefined();
      expect(echoed.headers['content-length']).toBeUndefined();
    }
    const kept = await call('/post-307', methods, 'POST', Buffer.from('payload'));
    expect(JSON.parse(kept.body!.toString('utf8'))).toMatchObject({ method: 'POST', body: 'payload' });
  });

  it('a redirect to a method the upstream does not allow → upstream_redirect', async () => {
    const err = await refused(call('/post-303', { allowedMethods: ['POST'] }, 'POST', Buffer.from('x')));
    expect(err.message).toMatch(/method GET is not allowed/);
  });

  it('the injected secret goes to every same-origin hop', async () => {
    const e = env({ DROBEK_MASTER_KEY: 'c'.repeat(64) });
    const keyed = { authType: 'header' as const, authHeaderName: 'X-Api-Key', secret: encryptSecret('k3y-value', e), ...prefixes };
    const before = seen.length;
    const r = await call('/rss', keyed, 'GET', undefined, e);
    expect(r.status).toBe(200);
    expect(seen.slice(before)).toEqual([
      { method: 'GET', path: '/rss', key: 'k3y-value' },
      { method: 'GET', path: '/rss/', key: 'k3y-value' },
    ]);
  });

  it('the size cap covers the whole chain', async () => {
    const err = await call('/rss', prefixes, 'GET', undefined, env({ PROXY_MAX_RESPONSE_BYTES: '7' })).catch((e: unknown) => e);
    expect((err as ProxyError).code).toBe('upstream_error');
  });
});
