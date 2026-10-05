/**
 * The proxy module under createModuleTestContext(): the real route through the
 * production pipeline, PGlite with the core migrations (workspaces, apps,
 * upstreams + envelope-encrypted secrets) and a real local HTTP echo server
 * as the upstream (allowed through the test env: PROXY_ALLOWED_HOSTS +
 * PROXY_ALLOWED_PORTS — production allows ports 80/443 only).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { apps, moduleConfigs, setDbForTests, upstreamSecrets, upstreams, users, workspaces, type DB } from '@drobek/db';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '@drobek/db/schema';
import { buildSdk, isDefinedModule, loadModules, type Principal } from '@drobek/modules';
import { createModuleTestContext } from '@drobek/modules/testing';
import { ProxyError, createUpstream, encryptSecret } from '@drobek/proxy';
import { createCore } from '@drobek/sdk';
import auth from 'drobek-module-auth';
import proxy, {
  createProxyModule,
  proxyHandler,
  proxyAppInfo,
  proxyConfigSchema,
  proxyConfirmRequired,
  proxyOnConfirmed,
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
/** Calls to /slow wait until the test resolves this. */
let releaseSlow: () => void = () => undefined;
let slowGate: Promise<void> = Promise.resolve();
/** /sse/hold streams its last event when the test resolves this. */
let releaseSse: () => void = () => undefined;
let sseGate: Promise<void> = Promise.resolve();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/slow') {
      void slowGate.then(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('slow');
      });
      return;
    }
    if (url.pathname === '/sse' || url.pathname === '/sse/hold' || url.pathname === '/sse/drop') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.write('data: one\n\n');
      if (url.pathname === '/sse/hold') {
        void sseGate.then(() => res.end('data: two\n\n'));
        return;
      }
      if (url.pathname === '/sse/drop') {
        setTimeout(() => res.destroy(), 20);
        return;
      }
      res.end('data: two\n\n');
      return;
    }
    if (url.pathname === '/gzip') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', location: 'https://upstream.internal/x' });
      res.end(gzipSync(Buffer.from('{"ok":true}')));
      return;
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end('redirecting');
      return;
    }
    if (url.pathname === '/v1/dir') {
      res.writeHead(301, { location: `http://127.0.0.1:${port}/v1/dir/` });
      res.end('moved');
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
      .values({
        workspaceId,
        name,
        baseUrl: base,
        allowedMethods: ['GET', 'HEAD', 'POST'],
        allowedPathPrefixes: ['/'],
        authType: 'none',
        createdBy: u.id,
        // An admin confirmed appA's assignments (onConfirmed) — the forward path checks it.
        allowedAppIds: workspaceId === ws1 ? [appA] : [],
        ...over,
      })
      .returning();
    if (secret) await d.insert(upstreamSecrets).values({ upstreamId: row.id, ...encryptSecret(secret, env) });
  };
  await add(ws1, 'echo', { authType: 'bearer', allowedPathPrefixes: ['/v1', '/redirect', '/cors'] }, SECRET);
  await add(ws1, 'keyed', { authType: 'header', authHeaderName: 'X-Api-Key', allowedMethods: ['GET'] }, HEADER_SECRET);
  await add(ws1, 'open', { allowStreaming: true });
  await add(ws2, 'elsewhere', { authType: 'bearer' }, 'ws2-secret-never-used-1234567');
});

afterAll(async () => {
  setDbForTests(null as never);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pg.close();
});

const mod = () => createProxyModule({ env: () => env });

/** Upstreams of ws1 whose allow-list does NOT name appA, for one test. */
async function withNarrowUpstreams(fn: () => Promise<void>): Promise<void> {
  const base = `http://127.0.0.1:${port}`;
  const common = { workspaceId: ws1, baseUrl: base, allowedMethods: ['GET'], allowedPathPrefixes: ['/'], authType: 'bearer' as const };
  const rows = await db
    .insert(upstreams)
    .values([
      { ...common, name: 'closed', allowedAppIds: [] },
      { ...common, name: 'theirs', allowedAppIds: ['app_someone_else'] },
    ])
    .returning();
  for (const row of rows) await db.insert(upstreamSecrets).values({ upstreamId: row.id, ...encryptSecret(`${row.name}-secret-never-used-12345`, env) });
  try {
    await fn();
  } finally {
    await db.delete(upstreams).where(and(eq(upstreams.workspaceId, ws1), inArray(upstreams.name, ['closed', 'theirs'])));
  }
}

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

  it("the skill's React example (a streamed Anthropic call behind <LoginGate>) compiles; the skill is ≤ 150 lines", async () => {
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
    expect(out).toContain('/v1/messages');
    expect(out).toContain('getReader');
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

  it('assigning an upstream and opening it to public need a workspace admin; the rest applies at once', async () => {
    const p = (c: unknown) => proxyConfigSchema.parse(c) as ProxyConfig;
    const none = p({});
    const user = p({ upstreams: { echo: {} } });
    // Every one needs a workspace ADMIN: only admins register upstreams.
    const admin = (change: string) => ({ change, confirmRole: 'admin' });
    const secret = new Map([['echo', true]]);
    expect(proxyConfirmRequired(none, user, secret)).toEqual([
      admin('proxy.upstreams.echo: this app may call the workspace upstream "echo" with its secret (callers: "user")'),
    ]);
    // No secret stored: the text does not claim one.
    expect(proxyConfirmRequired(none, user, new Map([['echo', false]]))).toEqual([
      admin('proxy.upstreams.echo: this app may call the workspace upstream "echo" (callers: "user")'),
    ]);
    expect(proxyConfirmRequired(none, p({ upstreams: { echo: { rules: { call: 'public' } } } }), secret)).toEqual([
      admin('proxy.upstreams.echo: this app may call the workspace upstream "echo" with its secret (callers: "public")'),
      admin('proxy.upstreams.echo.rules.call: (new) → "public" (anyone, signed in or not, may call it — limited per client IP)'),
    ]);
    expect(proxyConfirmRequired(user, p({ upstreams: { echo: { rules: { call: 'user|public' } } } }))).toEqual([
      admin('proxy.upstreams.echo.rules.call: "user" → "user|public" (anyone, signed in or not, may call it — limited per client IP)'),
    ]);
    // The module test context hands back the texts.
    expect(await t({}).confirm({}, { upstreams: { echo: {} } })).toEqual([
      'proxy.upstreams.echo: this app may call the workspace upstream "echo" with its secret (callers: "user")',
    ]);
    // A name nobody registered cannot be assigned (it could never be confirmed); removing one still can.
    await expect(t({}).confirm({}, { upstreams: { ghost: {} } })).rejects.toMatchObject({
      code: 'invalid_params',
      details: { reason: 'upstream_not_registered', upstreams: ['ghost'] },
    });
    expect(await t({}).confirm({ upstreams: { ghost: {} } }, {})).toEqual([]);
    expect(proxyConfirmRequired(user, p({ upstreams: { echo: { rules: { call: 'admin' } }, } }))).toEqual([]);
    expect(proxyConfirmRequired(user, p({ upstreams: { echo: { rateLimit: 5 } } }))).toEqual([]);
    expect(proxyConfirmRequired(user, none)).toEqual([]);
  });

  it('the record binding `id`: old name-only and new bound shapes both parse; a changed id needs an admin, a dropped one does not', () => {
    const p = (c: unknown) => proxyConfigSchema.parse(c) as ProxyConfig;
    // Old shape (name only) — still valid, unbound.
    expect(p({ upstreams: { echo: { rules: { call: 'user' } } } }).upstreams.echo.id).toBeUndefined();
    // New shape: bound to a record id.
    expect(p({ upstreams: { echo: { id: 'abc123xyz', rules: { call: 'user' } } } })).toEqual({
      upstreams: { echo: { id: 'abc123xyz', rules: { call: 'user' } } },
    });
    expect(proxyConfigSchema.safeParse({ upstreams: { echo: { id: '' } } }).success).toBe(false);
    expect(proxyConfigSchema.safeParse({ upstreams: { echo: { id: 'a b' } } }).success).toBe(false);
    expect(proxyConfigSchema.safeParse({ upstreams: { echo: { id: 5 } } }).success).toBe(false);

    const bound = p({ upstreams: { echo: { id: 'rec_1' } } });
    expect(proxyConfirmRequired(bound, p({ upstreams: { echo: { id: 'rec_2' } } }), new Map([['echo', true]]))).toEqual([
      { change: 'proxy.upstreams.echo.id: this app may call the upstream registered as "echo" now with its secret (callers: "user")', confirmRole: 'admin' },
    ]);
    // Binding a legacy (unbound) assignment by hand is a rebind too.
    expect(proxyConfirmRequired(p({ upstreams: { echo: {} } }), bound)).toHaveLength(1);
    // Dropping the id (e.g. a whole-assignment save) grants nothing: no confirmation.
    expect(proxyConfirmRequired(bound, p({ upstreams: { echo: { rules: { call: 'admin' } } } }))).toEqual([]);
    expect(proxyConfirmRequired(bound, p({ upstreams: { echo: { id: 'rec_1', rateLimit: 3 } } }))).toEqual([]);
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
    // Double encoding hides nothing: checked on the fully decoded segment.
    const double = await tt.request('GET', '/echo/v1/%252e%252e%252fadmin', { headers: SDK });
    expect(double.status).toBe(403);
    expect(double.body).toMatchObject({ error: 'path_not_allowed' });
    // A literal percent reaches the upstream canonically encoded.
    const pct = await tt.request('GET', '/echo/v1/a%2525b', { headers: SDK });
    expect(pct.status).toBe(200);
    expect((pct.body as Echo).path).toBe('/v1/a%25b');
  });

  it('a same-origin redirect inside the prefixes is followed; any other is 502 upstream_redirect without the foreign host; CORS grants and cookies are dropped, never cached', async () => {
    const tt = t({ upstreams: { echo: {} } });
    const slash = await tt.request('GET', '/echo/v1/dir', { headers: SDK });
    expect(slash.status).toBe(200);
    expect(slash.body).toMatchObject({ path: '/v1/dir/', headers: { authorization: `Bearer ${SECRET}` } });
    const r = await tt.request('GET', '/echo/redirect', { headers: SDK });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ error: 'upstream_redirect', details: { location_path: '/latest/meta-data/' } });
    expect(JSON.stringify(r.body)).not.toContain('169.254');
    expect(Object.keys(r.headers).map((k) => k.toLowerCase())).not.toContain('location');
    const c = await tt.request('GET', '/echo/cors', { headers: SDK });
    expect(c.status).toBe(200);
    expect(c.body).toBe('cors');
    expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toContain('access-control-allow-origin');
    expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toContain('set-cookie');
    expect(c.headers['Cache-Control']).toBe('no-store');
    expect(Object.keys(c.headers).filter((k) => k.toLowerCase() === 'cache-control')).toEqual(['Cache-Control']);
  });

  it("an upstream whose allow-list does not name the app → 403 upstream_not_allowed, nothing forwarded", async () => {
    await withNarrowUpstreams(async () => {
      for (const name of ['closed', 'theirs']) {
        const res = await t({ upstreams: { [name]: {} } }).request('GET', `/${name}/x`, { headers: SDK });
        expect(res.status, name).toBe(403);
        expect(res.body).toMatchObject({ error: 'forbidden', details: { reason: 'upstream_not_allowed', upstream: name } });
        expect(JSON.stringify(res.body)).not.toContain('secret-never-used');
      }
    });
  });

  it("an admin's confirmation puts the app on the allow-list of every upstream it newly assigns (onConfirmed; idempotent)", async () => {
    const allowed = async (name: string) =>
      (await db.select({ ids: upstreams.allowedAppIds }).from(upstreams).where(and(eq(upstreams.workspaceId, ws1), eq(upstreams.name, name))))[0].ids;
    const p = (c: unknown) => proxyConfigSchema.parse(c) as ProxyConfig;
    const context = { app: { id: appA, slug: 'chat', workspaceId: ws1 }, db, userId: 'u_admin', role: 'admin' as const, audit: async () => {} };
    await withNarrowUpstreams(async () => {
      // An upstream the app already had is not touched; a new one (and one not registered) is.
      await proxyOnConfirmed(p({ upstreams: { theirs: {} } }), p({ upstreams: { theirs: {}, closed: {}, ghost: {} } }), context);
      expect(await allowed('closed')).toEqual([appA]);
      expect(await allowed('theirs')).toEqual(['app_someone_else']);
      await proxyOnConfirmed(p({}), p({ upstreams: { closed: {} } }), context);
      expect(await allowed('closed')).toEqual([appA]);
      const res = await t({ upstreams: { closed: {} } }).request('GET', '/closed/x', { headers: SDK });
      expect(res.status).toBe(200);
    });
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

describe('assignments are bound to the upstream RECORD, not its name', () => {
  const idOf = async (name: string, workspaceId = ws1) =>
    (await db.select({ id: upstreams.id }).from(upstreams).where(and(eq(upstreams.workspaceId, workspaceId), eq(upstreams.name, name))))[0].id;
  const storedConfig = async () =>
    (await db.select({ config: moduleConfigs.config }).from(moduleConfigs).where(and(eq(moduleConfigs.appId, appA), eq(moduleConfigs.module, 'proxy'))))[0]
      ?.config as { upstreams: Record<string, { id?: string }> } | undefined;
  const setStored = async (config: Record<string, unknown>) => {
    await db.delete(moduleConfigs).where(and(eq(moduleConfigs.appId, appA), eq(moduleConfigs.module, 'proxy')));
    await db.insert(moduleConfigs).values({ appId: appA, module: 'proxy', config });
  };

  it('a bound assignment whose record is still registered → the call goes through', async () => {
    const res = await t({ upstreams: { open: { id: await idOf('open') } } }).request('GET', '/open/x', { headers: SDK });
    expect(res.status).toBe(200);
  });

  it('deleted and re-registered under the same name → 403 upstream_replaced, nothing forwarded — even with the app on the new allow-list', async () => {
    const oldId = await idOf('open');
    const [row] = await db.select().from(upstreams).where(eq(upstreams.id, oldId));
    await db.delete(upstreams).where(eq(upstreams.id, oldId));
    const { id: _drop, createdAt: _c, ...rest } = row;
    // Worst case: the new record even names the app (an operator copied the row).
    const [fresh] = await db.insert(upstreams).values({ ...rest, allowedAppIds: [appA] }).returning();
    try {
      const res = await t({ upstreams: { open: { id: oldId, rules: { call: 'public' } } } }, ANON).request('GET', '/open/x', { headers: SDK });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'forbidden', details: { reason: 'upstream_replaced', upstream: 'open' } });
      expect((res.body as { message: string }).message).toMatch(/Remove it from the proxy config and add it again/);
      // Bound to the new record → through.
      expect((await t({ upstreams: { open: { id: fresh.id } } }).request('GET', '/open/x', { headers: SDK })).status).toBe(200);
    } finally {
      // Keep the rest of the suite on a record that names appA.
      await db.update(upstreams).set({ allowedAppIds: [appA] }).where(eq(upstreams.id, fresh.id));
    }
  });

  it('an old name-only config: the first call on a record that names the app binds it lazily (the stored JSON gains the id)', async () => {
    await setStored({ upstreams: { open: { rules: { call: 'user' } }, keyed: {} } });
    try {
      const res = await t({ upstreams: { open: { rules: { call: 'user' } }, keyed: {} } }).request('GET', '/open/x', { headers: SDK });
      expect(res.status).toBe(200);
      expect(await storedConfig()).toEqual({ upstreams: { open: { rules: { call: 'user' }, id: await idOf('open') }, keyed: {} } });
      // Idempotent: a second call keeps the same binding.
      await t({ upstreams: { open: { id: await idOf('open') } } }).request('GET', '/open/x', { headers: SDK });
      expect((await storedConfig())?.upstreams.open.id).toBe(await idOf('open'));
    } finally {
      await db.delete(moduleConfigs).where(and(eq(moduleConfigs.appId, appA), eq(moduleConfigs.module, 'proxy')));
    }
  });

  it('an old name-only config on a record that does NOT name the app → 403, nothing bound', async () => {
    await withNarrowUpstreams(async () => {
      await setStored({ upstreams: { closed: {} } });
      try {
        const res = await t({ upstreams: { closed: {} } }).request('GET', '/closed/x', { headers: SDK });
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ details: { reason: 'upstream_not_allowed' } });
        expect(await storedConfig()).toEqual({ upstreams: { closed: {} } });
      } finally {
        await db.delete(moduleConfigs).where(and(eq(moduleConfigs.appId, appA), eq(moduleConfigs.module, 'proxy')));
      }
    });
  });

  it("an admin's confirmation binds a new assignment to the record's id; a rebind moves it to the record registered now", async () => {
    const p = (c: unknown) => proxyConfigSchema.parse(c) as ProxyConfig;
    const context = { app: { id: appA, slug: 'chat', workspaceId: ws1 }, db, userId: 'u_admin', role: 'admin' as const, audit: async () => {} };
    await withNarrowUpstreams(async () => {
      // The runtime has written the confirmed config (without an id) before onConfirmed runs.
      await setStored({ upstreams: { closed: {}, ghost: {} } });
      try {
        await proxyOnConfirmed(p({}), p({ upstreams: { closed: {}, ghost: {} } }), context);
        // `ghost` is not registered: stays unbound.
        expect(await storedConfig()).toEqual({ upstreams: { closed: { id: await idOf('closed') }, ghost: {} } });

        // A written id that differs (a rebind) is replaced by the record registered under the name now.
        await setStored({ upstreams: { theirs: { id: 'stale_id' } } });
        await proxyOnConfirmed(p({ upstreams: { theirs: { id: 'older_id' } } }), p({ upstreams: { theirs: { id: 'stale_id' } } }), context);
        expect(await storedConfig()).toEqual({ upstreams: { theirs: { id: await idOf('theirs') } } });
        const allowed = (await db.select({ ids: upstreams.allowedAppIds }).from(upstreams).where(eq(upstreams.id, await idOf('theirs'))))[0].ids;
        expect(allowed).toEqual(['app_someone_else', appA]);
      } finally {
        await db.delete(moduleConfigs).where(and(eq(moduleConfigs.appId, appA), eq(moduleConfigs.module, 'proxy')));
      }
    });
  });
});

describe('an encoded upstream body is decoded; headers are the allow-list', () => {
  it('a gzipped JSON answer reaches the app as plain JSON, without Content-Encoding or the absolute Location', async () => {
    const res = await t({ upstreams: { open: {} } }).request('GET', '/open/gzip', { headers: SDK });
    expect(res.status).toBe(200);
    const names = Object.keys(res.headers).map((k) => k.toLowerCase());
    expect(names).not.toContain('content-encoding');
    expect(names).not.toContain('location');
    const body = Buffer.isBuffer(res.body) ? JSON.parse(res.body.toString('utf8')) : res.body;
    expect(body).toEqual({ ok: true });
  });
});

describe('concurrent calls', () => {
  it('PROXY_MAX_CONCURRENT_PER_APP: a call over the cap → 429 proxy_busy with Retry-After; the slot frees when a call ends', async () => {
    slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const tt = createModuleTestContext(createProxyModule({ env: () => ({ ...env, PROXY_MAX_CONCURRENT_PER_APP: '2' }) }), {
      db,
      app: { id: appA, slug: 'chat', workspaceId: ws1 },
      config: { upstreams: { open: {} } },
      principal: USER,
    });
    const inFlight = [tt.request('GET', '/open/slow', { headers: SDK }), tt.request('GET', '/open/slow', { headers: SDK })];
    // Let both reach the upstream (they hold their slots while it waits).
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 10));
    const busy = await tt.request('GET', '/open/x', { headers: SDK });
    expect(busy.status).toBe(429);
    expect(busy.body).toMatchObject({ error: 'proxy_busy' });
    expect(busy.headers['Retry-After']).toBe('1');
    releaseSlow();
    for (const r of await Promise.all(inFlight)) expect(r.status).toBe(200);
    slowGate = Promise.resolve();
    expect((await tt.request('GET', '/open/x', { headers: SDK })).status).toBe(200);
  });
});

describe('streamed answers (text/event-stream)', () => {
  const callerEnv = (n: string) => createProxyModule({ env: () => ({ ...env, PROXY_MAX_CONCURRENT_PER_CALLER: n }) });
  const tc = (n: string, principal: Principal = USER) =>
    createModuleTestContext(callerEnv(n), { db, app: { id: appA, slug: 'chat', workspaceId: ws1 }, config: { upstreams: { open: {} } }, principal });

  /** The route handler called directly, so the test holds the streamed body. */
  async function direct(n: string, path: string, principal: Principal = USER, method = 'GET') {
    const tt = tc(n, principal);
    const handler = proxyHandler({ env: () => ({ ...env, PROXY_MAX_CONCURRENT_PER_CALLER: n }) });
    const req = {
      method,
      path: `/open${path}`,
      params: { upstream: 'open', '*': path.slice(1) },
      query: {},
      rawQuery: '',
      body: undefined,
      header: (h: string) => (h.toLowerCase() === 'x-drobek-sdk' ? '1' : null),
      headers: () => ({ 'x-drobek-sdk': '1' }),
      clientIp: '198.51.100.9',
      file: async () => {
        throw new Error('no file');
      },
    };
    const out = (await handler(req as never, tt.ctx)) as { status: number; headers: Record<string, string>; body: unknown };
    return { tt, out };
  }

  const settle = () => new Promise((r) => setTimeout(r, 30));

  it('an SSE answer is relayed as a stream (X-Accel-Buffering: no, no-store) and logged with streamed + end_reason when it ends', async () => {
    const info = vi.fn();
    const tt = createModuleTestContext(mod(), {
      db,
      app: { id: appA, slug: 'chat', workspaceId: ws1 },
      config: { upstreams: { open: {} } },
      principal: USER,
      log: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });
    const r = await tt.request('GET', '/open/sse', { headers: SDK });
    expect(r.status).toBe(200);
    expect(r.bytes.toString('utf8')).toBe('data: one\n\ndata: two\n\n');
    expect(r.headers).toMatchObject({ 'content-type': 'text/event-stream', 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-store' });
    await settle();
    expect(info).toHaveBeenCalledWith('proxy call', expect.objectContaining({ status: 200, streamed: true, end_reason: 'end', bytes: 22 }));
  });

  it("the handler answers a Readable; the caller's slot is held until the stream ends", async () => {
    sseGate = new Promise<void>((resolve) => {
      releaseSse = resolve;
    });
    const { tt, out } = await direct('1', '/sse/hold');
    expect(out.body).toBeInstanceOf(Readable);
    const busy = await tt.request('GET', '/open/x', { headers: SDK });
    expect(busy.status).toBe(429);
    expect(busy.body).toMatchObject({ error: 'proxy_busy', message: expect.stringMatching(/this visitor/) });
    releaseSse();
    const chunks: Buffer[] = [];
    for await (const c of out.body as Readable) chunks.push(Buffer.from(c as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('data: one\n\ndata: two\n\n');
    await settle();
    expect((await tt.request('GET', '/open/x', { headers: SDK })).status).toBe(200);
    sseGate = Promise.resolve();
  });

  it('the slot is released when the client leaves (the Readable destroyed)', async () => {
    sseGate = new Promise<void>((resolve) => {
      releaseSse = resolve;
    });
    const { tt, out } = await direct('1', '/sse/hold');
    expect((await tt.request('GET', '/open/x', { headers: SDK })).status).toBe(429);
    (out.body as Readable).destroy();
    await settle();
    expect((await tt.request('GET', '/open/x', { headers: SDK })).status).toBe(200);
    releaseSse();
    sseGate = Promise.resolve();
  });

  it('the slot is released when the upstream drops the stream', async () => {
    const { tt, out } = await direct('1', '/sse/drop');
    const err = await (async () => {
      for await (const _ of out.body as Readable) {
        /* drain */
      }
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProxyError);
    await settle();
    expect((await tt.request('GET', '/open/x', { headers: SDK })).status).toBe(200);
  });

  it('an upstream without allowStreaming gets its SSE answer buffered in one piece; the slot is released at once', async () => {
    await db.update(upstreams).set({ allowStreaming: false }).where(and(eq(upstreams.workspaceId, ws1), eq(upstreams.name, 'open')));
    try {
      const { tt, out } = await direct('1', '/sse');
      expect(out.status).toBe(200);
      expect(Buffer.isBuffer(out.body)).toBe(true);
      expect((out.body as Buffer).toString('utf8')).toBe('data: one\n\ndata: two\n\n');
      expect(out.headers['X-Accel-Buffering']).toBeUndefined();
      expect((await tt.request('GET', '/open/x', { headers: SDK })).status).toBe(200);
    } finally {
      await db.update(upstreams).set({ allowStreaming: true }).where(and(eq(upstreams.workspaceId, ws1), eq(upstreams.name, 'open')));
    }
  });

  it('HEAD on an SSE path is not streamed (no body); its slot is released at once', async () => {
    const { tt, out } = await direct('1', '/sse', USER, 'HEAD');
    expect(out.status).toBe(200);
    expect(out.body).toBeNull();
    expect((await tt.request('GET', '/open/x', { headers: SDK })).status).toBe(200);
  });

  it('PROXY_MAX_CONCURRENT_PER_CALLER is per caller: another signed-in user and an anonymous IP still get a slot', async () => {
    sseGate = new Promise<void>((resolve) => {
      releaseSse = resolve;
    });
    const held = await direct('1', '/sse/hold');
    expect((await held.tt.request('GET', '/open/x', { headers: SDK })).status).toBe(429);
    expect((await tc('1', ADMIN).request('GET', '/open/x', { headers: SDK })).status).toBe(200);
    const anon = createModuleTestContext(callerEnv('1'), {
      db,
      app: { id: appA, slug: 'chat', workspaceId: ws1 },
      config: { upstreams: { open: { rules: { call: 'public' } } } },
      principal: ANON,
    });
    expect((await anon.request('GET', '/open/x', { headers: SDK, clientIp: '203.0.113.5' })).status).toBe(200);
    releaseSse();
    (held.out.body as Readable).destroy();
    sseGate = Promise.resolve();
    await settle();
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

  it('a public upstream without a resolved client IP: no shared per-IP bucket, the app-wide limit still applies', async () => {
    const tt = t({ upstreams: { open: { rules: { call: 'public' } } } }, ANON, { PROXY_CALLS_PER_MIN: 15 });
    for (let i = 0; i < 15; i++) {
      expect((await tt.request('GET', '/open/x', { headers: SDK, clientIp: null })).status, `call ${i + 1}`).toBe(200);
    }
    const r = await tt.request('GET', '/open/x', { headers: SDK, clientIp: null });
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: 'rate_limited', details: { limit: 15 } });
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
      { name: 'echo', registered: true, assigned: true, call: 'user', rateLimit: 5, hasSecret: true, allowedMethods: ['GET', 'HEAD', 'POST'], allowedPathPrefixes: ['/v1', '/redirect', '/cors'], allowStreaming: false },
      { name: 'ghost', registered: false, assigned: true, call: 'admin', hasSecret: false },
      { name: 'keyed', registered: true, assigned: false, hasSecret: true, allowedMethods: ['GET'], allowedPathPrefixes: ['/'], allowStreaming: false },
      { name: 'open', registered: true, assigned: false, hasSecret: false, allowedMethods: ['GET', 'HEAD', 'POST'], allowedPathPrefixes: ['/'], allowStreaming: true },
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

describe('the upstreams authority (a module job calls an upstream)', () => {
  const view = (config: unknown) => ({
    app: { id: appA, slug: 'chat', workspaceId: ws1 },
    config: proxyConfigSchema.parse(config),
    db,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    limits: async () => ({}),
  });
  const fetchUp = (config: unknown, name: string, request = {}) => mod().upstreams!.fetch(view(config) as never, name, request);

  it('calls an assigned upstream with its secret injected, whatever its call rule (none too)', async () => {
    const r = await fetchUp({ upstreams: { echo: { rules: { call: 'none' } } } }, 'echo', { path: '/v1/players?season=2026' });
    expect(r.status).toBe(200);
    const echoed = JSON.parse(r.body.toString('utf8')) as { method: string; path: string; query: string; headers: Record<string, string> };
    expect(echoed).toMatchObject({ method: 'GET', path: '/v1/players', query: '?season=2026' });
    expect(echoed.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(echoed.headers.accept).toBe('application/json');
  });

  it('POST sends the body as JSON', async () => {
    const r = await fetchUp({ upstreams: { open: {} } }, 'open', { method: 'POST', path: '/q', body: '{"a":1}' });
    expect(JSON.parse(r.body.toString('utf8'))).toMatchObject({ method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
  });

  it('refuses what the route refuses: not assigned, another workspace, a path outside the prefixes, a method the job may not use, over the cap', async () => {
    await expect(fetchUp({ upstreams: {} }, 'echo')).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'upstream_not_assigned' } });
    await expect(fetchUp({ upstreams: { elsewhere: {} } }, 'elsewhere')).rejects.toMatchObject({ code: 'not_found', details: { reason: 'upstream_not_registered' } });
    await expect(fetchUp({ upstreams: { echo: {} } }, 'echo', { path: '/v2/x' })).rejects.toMatchObject({ code: 'path_not_allowed' });
    await expect(fetchUp({ upstreams: { echo: {} } }, 'echo', { method: 'DELETE', path: '/v1' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(fetchUp({ upstreams: { open: {} } }, 'open', { path: '/gzip', maxBytes: 5 })).rejects.toMatchObject({ code: 'upstream_error', message: 'upstream response exceeded the size cap' });
  });

  it('follows a same-origin redirect like the route; a foreign one is upstream_redirect', async () => {
    const r = await fetchUp({ upstreams: { echo: {} } }, 'echo', { path: '/v1/dir' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body.toString('utf8'))).toMatchObject({ path: '/v1/dir/', headers: { authorization: `Bearer ${SECRET}` } });
    await expect(fetchUp({ upstreams: { echo: {} } }, 'echo', { path: '/redirect' })).rejects.toMatchObject({
      code: 'upstream_redirect',
      status: 502,
      details: { location_path: '/latest/meta-data/' },
    });
  });
});
