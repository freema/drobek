/**
 * The proxy module under createModuleTestContext(): the real route through the
 * production pipeline, PGlite with the core migrations (workspaces, apps,
 * upstreams + envelope-encrypted secrets) and a real local HTTP echo server
 * as the upstream (allowed through the test env: PROXY_ALLOWED_HOSTS +
 * PROXY_ALLOWED_PORTS — production allows ports 80/443 only).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { apps, setDbForTests, upstreamSecrets, upstreams, users, workspaces, type DB } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import { buildSdk, isDefinedModule, loadModules, type Principal } from '@drobek/modules';
import { createModuleTestContext } from '@drobek/modules/testing';
import { ProxyError, createUpstream, encryptSecret } from '@drobek/proxy';
import { createCore } from '@drobek/sdk';
import auth from 'drobek-module-auth';
import proxy, {
  createProxyModule,
  proxyAppInfo,
  proxyConfigSchema,
  proxyConfirmRequired,
  type ProxyConfig,
} from './index.js';
import proxySdk from './sdk.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../../packages/db/drizzle/migrations', import.meta.url));
const SECRET = 'sk-test-THIS-MUST-NEVER-LEAK-0123456789';
const HEADER_SECRET = 'hdr-secret-ALSO-NEVER-LEAKS-987654';

const ANON: Principal = { kind: 'anon' };
const USER: Principal = { kind: 'user', id: 'eu_u', email: 'u@example.com', role: 'user' };
const ADMIN: Principal = { kind: 'user', id: 'eu_a', email: 'a@example.com', role: 'admin' };

let pg: PGlite;
let db: DB;
let ws1: string;
let ws2: string;
let appA: string;
let server: http.Server;
let port: number;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end('redirecting');
      return;
    }
    if (url.pathname === '/cors') {
      res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'set-cookie': 'up=1', 'cache-control': 'max-age=600' });
      res.end('cors');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  env = { DROBEK_MASTER_KEY: 'ab'.repeat(32), PROXY_ALLOWED_HOSTS: '127.0.0.1', PROXY_ALLOWED_PORTS: String(port) } as NodeJS.ProcessEnv;

  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  db = d as unknown as DB;
  setDbForTests(db);
  const [u] = await d.insert(users).values({ email: 'owner@example.com' }).returning();
  const [w1] = await d.insert(workspaces).values({ kind: 'team', slug: 'proxy-ws', name: 'Proxy' }).returning();
  const [w2] = await d.insert(workspaces).values({ kind: 'team', slug: 'other-ws', name: 'Other' }).returning();
  ws1 = w1.id;
  ws2 = w2.id;
  const [a] = await d.insert(apps).values({ workspaceId: ws1, slug: 'chat', name: 'Chat' }).returning();
  appA = a.id;

  // Local upstreams are inserted directly: registration refuses 127.0.0.1 (a private literal) by design.
  const base = `http://127.0.0.1:${port}`;
  const add = async (workspaceId: string, name: string, over: Partial<typeof upstreams.$inferInsert>, secret?: string) => {
    const [row] = await d
      .insert(upstreams)
      .values({ workspaceId, name, baseUrl: base, allowedMethods: ['GET', 'HEAD', 'POST'], allowedPathPrefixes: ['/'], authType: 'none', createdBy: u.id, ...over })
      .returning();
    if (secret) await d.insert(upstreamSecrets).values({ upstreamId: row.id, ...encryptSecret(secret, env) });
  };
  await add(ws1, 'echo', { authType: 'bearer', allowedPathPrefixes: ['/v1', '/redirect', '/cors'] }, SECRET);
  await add(ws1, 'keyed', { authType: 'header', authHeaderName: 'X-Api-Key', allowedMethods: ['GET'] }, HEADER_SECRET);
  await add(ws1, 'open', {});
  await add(ws2, 'elsewhere', { authType: 'bearer' }, 'ws2-secret-never-used-1234567');
});

afterAll(async () => {
  setDbForTests(null as never);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pg.close();
});

const mod = () => createProxyModule({ env: () => env });

function t(config: Record<string, unknown>, principal: Principal = USER, limits?: Record<string, number>) {
  return createModuleTestContext(mod(), { db, app: { id: appA, slug: 'chat', workspaceId: ws1 }, config, principal, limits });
}

const SDK = { 'x-drobek-sdk': '1' };
type Echo = { method: string; path: string; query: string; headers: Record<string, string>; body: string };

describe('the module', () => {
  it('is a valid module; loads with auth; the SDK exposes drobek.proxy', async () => {
    expect(isDefinedModule(proxy)).toBe(true);
    const importer = async (pkg: string) => ({ 'drobek-module-auth': { default: auth }, 'drobek-module-proxy': { default: proxy } })[pkg];
    expect((await loadModules({ DROBEK_MODULES: 'auth,proxy' }, { importer })).map((m) => m.name)).toEqual(['auth', 'proxy']);
    const sdk = await buildSdk([auth, proxy]);
    expect(sdk.dts).toContain('readonly proxy: proxy.Api;');
    expect(sdk.dts).toContain('fetch(upstream: string, path?: string, init?: RequestInit): Promise<Response>;');
    expect(proxy.limits?.map((l) => [l.env, l.default])).toEqual([
      ['PROXY_CALLS_PER_MIN', 60],
      ['PROXY_PUBLIC_CALLS_PER_MIN_PER_IP', 10],
    ]);
  });

  it("the skill's React example (an OpenAI call behind <LoginGate>) compiles; the skill is ≤ 150 lines", async () => {
    const { compile } = await import('@drobek/compile');
    const sdk = await buildSdk([auth, proxy]);
    const example = /```tsx\n([\s\S]*?)```/.exec(proxy.skill.markdown)![1];
    const r = await compile(
      new Map([
        [
          'drobek.json',
          JSON.stringify({
            imports: {
              react: 'https://esm.sh/react@19.1.0',
              'react/jsx-runtime': 'https://esm.sh/react@19.1.0/jsx-runtime',
              'react-dom': 'https://esm.sh/react-dom@19.1.0?deps=react@19.1.0',
              'react-dom/client': 'https://esm.sh/react-dom@19.1.0/client?deps=react@19.1.0',
            },
          }),
        ],
        ['src/main.tsx', example],
        ['src/styles.css', 'body { margin: 0; }'],
      ]),
      { sdkUrl: sdk.url, sdkSources: sdk.inline }
    );
    expect(r.errors).toEqual([]);
    const out = r.outputs.get('main.js')!.toString('utf8');
    expect(out).toContain('function LoginGate(');
    expect(out).toContain('/v1/chat/completions');
    expect(proxy.skill.markdown.split('\n').length).toBeLessThanOrEqual(150);
  });

  it('SDK: drobek.proxy.fetch → a same-origin fetch of /__drobek/v1/proxy/<upstream><path> with X-Drobek-SDK: 1', async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      calls.push([input, init]);
      return new Response('{}', { status: 418 });
    });
    try {
      const api = proxySdk(createCore('proxy'));
      const res = await api.fetch('open ai', 'v1/x?y=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(418);
      expect(calls[0][0]).toBe('/__drobek/v1/proxy/open%20ai/v1/x?y=1');
      const h = new Headers(calls[0][1].headers);
      expect(h.get('x-drobek-sdk')).toBe('1');
      expect(h.get('content-type')).toBe('application/json');
      expect(calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{}' });
      await api.fetch('echo');
      expect(calls[1][0]).toBe('/__drobek/v1/proxy/echo/');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('config + confirmRequired', () => {
  it('fills the default call rule; refuses owner, unknown keys and bad names', () => {
    expect(proxyConfigSchema.parse({ upstreams: { echo: {} } })).toEqual({ upstreams: { echo: { rules: { call: 'user' } } } });
    expect(proxyConfigSchema.safeParse({ upstreams: { echo: { rules: { call: 'owner' } } } }).success).toBe(false);
    expect(proxyConfigSchema.safeParse({ upstreams: { echo: { rules: { call: 'user|admin' } } } }).success).toBe(true);
    expect(proxyConfigSchema.safeParse({ upstreams: { echo: { secret: 'x' } } }).success).toBe(false);
    expect(proxyConfigSchema.safeParse({ upstreams: { '1bad': {} } }).success).toBe(false);
    expect(proxyConfigSchema.safeParse({ upstreams: { echo: { rateLimit: 0 } } }).success).toBe(false);
  });

  it('assigning an upstream and opening it to public need the owner; the rest applies at once', () => {
    const p = (c: unknown) => proxyConfigSchema.parse(c) as ProxyConfig;
    const none = p({});
    const user = p({ upstreams: { echo: {} } });
    expect(proxyConfirmRequired(none, user)).toEqual([
      'proxy.upstreams.echo: this app may call the workspace upstream "echo" with its secret (callers: "user")',
    ]);
    expect(proxyConfirmRequired(none, p({ upstreams: { echo: { rules: { call: 'public' } } } }))).toEqual([
      'proxy.upstreams.echo: this app may call the workspace upstream "echo" with its secret (callers: "public")',
      'proxy.upstreams.echo.rules.call: (new) → "public" (anyone, signed in or not, may call it — limited per client IP)',
    ]);
    expect(proxyConfirmRequired(user, p({ upstreams: { echo: { rules: { call: 'user|public' } } } }))).toEqual([
      'proxy.upstreams.echo.rules.call: "user" → "user|public" (anyone, signed in or not, may call it — limited per client IP)',
    ]);
    expect(proxyConfirmRequired(user, p({ upstreams: { echo: { rules: { call: 'admin' } }, } }))).toEqual([]);
    expect(proxyConfirmRequired(user, p({ upstreams: { echo: { rateLimit: 5 } } }))).toEqual([]);
    expect(proxyConfirmRequired(user, none)).toEqual([]);
  });
});

describe('calls', () => {
  it('a signed-in user → the upstream gets the injected Bearer secret, never the Cookie / client Authorization / browser headers', async () => {
    const res = await t({ upstreams: { echo: {} } }).request('POST', '/echo/v1/items', {
      rawBody: 'hello=1',
      query: { a: '1' },
      headers: {
        ...SDK,
        'content-type': 'text/plain',
        cookie: 'drobek_eu=deadbeef',
        authorization: 'Bearer CLIENT',
        referer: 'http://test--preview.apps.localhost/page',
        'anthropic-version': '2023-06-01',
      },
    });
    expect(res.status).toBe(200);
    const e = res.body as Echo;
    expect(e).toMatchObject({ method: 'POST', path: '/v1/items', query: '?a=1', body: 'hello=1' });
    expect(e.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(e.headers.cookie).toBeUndefined();
    for (const h of ['origin', 'referer', 'x-drobek-sdk']) expect(e.headers[h], h).toBeUndefined();
    expect(e.headers['content-type']).toBe('text/plain');
    expect(e.headers['anthropic-version']).toBe('2023-06-01');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('a header-type upstream gets its secret in the named header; the raw query string passes as sent', async () => {
    const res = await t({ upstreams: { keyed: {} } }).request('GET', '/keyed/q', { headers: SDK, query: { tag: 'a b' } });
    expect(res.status).toBe(200);
    expect((res.body as Echo).headers['x-api-key']).toBe(HEADER_SECRET);
    expect((res.body as Echo).headers.authorization).toBeUndefined();
    expect((res.body as Echo).query).toBe('?tag=a+b');
  });

  it('every call needs X-Drobek-SDK: 1 — a plain GET is csrf_rejected (403)', async () => {
    const res = await t({ upstreams: { echo: {} } }).request('GET', '/echo/v1/x');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'csrf_rejected' });
  });

  it('an upstream not assigned to the app → 403; assigned but not registered in the workspace (or another workspace’s) → 404', async () => {
    const res = await t({ upstreams: { echo: {} } }).request('GET', '/open/x', { headers: SDK });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'forbidden', details: { reason: 'upstream_not_assigned', upstream: 'open' }, hint: "skill_info('proxy')" });
    const ghost = await t({ upstreams: { ghost: {}, elsewhere: {} } }).request('GET', '/ghost/x', { headers: SDK });
    expect(ghost.status).toBe(404);
    expect(ghost.body).toMatchObject({ error: 'not_found', details: { reason: 'upstream_not_registered' } });
    const foreign = await t({ upstreams: { elsewhere: {} } }).request('GET', '/elsewhere/x', { headers: SDK });
    expect(foreign.status).toBe(404);
  });

  it('the call rule: user → anon 401; admin → user 403, admin 200; public → anon 200', async () => {
    expect((await t({ upstreams: { open: {} } }, ANON).request('GET', '/open/x', { headers: SDK })).status).toBe(401);
    expect((await t({ upstreams: { open: { rules: { call: 'admin' } } } }, USER).request('GET', '/open/x', { headers: SDK })).status).toBe(403);
    expect((await t({ upstreams: { open: { rules: { call: 'admin' } } } }, ADMIN).request('GET', '/open/x', { headers: SDK })).status).toBe(200);
    expect((await t({ upstreams: { open: { rules: { call: 'public' } } } }, ANON).request('GET', '/open/x', { headers: SDK })).status).toBe(200);
    expect((await t({ upstreams: { open: { rules: { call: 'none' } } } }, ADMIN).request('GET', '/open/x', { headers: SDK })).status).toBe(403);
  });

  it("the upstream's allow-lists: a method → 405, a path outside the prefixes or a traversal → 403 path_not_allowed", async () => {
    const tt = t({ upstreams: { echo: {}, keyed: {} } });
    const m = await tt.request('POST', '/keyed/x', { headers: SDK, rawBody: 'x', });
    expect(m.status).toBe(405);
    expect(m.body).toMatchObject({ error: 'method_not_allowed' });
    const p = await tt.request('GET', '/echo/admin/x', { headers: SDK });
    expect(p.status).toBe(403);
    expect(p.body).toMatchObject({ error: 'path_not_allowed' });
    const trav = await tt.request('GET', '/echo/v1/%2e%2e/admin', { headers: SDK });
    expect(trav.status).toBe(403);
  });

  it('a redirect is returned verbatim, never followed; upstream CORS grants and cookies are dropped, never cached', async () => {
    const tt = t({ upstreams: { echo: {} } });
    const r = await tt.request('GET', '/echo/redirect', { headers: SDK });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('http://169.254.169.254/latest/meta-data/');
    const c = await tt.request('GET', '/echo/cors', { headers: SDK });
    expect(c.status).toBe(200);
    expect(c.body).toBe('cors');
    expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toContain('access-control-allow-origin');
    expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toContain('set-cookie');
    expect(c.headers['Cache-Control']).toBe('no-store');
    expect(Object.keys(c.headers).filter((k) => k.toLowerCase() === 'cache-control')).toEqual(['Cache-Control']);
  });

  it('the SSRF guard still applies: a registered upstream on a non-allowed port → 403 ssrf_blocked (+ audit)', async () => {
    const strict = createModuleTestContext(createProxyModule({ env: () => ({ ...env, PROXY_ALLOWED_PORTS: '80,443' }) }), {
      db,
      app: { id: appA, slug: 'chat', workspaceId: ws1 },
      config: { upstreams: { open: {} } },
      principal: USER,
    });
    const r = await strict.request('GET', '/open/x', { headers: SDK });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: 'ssrf_blocked' });
    expect(strict.audits).toEqual([{ action: 'proxy.blocked', meta: { upstream: 'open', reason: 'upstream port is not allowed' } }]);
  });
});

describe('rate limits', () => {
  it('the 61st call of an app within a minute → 429 rate_limited with Retry-After', async () => {
    const tt = t({ upstreams: { open: {} } }, USER, { PROXY_CALLS_PER_MIN: 60 });
    for (let i = 0; i < 60; i++) {
      const ok = await tt.request('GET', '/open/x', { headers: SDK });
      expect(ok.status, `call ${i + 1}`).toBe(200);
    }
    const r = await tt.request('GET', '/open/x', { headers: SDK });
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: 'rate_limited', details: { limit: 60, window_seconds: 60 } });
    expect(Number(r.headers['Retry-After'])).toBeGreaterThan(0);
  });

  it('a public upstream: 10 calls per minute per client IP (another IP still gets through)', async () => {
    const tt = t({ upstreams: { open: { rules: { call: 'public' } } } }, ANON);
    for (let i = 0; i < 10; i++) expect((await tt.request('GET', '/open/x', { headers: SDK, clientIp: '198.51.100.1' })).status).toBe(200);
    const r = await tt.request('GET', '/open/x', { headers: SDK, clientIp: '198.51.100.1' });
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: 'rate_limited', details: { limit: 10 } });
    expect((await tt.request('GET', '/open/x', { headers: SDK, clientIp: '198.51.100.2' })).status).toBe(200);
  });

  it("an assignment's own rateLimit caps that upstream", async () => {
    const tt = t({ upstreams: { open: { rateLimit: 2 } } });
    expect((await tt.request('GET', '/open/x', { headers: SDK })).status).toBe(200);
    expect((await tt.request('GET', '/open/x', { headers: SDK })).status).toBe(200);
    expect((await tt.request('GET', '/open/x', { headers: SDK })).status).toBe(429);
  });
});

describe('appInfo (get_app / configure_module) and registration', () => {
  it('lists the workspace upstreams with hasSecret — never a secret value, never another workspace', async () => {
    const config = proxyConfigSchema.parse({ upstreams: { echo: { rateLimit: 5 }, ghost: { rules: { call: 'admin' } } } });
    const info = await proxyAppInfo({ app: { id: appA, slug: 'chat', workspaceId: ws1 }, config, db, log: console as never });
    expect(info.upstreams).toEqual([
      { name: 'echo', registered: true, assigned: true, call: 'user', rateLimit: 5, hasSecret: true, allowedMethods: ['GET', 'HEAD', 'POST'], allowedPathPrefixes: ['/v1', '/redirect', '/cors'] },
      { name: 'ghost', registered: false, assigned: true, call: 'admin', hasSecret: false },
      { name: 'keyed', registered: true, assigned: false, hasSecret: true, allowedMethods: ['GET'], allowedPathPrefixes: ['/'] },
      { name: 'open', registered: true, assigned: false, hasSecret: false, allowedMethods: ['GET', 'HEAD', 'POST'], allowedPathPrefixes: ['/'] },
    ]);
    const text = JSON.stringify(info);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(HEADER_SECRET);
    expect(text).not.toContain('elsewhere');
    expect(text).not.toContain(String(port));
  });

  it('registering an upstream whose base_url has port 8080 → invalid_request; 443 registers (hasSecret, no value)', async () => {
    const [owner] = await pg.query<{ id: string }>(`SELECT id FROM users LIMIT 1`).then((r) => r.rows);
    const actor = { workspaceId: ws1, actorUserId: owner.id, role: 'workspace-admin' as const, env };
    const err = await createUpstream({
      ...actor,
      name: 'bad-port',
      baseUrl: 'https://api.example.com:8080',
      allowedMethods: ['GET'],
      allowedPathPrefixes: ['/'],
      authType: 'bearer',
      secret: 'whatever-secret-value',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProxyError);
    expect((err as ProxyError).code).toBe('invalid_request');
    const view = await createUpstream({
      ...actor,
      env: { DROBEK_MASTER_KEY: env.DROBEK_MASTER_KEY },
      name: 'good',
      baseUrl: 'https://api.example.com:443/v1',
      allowedMethods: ['GET'],
      allowedPathPrefixes: ['/'],
      authType: 'bearer',
      secret: 'another-secret-value-xyz',
    });
    expect(view).toMatchObject({ name: 'good', baseUrl: 'https://api.example.com/v1', hasSecret: true });
    expect(JSON.stringify(view)).not.toContain('another-secret-value-xyz');
  });
});
