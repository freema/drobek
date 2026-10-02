import { request as httpRequest, type Server } from 'node:http';
import { createReadableStreamFromReadable } from '@react-router/node';
import type { RequestHandler } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ASSET_UPLOAD_PATH_PREFIX } from '@drobek/apps';
import { DASHBOARD_BODY_CAP_EXEMPT_PATHS, installErrorReporter, resetErrorReporterForTests, type ErrorReportEvent } from '@drobek/core';
import { hasOwnBodyLimit } from '@drobek/dashboard/body-limits';
import { createTlsAskHandler } from '@drobek/serving';
import { createServerApp, type ServerApp } from './app.js';

const ASK_TOKEN = 't'.repeat(40);
const MAX_BODY = 64 * 1024;
let app: ServerApp;
let server: Server;
let baseUrl: string;

// Stands in for React Router: echoes the raw body so the test proves the MCP
// JSON parser never consumes a dashboard request stream. `/form/*` reads the
// body the way @react-router/express hands it to an action (a web stream over
// the request → `request.formData()`).
const rrHandler: RequestHandler = (req, res) => {
  if (req.path.startsWith('/explode')) throw new Error('handler blew up for zoe@corp.example');
  if (req.path.startsWith('/form/')) {
    const body = createReadableStreamFromReadable(req);
    const init = { method: req.method, headers: { 'content-type': String(req.headers['content-type']) }, body, duplex: 'half' };
    void new Request(`http://drobek.test${req.originalUrl}`, init as RequestInit)
      .formData()
      .then((fd) => res.json({ rr: true, fields: Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)])) }));
    return;
  }
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk: string) => (raw += chunk));
  req.on('end', () => res.json({ rr: true, path: req.path, raw }));
};

beforeAll(async () => {
  process.env.PUBLIC_APP_URL = 'http://drobek.test';
  process.env.APPS_DOMAIN = 'apps.drobek.test';
  delete process.env.PUBLIC_MCP_URL;
  process.env.TLS_ASK_TOKEN = ASK_TOKEN;
  // The custom-domain lookup is the domains table in production; no DB here.
  const tlsAsk = createTlsAskHandler({ customDomainAllowed: async (h) => h === 'firma.example.com' }) as RequestHandler;
  app = createServerApp({ rrHandler, tlsAsk, maxBodyBytes: MAX_BODY });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an ephemeral TCP port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

describe('single drobek process', () => {
  it('an unhandled error answers 500 JSON and reaches the error reporter without the query string', async () => {
    const reported: ErrorReportEvent[] = [];
    installErrorReporter({ id: 'sink', label: 'Sink', report: (e) => void reported.push(e) }, {});
    try {
      const res = await fetch(`${baseUrl}/explode/now?code=123456`, { headers: { cookie: 'drobek_session=s3cr3t' } });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ ok: false, error: 'internal' });
      await vi.waitFor(() => expect(reported).toHaveLength(1));
      expect(reported[0]).toMatchObject({
        message: 'request failed',
        error: { name: 'Error', message: 'handler blew up for [email]' },
        context: { kind: 'http', method: 'GET', route: '/explode/now', status: 500 },
      });
      expect(JSON.stringify(reported)).not.toMatch(/123456|s3cr3t|zoe@/);
    } finally {
      resetErrorReporterForTests();
    }
  });

  it('GET /health returns {ok:true}', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /version returns the core version + sha', async () => {
    const res = await fetch(`${baseUrl}/version`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; sha: string };
    expect(body.name).toBe('@drobek/core');
    expect(body.sha.length).toBeGreaterThan(0);
  });

  it('POST /mcp without a token → 401 with the RFC 9728 metadata pointer', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="http://drobek.test/.well-known/oauth-protected-resource/mcp"'
    );
  });

  it('serves protected-resource metadata on both well-known paths', async () => {
    for (const path of ['', '/mcp']) {
      const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource${path}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        resource: 'http://drobek.test/mcp',
        authorization_servers: ['http://drobek.test'],
      });
    }
  });

  it('hands everything else to React Router with the raw body intact', async () => {
    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email":"a@b.c"}',
    });
    expect(await res.json()).toEqual({ rr: true, path: '/login', raw: '{"email":"a@b.c"}' });
  });

  it('/mcp checks the Bearer before it reads a body: an anonymous oversized POST is a JSON-RPC 401', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(600 * 1024) }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 }, id: null });
  });

  it('exposes the MCP sessions for the shutdown', async () => {
    expect(app.mcp.sessionCount()).toBe(0);
    app.mcp.endListenStreams();
    await app.mcp.closeSessions();
    expect(app.mcp.sessionCount()).toBe(0);
  });
});

/** A raw request with an explicit Host header (fetch() cannot set Host). */
function raw(
  method: string,
  path: string,
  headers: Record<string, string>
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  const { port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('apps origin dispatch + dashboard CSRF', () => {
  it('a host under APPS_DOMAIN never reaches React Router, /mcp or /health', async () => {
    for (const path of ['/', '/login', '/mcp', '/health', '/workspaces/acme/apps/x']) {
      // The apex of APPS_DOMAIN names no app → the apps side answers 404 (no DB needed).
      const r = await raw('GET', path, { Host: 'apps.drobek.test' });
      expect(r.status, path).toBe(404);
      expect(r.body).not.toContain('"rr":true');
      expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    }
  });

  it('an invalid Host is a 400', async () => {
    const r = await raw('GET', '/', { Host: 'x--preview.apps.drobek.test:80.attacker' });
    expect(r.status).toBe(400);
  });

  // doc-lint: allow — names the retired dashboard-host app path to assert it is gone
  it('the dashboard has no app route: /:ws/app/:slug goes to React Router (which 404s it)', async () => {
    const r = await raw('GET', '/acme/app/shop', { Host: 'drobek.test' });
    expect(JSON.parse(r.body)).toMatchObject({ rr: true, path: '/acme/app/shop' });
  });

  it('a mutating dashboard request from an app origin is refused before React Router', async () => {
    const evil = await raw('POST', '/auth/logout', { Host: 'drobek.test', Origin: 'http://evil.apps.drobek.test' });
    expect(evil.status).toBe(403);
    expect(evil.body).not.toContain('"rr":true');
    const own = await raw('POST', '/auth/logout', { Host: 'drobek.test', Origin: 'http://drobek.test' });
    expect(JSON.parse(own.body)).toMatchObject({ rr: true });
    // The token endpoint is exempt (native / web MCP clients call it cross-origin).
    const token = await raw('POST', '/oauth/token', { Host: 'drobek.test', Origin: 'https://claude.ai' });
    expect(JSON.parse(token.body)).toMatchObject({ rr: true });
  });
});

/** A POST with a body (declared or chunked); a reset before any answer is status -1. */
function post(
  path: string,
  body: Buffer,
  opts: { chunked?: boolean; type?: string } = {}
): Promise<{ status: number; body: string }> {
  const { port } = new URL(baseUrl);
  const headers: Record<string, string> = { Host: 'drobek.test', 'Content-Type': opts.type ?? 'application/octet-stream' };
  if (opts.chunked) headers['Transfer-Encoding'] = 'chunked';
  else headers['Content-Length'] = String(body.length);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', (err: NodeJS.ErrnoException) => (err.code === 'ECONNRESET' || err.code === 'EPIPE' ? resolve({ status: -1, body: '' }) : reject(err)));
    if (opts.chunked) {
      for (let i = 0; i < body.length; i += 1024) req.write(body.subarray(i, i + 1024));
      req.end();
    } else {
      req.end(body);
    }
  });
}

describe('the request body cap in front of React Router (DASHBOARD_MAX_BODY_BYTES)', () => {
  const form = (fields: Record<string, string>) => Buffer.from(new URLSearchParams(fields).toString());
  const FORM = 'application/x-www-form-urlencoded';

  it('a body within the cap reaches the action intact — declared or chunked', async () => {
    const fields = { email: 'jiri@example.cz', note: 'ř'.repeat(8_000) };
    expect(form(fields).length).toBeLessThan(MAX_BODY);
    for (const chunked of [false, true]) {
      const r = await post('/form/login', form(fields), { chunked, type: FORM });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ rr: true, fields });
    }
  });

  it('a body over the cap → 413 before React Router (declared or chunked); the process keeps serving', async () => {
    const big = form({ email: 'a@b.c', pad: 'x'.repeat(MAX_BODY) });
    for (const path of ['/login', '/oauth/token']) {
      const declared = await post(path, big, { type: FORM });
      expect(declared.status, path).toBe(413);
      expect(JSON.parse(declared.body)).toMatchObject({ error: 'payload_too_large', details: { limit: 'DASHBOARD_MAX_BODY_BYTES', value: MAX_BODY } });
      expect(declared.body).not.toContain('"rr":true');
      const chunked = await post(path, big, { chunked: true, type: FORM });
      expect(chunked.status, path).toBe(413);
    }
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    const small = await post('/form/oauth/token', form({ grant_type: 'refresh_token' }), { chunked: true, type: FORM });
    expect(JSON.parse(small.body)).toEqual({ rr: true, fields: { grant_type: 'refresh_token' } });
  });

  it('the Data tab collection page (its CSV import) keeps its own limit; dot segments cannot borrow it', async () => {
    const big = Buffer.alloc(3 * MAX_BODY, 0x61);
    for (const path of ['/workspaces/acme/apps/shop/data/todos', '/workspaces/acme/apps/shop/data/todos.data']) {
      const r = await post(path, big);
      expect(JSON.parse(r.body), path).toMatchObject({ rr: true, raw: big.toString() });
    }
    expect((await post('/workspaces/acme/apps/shop/data/../settings', big)).status).toBe(413);
    expect((await post('/workspaces/acme/apps/shop/data/%2e%2e', big)).status).toBe(413);
  });

  it('the generated Caddyfile caps the same paths drobek caps (and leaves the ones with their own limits to drobek)', () => {
    // Caddy's path matcher: one trailing `*` is a prefix match, otherwise `*` spans one path segment.
    const caddyExempt = (p: string) =>
      DASHBOARD_BODY_CAP_EXEMPT_PATHS.some((pattern) =>
        pattern.indexOf('*') === pattern.length - 1
          ? p.startsWith(pattern.slice(0, -1))
          : new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`, 'i').test(p)
      );
    const drobekExempt = (p: string) => p === '/mcp' || p.startsWith(ASSET_UPLOAD_PATH_PREFIX) || hasOwnBodyLimit(p);
    const paths = [
      '/mcp',
      `${ASSET_UPLOAD_PATH_PREFIX}tok_123`,
      '/workspaces/acme/apps/shop/data/todos',
      '/workspaces/acme/apps/shop/data/todos.data',
      '/login',
      '/login/verify',
      '/oauth/token',
      '/oauth/register',
      '/report',
      '/workspaces/acme/apps/shop/data',
      '/workspaces/acme/apps/shop/data.data',
      '/workspaces/acme/apps/shop/settings',
    ];
    for (const p of paths) expect(caddyExempt(p), p).toBe(drobekExempt(p));
    expect(paths.filter(drobekExempt)).toHaveLength(4);
  });
});

describe('Caddy TLS ask endpoint', () => {
  const path = (token: string, domain: string) =>
    `/api/internal/tls/ask?token=${token}&domain=${encodeURIComponent(domain)}`;

  it('is mounted before React Router on the internal host', async () => {
    const wrong = await raw('GET', path('nope', 'x.apps.drobek.test'), { Host: 'drobek:3000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).not.toContain('"rr":true');
    const foreign = await raw('GET', path(ASK_TOKEN, 'x.example.com'), { Host: 'drobek:3000' });
    expect(foreign.status).toBe(404);
    expect(foreign.body).toBe('not found');
    // a verified custom domain gets its certificate.
    const custom = await raw('GET', path(ASK_TOKEN, 'firma.example.com'), { Host: 'drobek:3000' });
    expect(custom.status).toBe(200);
  });

  it('is never answered on the public dashboard host or an app host', async () => {
    const dash = await raw('GET', path(ASK_TOKEN, 'x.example.com'), { Host: 'drobek.test' });
    expect(dash.status).toBe(404);
    expect(dash.body).toBe('not found');
    const appHost = await raw('GET', path(ASK_TOKEN, 'x.example.com'), { Host: 'apps.drobek.test' });
    expect(appHost.status).toBe(404);
    expect(appHost.body).not.toBe('not found');
  });
});
