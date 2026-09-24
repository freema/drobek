import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { APPS_URL_SCHEME, BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, urlOf, type Raw } from './helpers/apps-host';
import { loginViaEmail, logout, pollLoginCode, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';
import { addMembership, personalWorkspaceOf, userIdByEmail } from './helpers/seed';

/**
 * M1-06 (NSO-297): the built-in platform module `proxy` end to end on the apps
 * host (DROBEK_MODULES=…,proxy in both composes; the in-network echo target
 * `proxy-echo` listens on port 80 too — upstreams may only use 80/443 — and is
 * on PROXY_ALLOWED_HOSTS):
 *
 *  - registering an upstream whose base_url has port 8080 → invalid_request
 *    (the dashboard form shows it); `http://proxy-echo` registers with a
 *    write-only secret the dashboard never shows;
 *  - get_app / configure_module show the upstream with hasSecret, never the
 *    value; skill_info('proxy') documents the limits;
 *  - an upstream not assigned to the app → 403; assigning it waits for the
 *    owner's confirmation;
 *  - a signed-in user → the upstream receives the injected
 *    `Authorization: Bearer <secret>`, never the Cookie (raw + through the SDK
 *    in a real browser); anonymous → 401; method/path allow-lists;
 *  - a redirect of the upstream is returned as-is, never followed;
 *  - the 61st call of an app within a minute → 429 rate_limited;
 *  - SSRF: a private base_url is refused at registration, a host resolving to
 *    a private address → ssrf_blocked; an editor cannot configure upstreams;
 *  - the old dashboard-host route `/:ws/api/proxy/…` is gone.
 */

interface Created {
  app_id: string;
  slug: string;
}

type Echo = { method: string; path: string; query: string; headers: Record<string, string>; body: string };

const SECURE = APPS_URL_SCHEME === 'https';
const COOKIE = SECURE ? '__Host-drobek_eu' : 'drobek_eu';
const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const USER = `e2e-proxy-user-${STAMP}@example.com`;
// A second address for the second app: pollLoginCode reads the NEWEST mail of an address.
const FLOOD_USER = `e2e-proxy-flood-${STAMP}@example.com`;
const SECRET = `sk-e2e-${randomBytes(12).toString('hex')}`;
const ECHO_BASE = 'http://proxy-echo';

function sdk(host: string, cookie?: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'X-Drobek-SDK': '1', Origin: urlOf(host), ...(cookie ? { Cookie: cookie } : {}), ...extra };
}

function call(host: string, path: string, opts: { method?: string; cookie?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Raw> {
  return hostRequest(host, `/__drobek/v1/proxy${path}`, {
    method: opts.method ?? 'GET',
    headers: sdk(host, opts.cookie, opts.headers),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
}

function json<T = Record<string, unknown>>(r: Raw): T {
  return JSON.parse(r.body) as T;
}

/** send-code → the Mailpit code → verify on `host`; the Cookie header value. */
async function signIn(request: APIRequestContext, host: string, email: string): Promise<{ cookie: string; value: string }> {
  const headers = { 'Content-Type': 'application/json', ...sdk(host) };
  const sent = await hostRequest(host, '/__drobek/v1/auth/send-code', { method: 'POST', headers, body: JSON.stringify({ email }) });
  expect(sent.status, sent.body).toBe(200);
  const code = await pollLoginCode(request, email);
  const verified = await hostRequest(host, '/__drobek/v1/auth/verify', { method: 'POST', headers, body: JSON.stringify({ email, code }) });
  expect(verified.status, verified.body).toBe(200);
  const sc = verified.headers['set-cookie'];
  const m = new RegExp(`(${COOKIE}=([0-9a-f]{64}))`).exec((Array.isArray(sc) ? sc : sc ? [sc] : []).join('\n'));
  expect(m, String(sc)).toBeTruthy();
  return { cookie: m![1], value: m![2] };
}

async function configure(mcp: McpClient, appId: string, module: string, config: unknown) {
  const r = await callTool(mcp.client, 'configure_module', { app_id: appId, module, config });
  expect(r.isError, JSON.stringify(r.json)).toBe(false);
  return r;
}

async function confirm(owner: BrowserContext, appId: string, module: string) {
  const ok = await owner.request.post(`${BASE_URL_WEB}/api/apps/${appId}/modules/${module}/confirm`, {
    headers: { Origin: BASE_URL_WEB },
    maxRedirects: 0,
  });
  expect(ok.status(), await ok.text()).toBe(200);
}

/** A new app whose signed-in `email` may call `echo` (assignment confirmed by the owner). */
async function appWithEcho(mcp: McpClient, owner: BrowserContext, request: APIRequestContext, name: string, email: string) {
  const app = (await callTool(mcp.client, 'create_app', { name, template: 'react-ts' })).json as unknown as Created;
  const host = previewHost(app.slug);
  await configure(mcp, app.app_id, 'auth', { allow: { emails: [email] } });
  const held = await configure(mcp, app.app_id, 'proxy', { upstreams: { echo: { rules: { call: 'user' } } } });
  expect(held.json.applied).toBe(false);
  await confirm(owner, app.app_id, 'proxy');
  const user = await signIn(request, host, email);
  return { app, host, user };
}

test.describe.configure({ mode: 'serial' });

test.describe('platform module proxy — workspace upstreams per app (M1-06) @local', () => {
  let mcp: McpClient;
  let owner: BrowserContext;
  let ws: string;
  let app: Created;
  let host: string;
  let user: { cookie: string; value: string };

  test.afterAll(async () => {
    await mcp?.client.close();
    await owner?.close();
  });

  test('registration: base_url port 8080 → invalid_request in the form; the echo upstream registers; the secret is never shown', async ({ page, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'proxy-module', scope: FULL_SCOPE });
    owner = await page.context().browser()!.newContext({ storageState: await page.context().storageState() });
    ws = mcp.workspace;

    const form = await owner.newPage();
    await form.goto(`/workspaces/${ws}/upstreams`);
    await expect(form.getByText('port 80 or 443')).toBeVisible();
    await form.getByTestId('field-name').fill('bad-port');
    await form.getByTestId('field-baseurl').fill('https://api.example.com:8080');
    await form.getByTestId('field-methods').fill('GET');
    await form.getByTestId('field-paths').fill('/');
    await form.getByTestId('upstream-submit').click();
    const error = form.getByTestId('upstream-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('data-error-code', 'invalid_request');
    await expect(error).toContainText('port 8080 is not allowed');
    await expect(form.locator('[data-testid="upstream-row"][data-upstream-name="bad-port"]')).toHaveCount(0);

    // The same refusal on a direct form POST: 400 invalid_request.
    const direct = await owner.request.post(`${BASE_URL_WEB}/workspaces/${ws}/upstreams`, {
      form: { intent: 'create', name: 'bad-port-2', baseUrl: 'http://api.example.com:8080', methods: 'GET', pathPrefixes: '/', authType: 'none' },
      maxRedirects: 0,
    });
    expect(direct.status()).toBe(400);

    await form.goto(`/workspaces/${ws}/upstreams`);
    await form.getByTestId('field-name').fill('echo');
    await form.getByTestId('field-baseurl').fill(ECHO_BASE);
    await form.getByTestId('field-methods').fill('GET');
    await form.getByTestId('field-paths').fill('/echo /redirect');
    await form.getByTestId('field-authtype').selectOption('bearer');
    await form.getByTestId('field-secret').fill(SECRET);
    await form.getByTestId('upstream-submit').click();
    await form.waitForURL(/\/upstreams$/);
    const row = form.locator('[data-testid="upstream-row"][data-upstream-name="echo"]');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('upstream-secret')).toContainText('secret set');
    expect(await form.content()).not.toContain(SECRET);
    await form.close();
  });

  test("module info: skill_info('proxy') has the limits; get_app shows the echo upstream with hasSecret — never the value", async () => {
    skipUnlessLocal();
    const info = await callTool(mcp.client, 'skill_info', { name: 'proxy' });
    expect(info.isError, JSON.stringify(info.json)).toBe(false);
    expect(info.json).toMatchObject({ name: 'proxy', kind: 'module' });
    expect(info.json.limits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'PROXY_CALLS_PER_MIN', value: 60 }),
        expect.objectContaining({ name: 'PROXY_PUBLIC_CALLS_PER_MIN_PER_IP', value: 10 }),
      ])
    );
    expect(String(info.json.content).split('\n').length).toBeLessThanOrEqual(150);
    expect(JSON.stringify(info.json.sdk)).toContain('fetch(upstream: string, path?: string, init?: RequestInit): Promise<Response>');

    app = (await callTool(mcp.client, 'create_app', { name: 'Echo client', template: 'react-ts' })).json as unknown as Created;
    host = previewHost(app.slug);
    const got = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
    expect(got.isError, JSON.stringify(got.json)).toBe(false);
    const proxy = (got.json.modules as Record<string, { info?: { upstreams: Record<string, unknown>[] } }>).proxy;
    expect(proxy.info?.upstreams).toEqual([
      { name: 'echo', registered: true, assigned: false, hasSecret: true, allowedMethods: ['GET'], allowedPathPrefixes: ['/echo', '/redirect'] },
    ]);
    expect(got.text).not.toContain(SECRET);
    expect(JSON.stringify(got.json)).not.toContain(SECRET);
    // The upstream's base URL (http://proxy-echo) never leaves the server (the app is named so its slug does not collide).
    expect(JSON.stringify(got.json)).not.toContain('proxy-echo');
  });

  test('an upstream not assigned to the app → 403; assigning it waits for the owner; configure_module info has hasSecret', async ({ request }) => {
    skipUnlessLocal();
    const before = await call(host, '/echo/echo/thing');
    expect(before.status, before.body).toBe(403);
    expect(json(before)).toMatchObject({ error: 'forbidden', details: { reason: 'upstream_not_assigned', upstream: 'echo' }, hint: "skill_info('proxy')" });

    await configure(mcp, app.app_id, 'auth', { allow: { emails: [USER] } });
    const held = await configure(mcp, app.app_id, 'proxy', { upstreams: { echo: { rules: { call: 'user' } } } });
    expect(held.json.applied).toBe(false);
    expect(held.json.pending_confirmation).toEqual([
      'proxy.upstreams.echo: this app may call the workspace upstream "echo" with its secret (callers: "user")',
    ]);
    expect(String(held.json.confirm_url)).toContain(`/apps/${app.slug}/modules/proxy`);
    expect((held.json.info as { upstreams: unknown[] }).upstreams).toEqual([
      expect.objectContaining({ name: 'echo', registered: true, assigned: false, hasSecret: true }),
    ]);
    expect(held.text).not.toContain(SECRET);

    // Still pending → still not assigned.
    user = await signIn(request, host, USER);
    expect((await call(host, '/echo/echo/thing', { cookie: user.cookie })).status).toBe(403);

    await confirm(owner, app.app_id, 'proxy');
    const got = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
    const proxy = (got.json.modules as Record<string, { info?: { upstreams: Record<string, unknown>[] } }>).proxy;
    expect(proxy.info?.upstreams[0]).toMatchObject({ name: 'echo', assigned: true, call: 'user', hasSecret: true });
    expect(JSON.stringify(got.json)).not.toContain(SECRET);
  });

  test('a signed-in user → the upstream gets Authorization: Bearer <secret>, never the Cookie; anonymous → 401; allow-lists hold', async () => {
    skipUnlessLocal();
    const anon = await call(host, '/echo/echo/thing');
    expect(anon.status, anon.body).toBe(401);
    expect(json(anon)).toMatchObject({ error: 'unauthorized' });

    const ok = await call(host, '/echo/echo/thing?q=1&q=2', {
      cookie: user.cookie,
      headers: { Authorization: 'Bearer CLIENT-TOKEN', 'X-Custom': 'kept' },
    });
    expect(ok.status, ok.body).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    const echoed = json<Echo>(ok);
    expect(echoed).toMatchObject({ method: 'GET', path: '/echo/thing', query: '?q=1&q=2' });
    expect(echoed.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(echoed.headers.cookie).toBeUndefined();
    expect(echoed.headers['x-drobek-sdk']).toBeUndefined();
    expect(echoed.headers.origin).toBeUndefined();
    expect(echoed.headers['x-custom']).toBe('kept');
    expect(JSON.stringify(echoed.headers)).not.toContain(user.value);

    // A plain same-origin fetch without the SDK header is refused, even a GET.
    const plain = await hostRequest(host, '/__drobek/v1/proxy/echo/echo/thing', { headers: { Cookie: user.cookie } });
    expect(plain.status).toBe(403);
    expect(json(plain)).toMatchObject({ error: 'csrf_rejected' });

    const post = await call(host, '/echo/echo/thing', { method: 'POST', cookie: user.cookie, headers: { 'Content-Type': 'application/json' }, body: '{"x":1}' });
    expect(post.status, post.body).toBe(405);
    expect(json(post)).toMatchObject({ error: 'method_not_allowed' });
    const outside = await call(host, '/echo/admin/thing', { cookie: user.cookie });
    expect(outside.status, outside.body).toBe(403);
    expect(json(outside)).toMatchObject({ error: 'path_not_allowed' });
    const traversal = await call(host, '/echo/echo/%2e%2e/admin', { cookie: user.cookie });
    expect(traversal.status, traversal.body).toBe(403);
  });

  test("the upstream's redirect is returned as-is, never followed; an absolute Location is dropped, a relative one relayed", async () => {
    skipUnlessLocal();
    const r = await call(host, '/echo/redirect', { cookie: user.cookie });
    expect(r.status, r.body).toBe(302);
    // NSO-326: an absolute Location would reveal (or point past) the upstream — it never reaches the app origin.
    expect(r.headers.location).toBeUndefined();
    expect(r.body).toBe('redirecting');
    const rel = await call(host, '/echo/redirect/relative', { cookie: user.cookie });
    expect(rel.status, rel.body).toBe(302);
    expect(rel.headers.location).toBe('/echo/next');
  });

  test('NSO-326: a gzipped upstream answer arrives decoded; only allow-listed headers are relayed', async () => {
    skipUnlessLocal();
    const r = await call(host, '/echo/echo/gzip', { cookie: user.cookie });
    expect(r.status, r.body).toBe(200);
    expect(json(r)).toEqual({ gzipped: true, acceptEncoding: 'identity' });
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(r.headers['x-request-id']).toBe('echo-req-1');
    for (const gone of ['clear-site-data', 'link']) expect(r.headers[gone], gone).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
  });

  test('drobek.proxy.fetch in a real browser: the page gets the upstream response, the key stays on the server', async ({ browser }) => {
    skipUnlessLocal();
    const main = [
      "import { drobek } from 'drobek';",
      "const out = document.getElementById('root')!;",
      "drobek.proxy.fetch('echo', '/echo/sdk?from=browser').then(async (res) => {",
      '  const e = await res.json();',
      "  out.setAttribute('data-status', String(res.status));",
      "  out.textContent = [e.path, e.query, e.headers.authorization ? 'auth-injected' : 'no-auth', e.headers.cookie ? 'cookie-leaked' : 'no-cookie'].join(' ');",
      '});',
      '',
    ].join('\n');
    const w = await callTool(mcp.client, 'write_files', { app_id: app.app_id, files: [{ path: 'src/main.tsx', content: main }], reasoning: 'proxy SDK check' });
    expect(w.isError, JSON.stringify(w.json)).toBe(false);
    expect((w.json.compile as { ok: boolean }).ok, JSON.stringify(w.json.compile)).toBe(true);

    const ctx = await browser.newContext();
    try {
      await ctx.addCookies([{ name: COOKIE, value: user.value, url: urlOf(host) }]);
      const page = await ctx.newPage();
      await page.goto(urlOf(host));
      const root = page.locator('#root');
      await expect(root).toHaveAttribute('data-status', '200');
      await expect(root).toHaveText('/echo/sdk ?from=browser auth-injected no-cookie');
    } finally {
      await ctx.close();
    }
  });

  test('the 61st call of an app within a minute → 429 rate_limited (PROXY_CALLS_PER_MIN 60)', async ({ request }) => {
    skipUnlessLocal();
    // A fresh app: its per-minute window starts with this test.
    const fresh = await appWithEcho(mcp, owner, request, 'Proxy flood', FLOOD_USER);
    for (let i = 1; i <= 60; i++) {
      const r = await call(fresh.host, '/echo/echo/n', { cookie: fresh.user.cookie });
      expect(r.status, `call ${i}: ${r.body}`).toBe(200);
    }
    const limited = await call(fresh.host, '/echo/echo/n', { cookie: fresh.user.cookie });
    expect(limited.status, limited.body).toBe(429);
    expect(json(limited)).toMatchObject({ error: 'rate_limited', details: { limit: 60, window_seconds: 60 } });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Another app of the same workspace has its own budget.
    expect((await call(host, '/echo/echo/other', { cookie: user.cookie })).status).toBe(200);
  });

  test('SSRF: a private base_url is refused at registration; a host resolving to a private address → ssrf_blocked', async () => {
    skipUnlessLocal();
    const createUrl = `${BASE_URL_WEB}/workspaces/${ws}/upstreams`;
    for (const baseUrl of ['http://127.0.0.1', 'http://169.254.169.254', 'http://10.1.2.3', 'http://localhost']) {
      const res = await owner.request.post(createUrl, {
        form: { intent: 'create', name: `bad-${randomBytes(3).toString('hex')}`, baseUrl, methods: 'GET', pathPrefixes: '/', authType: 'none' },
        maxRedirects: 0,
      });
      expect(res.status(), `registration of ${baseUrl} must be refused`).toBe(400);
    }
    // `postgres` is a hostname (registers) that resolves to a private Docker IP
    // and is not on PROXY_ALLOWED_HOSTS → blocked when drobek connects.
    const reg = await owner.request.post(createUrl, {
      form: { intent: 'create', name: 'pg', baseUrl: 'http://postgres', methods: 'GET', pathPrefixes: '/', authType: 'none' },
      maxRedirects: 0,
    });
    expect([302, 303], await reg.text()).toContain(reg.status());

    const held = await configure(mcp, app.app_id, 'proxy', { upstreams: { pg: { rules: { call: 'user' } } } });
    expect(held.json.applied).toBe(false);
    await confirm(owner, app.app_id, 'proxy');
    const blocked = await call(host, '/pg/anything', { cookie: user.cookie });
    expect(blocked.status, blocked.body).toBe(403);
    expect(json(blocked)).toMatchObject({ error: 'ssrf_blocked' });
    // The echo assignment is untouched by the merge patch.
    expect((await call(host, '/echo/echo/still', { cookie: user.cookie })).status).toBe(200);
  });
});

test('proxy: an editor cannot configure upstreams (page 403 + POST 403) @local', async ({ page, request }) => {
  skipUnlessLocal();
  const ownerEmail = uniqueEmail('proxy-owner');
  await loginViaEmail(page, request, ownerEmail);
  const { id: workspaceId, slug } = await personalWorkspaceOf(ownerEmail);

  const editorEmail = uniqueEmail('proxy-editor');
  await logout(page);
  await loginViaEmail(page, request, editorEmail);
  await addMembership(await userIdByEmail(editorEmail), workspaceId, 'editor');

  const pageRes = await page.request.get(`${BASE_URL_WEB}/workspaces/${slug}/upstreams`);
  expect(pageRes.status(), 'editor GET upstreams page → 403').toBe(403);
  const post = await page.request.post(`${BASE_URL_WEB}/workspaces/${slug}/upstreams`, {
    form: { intent: 'create', name: 'sneaky', baseUrl: 'https://api.example.com', methods: 'GET', pathPrefixes: '/', authType: 'none' },
    maxRedirects: 0,
  });
  expect(post.status(), 'editor create POST → 403').toBe(403);
});

test('the old dashboard-host proxy route /:ws/api/proxy/… is gone @local', async ({ request }) => {
  skipUnlessLocal();
  const res = await request.get(`${BASE_URL_WEB}/some-workspace/api/proxy/whatever/path`, { maxRedirects: 0 });
  expect(res.status()).toBe(404);
});
