/**
 * forwardToUpstream against a real local HTTP server (NSO-326): an upstream
 * that encodes its body despite `Accept-Encoding: identity` is decoded (gzip,
 * deflate — zlib or raw — and br) and the DECODED size is held to the cap;
 * the relayed headers are the allow-list.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProxyError } from './errors.js';
import { decodeBody, forwardToUpstream } from './forward.server.js';
import type { UpstreamRecord } from './upstreams.server.js';

const JSON_BODY = JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item ${i}` })) });

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (encoding: string, body: Buffer, extra: Record<string, string> = {}) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding, 'content-length': String(body.length), ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const raw = Buffer.from(JSON_BODY);
    switch (req.url) {
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
        res.writeHead(302, {
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

const upstream = (): UpstreamRecord => ({
  id: 'up_1',
  workspaceId: 'ws_1',
  name: 'local',
  baseUrl: `http://127.0.0.1:${port}`,
  allowedMethods: ['GET', 'HEAD'],
  allowedPathPrefixes: ['/'],
  authType: 'none',
  authHeaderName: null,
  allowedAppIds: [],
  secret: null,
});

const get = (path: string, method = 'GET', e: NodeJS.ProcessEnv = env()) =>
  forwardToUpstream({ upstream: upstream(), method, subpath: path, search: '', headers: new Headers(), env: e });

describe('forwardToUpstream — an encoded upstream body is decoded (NSO-326)', () => {
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

describe('forwardToUpstream — relayed headers (NSO-326)', () => {
  it('only allow-listed headers pass; an absolute Location is dropped; never cached', async () => {
    const r = await get('/headers');
    expect(r.status).toBe(302);
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
