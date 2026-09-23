import { request as httpRequest, type Server } from 'node:http';
import type { RequestHandler } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServerApp } from './app.js';

let server: Server;
let baseUrl: string;

// Stands in for React Router: echoes the raw body so the test proves the MCP
// JSON parser never consumes a dashboard request stream.
const rrHandler: RequestHandler = (req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk: string) => (raw += chunk));
  req.on('end', () => res.json({ rr: true, path: req.path, raw }));
};

beforeAll(async () => {
  process.env.PUBLIC_APP_URL = 'http://drobek.test';
  process.env.APPS_DOMAIN = 'apps.drobek.test';
  delete process.env.PUBLIC_MCP_URL;
  server = createServerApp({ rrHandler }).listen(0, '127.0.0.1');
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

  it('rejects an oversized MCP body with clean JSON', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(600 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: 'entity_too_large' });
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

describe('apps origin dispatch + dashboard CSRF (M0-06)', () => {
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
