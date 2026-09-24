/**
 * ssrfSafeForward against a real local HTTP server (NSO-297): the port
 * allow-list is re-asserted at CONNECT time (not only at registration), a
 * redirect is returned verbatim, the response cap and the deadline hold.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProxyError } from './errors.js';
import { ssrfSafeForward } from './ssrf.server.js';

let server: http.Server;
let port: number;
let hits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits += 1;
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end('redirecting');
      return;
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(4096, 1));
      return;
    }
    if (req.url === '/huge') {
      // A 10 MiB resource: HEAD answers only its length.
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(10 * 1024 * 1024) });
      if (req.method === 'HEAD') res.end();
      else res.end(Buffer.alloc(10 * 1024 * 1024, 1));
      return;
    }
    if (req.url === '/headers') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => res.end('late'), 2_000).unref();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const allowLocal = (): NodeJS.ProcessEnv =>
  ({ PROXY_ALLOWED_HOSTS: '127.0.0.1', PROXY_ALLOWED_PORTS: String(port) }) as NodeJS.ProcessEnv;

const url = (path: string) => new URL(`http://127.0.0.1:${port}${path}`);

describe('ssrfSafeForward — port allow-list at connect time', () => {
  it('refuses a non-allowed port before connecting (ssrf_blocked), even for an allow-listed host', async () => {
    const before = hits;
    const err = await ssrfSafeForward({
      url: url('/'),
      method: 'GET',
      headers: {},
      // default ports 80/443 only
      env: { PROXY_ALLOWED_HOSTS: '127.0.0.1' } as NodeJS.ProcessEnv,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProxyError);
    expect((err as ProxyError).code).toBe('ssrf_blocked');
    expect((err as Error).message).toMatch(/port/);
    expect(hits).toBe(before);
  });

  it('forwards when the port is allowed (PROXY_ALLOWED_PORTS) and the host is operator-allowed', async () => {
    const r = await ssrfSafeForward({ url: url('/'), method: 'GET', headers: {}, env: allowLocal() });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('ok');
  });

  it('an explicit allowedPorts set overrides the env list', async () => {
    const err = await ssrfSafeForward({
      url: url('/'),
      method: 'GET',
      headers: {},
      env: allowLocal(),
      allowedPorts: new Set([443]),
    }).catch((e: unknown) => e);
    expect((err as ProxyError).code).toBe('ssrf_blocked');
  });

  it('a private address is still blocked when the host is not operator-allowed', async () => {
    const err = await ssrfSafeForward({
      url: url('/'),
      method: 'GET',
      headers: {},
      env: { PROXY_ALLOWED_PORTS: String(port) } as NodeJS.ProcessEnv,
    }).catch((e: unknown) => e);
    expect((err as ProxyError).code).toBe('ssrf_blocked');
  });
});

describe('ssrfSafeForward — redirects, size cap, deadline', () => {
  it('returns a 3xx verbatim and never follows it', async () => {
    const r = await ssrfSafeForward({ url: url('/redirect'), method: 'GET', headers: {}, env: allowLocal() });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('http://169.254.169.254/latest/meta-data/');
  });

  it('refuses a response past the size cap', async () => {
    const err = await ssrfSafeForward({
      url: url('/big'),
      method: 'GET',
      headers: {},
      env: allowLocal(),
      maxResponseBytes: 1024,
    }).catch((e: unknown) => e);
    expect((err as ProxyError).code).toBe('upstream_error');
    expect((err as Error).message).toMatch(/size cap/);
  });

  it('gives up at the deadline', async () => {
    const err = await ssrfSafeForward({
      url: url('/slow'),
      method: 'GET',
      headers: {},
      env: allowLocal(),
      deadlineMs: 100,
    }).catch((e: unknown) => e);
    expect((err as ProxyError).code).toBe('upstream_error');
    expect((err as Error).message).toMatch(/timed out/);
  });
});

describe('ssrfSafeForward — HEAD and request framing (NSO-326)', () => {
  it('HEAD on a resource larger than the cap answers (the declared length is not a body)', async () => {
    const r = await ssrfSafeForward({ url: url('/huge'), method: 'HEAD', headers: {}, env: allowLocal(), maxResponseBytes: 1024 });
    expect(r.status).toBe(200);
    expect(r.headers['content-length']).toBe(String(10 * 1024 * 1024));
    expect(r.body.length).toBe(0);
  });

  it('GET on the same resource is still refused by its declared length', async () => {
    const err = await ssrfSafeForward({ url: url('/huge'), method: 'GET', headers: {}, env: allowLocal(), maxResponseBytes: 1024 }).catch(
      (e: unknown) => e
    );
    expect((err as ProxyError).code).toBe('upstream_error');
    expect((err as Error).message).toMatch(/size cap/);
  });

  it('a buffered request body goes out with Content-Length, never chunked (a caller-supplied length is replaced)', async () => {
    const body = Buffer.from(JSON.stringify({ hello: 'wörld' }));
    const r = await ssrfSafeForward({
      url: url('/headers'),
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Content-Length': '1', 'transfer-encoding': 'chunked' },
      body,
      env: allowLocal(),
    });
    const echo = JSON.parse(r.body.toString('utf8')) as { headers: Record<string, string>; body: string };
    expect(echo.headers['content-length']).toBe(String(body.length));
    expect(echo.headers['transfer-encoding']).toBeUndefined();
    expect(echo.body).toBe('{"hello":"wörld"}');
  });

  it('no body → no Content-Length and no chunked framing', async () => {
    const r = await ssrfSafeForward({ url: url('/headers'), method: 'GET', headers: {}, env: allowLocal() });
    const echo = JSON.parse(r.body.toString('utf8')) as { headers: Record<string, string> };
    expect(echo.headers['transfer-encoding']).toBeUndefined();
    expect(echo.headers['content-length']).toBeUndefined();
  });
});
