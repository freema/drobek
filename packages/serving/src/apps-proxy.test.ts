import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appsProxyConfig, forwardedHeaders, startAppsProxy } from './apps-proxy.js';

describe('appsProxyConfig', () => {
  it('needs both origins, bare http(s)', () => {
    expect(appsProxyConfig({})).toMatch(/APPS_PROXY_TARGET is not set/);
    expect(appsProxyConfig({ APPS_PROXY_TARGET: 'http://drobek.railway.internal:3000' })).toMatch(/APPS_BASE_URL is not set/);
    expect(appsProxyConfig({ APPS_PROXY_TARGET: 'http://d:3000/x', APPS_BASE_URL: 'https://a.example.com' })).toMatch(/bare origin/);
    expect(appsProxyConfig({ APPS_PROXY_TARGET: 'ftp://d', APPS_BASE_URL: 'https://a.example.com' })).toMatch(/http\(s\)/);
    const ok = appsProxyConfig({ APPS_PROXY_TARGET: 'http://drobek.railway.internal:3000', APPS_BASE_URL: 'https://Apps-XYZ.up.railway.app' });
    expect(typeof ok === 'object' && ok.appsHost).toBe('apps-xyz.up.railway.app');
  });
});

describe('forwardedHeaders', () => {
  it('forces Host, drops spoofable and hop-by-hop headers, keeps the rest', () => {
    const out = forwardedHeaders(
      {
        host: 'localhost:3041',
        'x-forwarded-host': 'localhost:3041',
        forwarded: 'host=localhost:3041',
        connection: 'keep-alive, x-secret',
        'x-secret': '1',
        'transfer-encoding': 'chunked',
        cookie: 'a=b',
        'content-type': 'application/json',
        'x-forwarded-for': '6.6.6.6, 1.2.3.4',
      },
      '10.0.0.9',
      'apps.example.com'
    );
    expect(out.host).toBe('apps.example.com');
    expect(out['x-forwarded-host']).toBeUndefined();
    expect(out.forwarded).toBeUndefined();
    expect(out['x-secret']).toBeUndefined();
    expect(out['transfer-encoding']).toBeUndefined();
    expect(out.cookie).toBe('a=b');
    expect(out['content-type']).toBe('application/json');
    // The rightmost hop (the platform edge's view of the client), never a client-supplied left entry.
    expect(out['x-real-ip']).toBe('1.2.3.4');
    expect(out['x-forwarded-for']).toBe('1.2.3.4');
  });

  it('prefers X-Real-IP, falls back to the TCP peer', () => {
    expect(forwardedHeaders({ 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' }, '10.0.0.9', 'a')['x-real-ip']).toBe('9.9.9.9');
    expect(forwardedHeaders({}, '10.0.0.9', 'a')['x-real-ip']).toBe('10.0.0.9');
  });
});

describe('the proxy over HTTP', () => {
  let upstream: Server;
  let proxy: Server;
  let proxyPort: number;
  let seen: { method?: string; url?: string; headers?: IncomingHttpHeaders; body?: string }[] = [];

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.url === '/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: one\n\n');
          setTimeout(() => res.end('data: two\n\n'), 50);
          return;
        }
        res.writeHead(201, { 'content-type': 'text/plain', 'set-cookie': ['x=1; Path=/apps/shop'], connection: 'close' });
        res.end(`ok ${req.headers.host}`);
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upPort = (upstream.address() as { port: number }).port;
    proxy = await startAppsProxy({ target: new URL(`http://127.0.0.1:${upPort}`), appsHost: 'apps.example.com' }, 0, '127.0.0.1');
    proxyPort = (proxy.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  function call(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string; chunks: number }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: proxyPort, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
        let body = '';
        let chunks = 0;
        res.on('data', (c: Buffer) => {
          chunks++;
          body += c.toString();
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, chunks }));
      });
      req.on('error', reject);
      req.end(opts.body);
    });
  }

  it('forwards method, raw path, body and status with Host forced to the apps host', async () => {
    seen = [];
    const r = await call('/apps/shop/__drobek/v1/data/x?q=%2e%2e', {
      method: 'POST',
      headers: { Host: 'localhost:3041', 'X-Forwarded-Host': 'localhost:3041', 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    expect(r.status).toBe(201);
    expect(r.body).toBe('ok apps.example.com');
    expect(r.headers['set-cookie']).toEqual(['x=1; Path=/apps/shop']);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/apps/shop/__drobek/v1/data/x?q=%2e%2e', body: '{"a":1}' });
    expect(seen[0].headers?.host).toBe('apps.example.com');
    expect(seen[0].headers?.['x-forwarded-host']).toBeUndefined();
  });

  it('streams server-sent events chunk by chunk', async () => {
    const r = await call('/events');
    expect(r.body).toBe('data: one\n\ndata: two\n\n');
    expect(r.chunks).toBeGreaterThanOrEqual(2);
  });

  it('answers /healthz itself', async () => {
    seen = [];
    const r = await call('/healthz');
    expect(r.status).toBe(200);
    expect(r.body).toBe('ok');
    expect(seen).toEqual([]);
  });

  it('is a plain 502 when drobek is unreachable', async () => {
    const dead = await startAppsProxy({ target: new URL('http://127.0.0.1:1'), appsHost: 'apps.example.com' }, 0, '127.0.0.1');
    const p = (dead.address() as { port: number }).port;
    const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: p, path: '/apps/x/' }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
    await new Promise<void>((r2) => dead.close(() => r2()));
    expect(r).toEqual({ status: 502, body: 'Bad gateway' });
  });
});
