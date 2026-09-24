import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { APPS_URL_SCHEME, BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, prodHost, urlOf, type Raw } from './helpers/apps-host';
import { pollLoginCode, skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * M1-03 (NSO-300): the built-in platform module `data` end to end on the apps
 * host (DROBEK_MODULES=hello,auth,email,forms,data in both composes,
 * DATA_MAX_DOCS_PER_APP=5):
 *
 *  - skill_info('data') carries the <LoginGate> + own-records example; it
 *    compiles via write_files; a firebase import hints skill_info('data');
 *  - configure_module declares collections; opening `create` to public is
 *    pending until the owner confirms, then a visitor can add a record;
 *  - a visitor reading a `read: user` collection → 401; another user
 *    changing a record under `update: owner` → 403, the owner → 200;
 *    `_owner` cannot be spoofed; a list under `read: owner|admin` holds
 *    only the caller's records;
 *  - the skill example in a real browser lists and adds the signed-in
 *    user's own records;
 *  - the 6th record with a quota of 5 → 409 quota_exceeded;
 *  - CSV exports (the app's admin, the dashboard) neutralize `=1+1`;
 *  - query_data: untrusted records, ≤ 100, another app's collections are
 *    not_found; app B reads none of app A's records through REST or the SDK;
 *  - the preview and production hosts of an app share its records.
 */

interface Created {
  app_id: string;
  slug: string;
  workspace: string;
}

type Rec = Record<string, unknown> & { _id: string; _owner: string | null };

const SECURE = APPS_URL_SCHEME === 'https';
const COOKIE = SECURE ? '__Host-drobek_eu' : 'drobek_eu';
const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const ANA = `e2e-data-ana-${STAMP}@example.com`;
const BOB = `e2e-data-bob-${STAMP}@example.com`;
const BOSS = `e2e-data-boss-${STAMP}@example.com`;

const TODO_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: { title: { type: 'string', maxLength: 200 }, done: { type: 'boolean' } },
};

function sdkHeaders(host: string, cookie?: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Origin: urlOf(host), 'X-Drobek-SDK': '1', ...(cookie ? { Cookie: cookie } : {}) };
}

function data(host: string, path: string, opts: { method?: string; body?: unknown; cookie?: string } = {}): Promise<Raw> {
  const method = opts.method ?? 'GET';
  return hostRequest(host, `/__drobek/v1/data${path}`, {
    method,
    headers: method === 'GET' ? (opts.cookie ? { Cookie: opts.cookie } : {}) : sdkHeaders(host, opts.cookie),
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

function json<T = Record<string, unknown>>(r: Raw): T {
  return JSON.parse(r.body) as T;
}

/** send-code → the Mailpit code → verify on `host`; the Cookie header value and the user id. */
async function signIn(request: APIRequestContext, host: string, email: string): Promise<{ cookie: string; id: string; value: string }> {
  const sent = await hostRequest(host, '/__drobek/v1/auth/send-code', { method: 'POST', headers: sdkHeaders(host), body: JSON.stringify({ email }) });
  expect(sent.status, sent.body).toBe(200);
  const code = await pollLoginCode(request, email);
  const verified = await hostRequest(host, '/__drobek/v1/auth/verify', { method: 'POST', headers: sdkHeaders(host), body: JSON.stringify({ email, code }) });
  expect(verified.status, verified.body).toBe(200);
  const sc = verified.headers['set-cookie'];
  const setCookie = (Array.isArray(sc) ? sc : sc ? [sc] : []).join('\n');
  const m = new RegExp(`(${COOKIE}=([0-9a-f]{64}))`).exec(setCookie);
  expect(m, setCookie).toBeTruthy();
  return { cookie: m![1], value: m![2], id: (json<{ user: { id: string } }>(verified)).user.id };
}

async function configure(mcp: McpClient, appId: string, module: string, config: unknown) {
  const r = await callTool(mcp.client, 'configure_module', { app_id: appId, module, config });
  expect(r.isError, JSON.stringify(r.json)).toBe(false);
  return r.json;
}

test.describe.configure({ mode: 'serial' });

test.describe('platform module data — collections with rules (M1-03) @local', () => {
  let mcp: McpClient;
  let owner: BrowserContext;
  let appA: Created;
  let appB: Created;
  let hostA: string;
  let ana: { cookie: string; id: string; value: string };
  let bob: { cookie: string; id: string; value: string };
  let boss: { cookie: string; id: string; value: string };
  let anaRecord: Rec;

  test.afterAll(async () => {
    await mcp?.client.close();
    await owner?.close();
  });

  test("skill_info('data'): the LoginGate example compiles via write_files; a firebase import hints skill_info('data')", async ({ page, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'data-module', scope: FULL_SCOPE });
    owner = await page.context().browser()!.newContext({ storageState: await page.context().storageState() });

    const info = await callTool(mcp.client, 'skill_info', { name: 'data' });
    expect(info.isError, JSON.stringify(info.json)).toBe(false);
    expect(info.json).toMatchObject({ name: 'data', kind: 'module' });
    const content = String(info.json.content);
    expect(content.split('\n').length).toBeLessThanOrEqual(150);
    expect((info.json.limits as { name: string }[]).map((l) => l.name)).toEqual(
      expect.arrayContaining(['DATA_MAX_DOCS_PER_APP', 'DATA_MAX_DOC_BYTES', 'DATA_MAX_BYTES_PER_APP', 'DATA_WRITE_RATE_LIMIT'])
    );
    expect(JSON.stringify(info.json.sdk)).toContain('collection<T extends object');
    const example = /```tsx\n([\s\S]*?)```/.exec(content)![1];
    expect(example).toContain('<LoginGate');
    expect(example).toContain("drobek.data.collection<Todo>('todos')");

    const created = await callTool(mcp.client, 'create_app', { name: 'Data todos A', template: 'react-ts' });
    appA = created.json as unknown as Created;
    hostA = previewHost(appA.slug);
    const w = await callTool(mcp.client, 'write_files', {
      app_id: appA.app_id,
      files: [{ path: 'src/main.tsx', content: example }],
      reasoning: 'Per-user todos (data skill example)',
    });
    expect(w.isError, JSON.stringify(w.json)).toBe(false);
    expect((w.json.compile as { ok: boolean }).ok, JSON.stringify(w.json.compile)).toBe(true);

    appB = (await callTool(mcp.client, 'create_app', { name: 'Data other B', template: 'react-ts' })).json as unknown as Created;
    const fb = await callTool(mcp.client, 'write_files', {
      app_id: appB.app_id,
      files: [{ path: 'src/main.tsx', content: "import { getFirestore } from 'firebase/firestore';\nconsole.log(getFirestore());\n" }],
      reasoning: 'firebase habit',
    });
    const err = (fb.json.compile as { errors: { code: string; hint?: string }[] }).errors[0];
    expect(err, JSON.stringify(fb.json.compile)).toBeTruthy();
    expect(err.code).toBe('unresolved_import');
    expect(err.hint).toBe("skill_info('data')");
  });

  test("configure_module: collections apply; create: 'public' waits for the owner, then a visitor can add a record", async () => {
    skipUnlessLocal();
    const first = await configure(mcp, appA.app_id, 'data', {
      collections: {
        todos: { schema: TODO_SCHEMA },
        members: { rules: { read: 'user', create: 'user', update: 'owner', delete: 'owner|admin' } },
        x: { rules: { read: 'public' } },
      },
    });
    expect(first).toMatchObject({ applied: true, pending_confirmation: [] });
    expect(first.config).toMatchObject({
      collections: { todos: { rules: { read: 'owner|admin', create: 'user', update: 'owner|admin', delete: 'owner|admin' } } },
    });
    await configure(mcp, appA.app_id, 'auth', { allow: { emails: [ANA, BOB] }, adminEmails: [BOSS] });

    const held = await configure(mcp, appA.app_id, 'data', { collections: { x: { rules: { create: 'public' } } } });
    expect(held.applied).toBe(false);
    expect(held.pending_confirmation).toEqual([
      'data.collections.x.rules.create: "user" → "public" (anyone, signed in or not, may add records)',
    ]);
    expect(String(held.confirm_url)).toContain(`/apps/${appA.slug}/modules/data`);

    const before = await data(hostA, '/x', { method: 'POST', body: { text: 'too early' } });
    expect(before.status, before.body).toBe(401);

    const ok = await owner.request.post(`${BASE_URL_WEB}/api/apps/${appA.app_id}/modules/data/confirm`, {
      headers: { Origin: BASE_URL_WEB },
      maxRedirects: 0,
    });
    expect(ok.status(), await ok.text()).toBe(200);

    const after = await data(hostA, '/x', { method: 'POST', body: { text: 'hello from a visitor', _owner: 'spoofed' } });
    expect(after.status, after.body).toBe(201);
    expect(json(after)).toMatchObject({ _owner: null, text: 'hello from a visitor' });
    const csrf = await hostRequest(hostA, '/__drobek/v1/data/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"x"}' });
    expect(csrf.status).toBe(403);
    expect((await data(hostA, '/nope')).status).toBe(404);
  });

  test('rules: visitor 401 on read: user; update: owner — another user 403, the owner 200; _owner is the server’s', async ({ request }) => {
    skipUnlessLocal();
    const anon = await data(hostA, '/members');
    expect(anon.status).toBe(401);
    expect(json(anon)).toMatchObject({ error: 'unauthorized', hint: "skill_info('data')" });

    ana = await signIn(request, hostA, ANA);
    bob = await signIn(request, hostA, BOB);
    boss = await signIn(request, hostA, BOSS);

    const created = await data(hostA, '/members', { method: 'POST', cookie: ana.cookie, body: { name: 'Ana', _owner: bob.id, _id: 'mine' } });
    expect(created.status, created.body).toBe(201);
    anaRecord = json<Rec>(created);
    expect(anaRecord._owner).toBe(ana.id);
    expect(anaRecord._id).not.toBe('mine');
    expect((await data(hostA, `/members/${anaRecord._id}`)).status).toBe(401);

    const foreign = await data(hostA, `/members/${anaRecord._id}`, { method: 'PATCH', cookie: bob.cookie, body: { name: 'Bob was here' } });
    expect(foreign.status, foreign.body).toBe(403);
    expect(json(foreign)).toMatchObject({ error: 'forbidden' });
    const own = await data(hostA, `/members/${anaRecord._id}`, { method: 'PATCH', cookie: ana.cookie, body: { city: 'Brno' } });
    expect(own.status, own.body).toBe(200);
    expect(json(own)).toMatchObject({ _id: anaRecord._id, _owner: ana.id, name: 'Ana', city: 'Brno' });
    expect(json<Rec>(await data(hostA, `/members/${anaRecord._id}`, { cookie: bob.cookie }))).toMatchObject({ name: 'Ana' });

    // read: owner|admin — each user lists only their own todos; the app's admin all.
    for (const [who, title] of [[ana, 'Ana todo'], [bob, 'Bob todo']] as const) {
      expect((await data(hostA, '/todos', { method: 'POST', cookie: who.cookie, body: { title } })).status).toBe(201);
    }
    const titles = async (cookie: string) => json<{ records: Rec[] }>(await data(hostA, '/todos', { cookie })).records.map((r) => r.title).sort();
    expect(await titles(ana.cookie)).toEqual(['Ana todo']);
    expect(await titles(bob.cookie)).toEqual(['Bob todo']);
    expect(await titles(boss.cookie)).toEqual(['Ana todo', 'Bob todo']);
    const invalid = await data(hostA, '/todos', { method: 'POST', cookie: ana.cookie, body: { done: 'yes' } });
    expect(invalid.status).toBe(422);
    expect(json(invalid)).toMatchObject({ error: 'validation_failed' });
    const injected = await data(hostA, `/todos?filter=${encodeURIComponent(JSON.stringify({ "title' OR '1'='1": 'x' }))}`, { cookie: boss.cookie });
    expect(injected.status).toBe(400);
  });

  test("the skill example in a browser: the signed-in user's own records, added through the SDK", async ({ browser }) => {
    skipUnlessLocal();
    const ctx = await browser.newContext();
    try {
      await ctx.addCookies([{ name: COOKIE, value: ana.value, url: urlOf(hostA) }]);
      const page = await ctx.newPage();
      await page.goto(urlOf(hostA));
      await expect(page.getByRole('heading', { name: 'My todos' })).toBeVisible();
      await expect(page.locator('li')).toHaveCount(1);
      await expect(page.locator('li').first()).toContainText('Ana todo');
      await page.getByPlaceholder('New todo').fill('=1+1');
      await page.getByRole('button', { name: 'Add' }).click();
      await expect(page.locator('li')).toHaveCount(2);
      await expect(page.locator('ul')).not.toContainText('Bob todo');
    } finally {
      await ctx.close();
    }
  });

  test("CSV exports neutralize =1+1: the app's admin only, and the dashboard", async () => {
    skipUnlessLocal();
    expect((await data(hostA, '/todos/export.csv', { cookie: ana.cookie })).status).toBe(403);
    expect((await data(hostA, '/todos/export.csv')).status).toBe(401);
    const csv = await data(hostA, '/todos/export.csv', { cookie: boss.cookie });
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    // Streamed (NSO-323 M5): no Content-Length, the body arrives in chunks.
    expect(csv.headers['content-length']).toBeUndefined();
    const lines = csv.body.trimEnd().split('\r\n');
    expect(lines[0]).toBe('_id,_owner,_created_at,_updated_at,title,done');
    expect(csv.body).toContain(",'=1+1,false");
    expect(csv.body).not.toMatch(/,=1\+1/);

    const dash = await owner.request.get(`${BASE_URL_WEB}/workspaces/${appA.workspace}/apps/${appA.slug}/data/todos/export.csv`);
    expect(dash.status()).toBe(200);
    const text = await dash.text();
    expect(text).toContain(",'=1+1,");
    expect(text).not.toMatch(/,=1\+1/);
    const tab = await owner.newPage();
    try {
      await tab.goto(`${BASE_URL_WEB}/workspaces/${appA.workspace}/apps/${appA.slug}/data`);
      await expect(tab.locator('[data-testid="collection-row"]')).toHaveCount(3);
      await expect(tab.locator('[data-testid="collection-row"][data-collection="todos"] [data-testid="collection-count"]')).toContainText('3');
      await expect(tab.locator('[data-testid="collection-row"][data-collection="x"] [data-testid="collection-rules"]')).toContainText('read public · create public');
    } finally {
      await tab.close();
    }
  });

  test('query_data: untrusted records inside the envelope, ≤ 100; app B has none of A’s collections', async () => {
    skipUnlessLocal();
    const r = await callTool(mcp.client, 'query_data', { app_id: appA.app_id, collection: 'todos', filter: { title: { contains: 'todo' } }, sort: 'title', dir: 'asc' });
    expect(r.isError, JSON.stringify(r.json)).toBe(false);
    expect(r.json).toMatchObject({ app_id: appA.app_id, collection: 'todos', total: 2, next_cursor: null, untrusted: true });
    expect((r.json.records as Rec[]).map((x) => x.title)).toEqual(['Ana todo', 'Bob todo']);
    expect(r.text.startsWith('UNTRUSTED CONTENT:')).toBe(true);
    const nonce = /<untrusted-app-data [^>]*nonce="([0-9a-f]{16})">/.exec(r.text)![1];
    expect(r.text.trimEnd().endsWith(`</untrusted-app-data nonce="${nonce}">`)).toBe(true);

    const tooMany = await callTool(mcp.client, 'query_data', { app_id: appA.app_id, collection: 'todos', limit: 101 });
    expect(tooMany.json).toMatchObject({ code: 'invalid_params' });
    const other = await callTool(mcp.client, 'query_data', { app_id: appB.app_id, collection: 'todos' });
    expect(other.isError).toBe(true);
    expect(other.json).toMatchObject({ code: 'not_found', available: [] });
    expect(other.text).not.toContain('Ana todo');
  });

  test("app B reads none of app A's records through REST or the SDK (same collection name, A's record id)", async ({ browser }) => {
    skipUnlessLocal();
    const hostB = previewHost(appB.slug);
    expect((await data(hostB, '/members')).status).toBe(404);
    // B declares the same names; read is public (a new, empty collection: no confirmation).
    const cfg = await configure(mcp, appB.app_id, 'data', { collections: { members: { rules: { read: 'public' } }, todos: { rules: { read: 'public' } } } });
    expect(cfg.applied).toBe(true);
    expect(json<{ records: Rec[] }>(await data(hostB, '/members')).records).toEqual([]);
    expect((await data(hostB, `/members/${anaRecord._id}`)).status).toBe(404);
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(urlOf(hostB));
      const out = await page.evaluate(async (id) => {
        const { drobek } = await import('/__drobek/sdk.js' as string);
        const members = drobek.data.collection('members');
        const list = await members.list();
        const got = await members.get(id).then(
          () => 'found',
          (e: { status?: number; code?: string }) => `${e.status} ${e.code}`
        );
        return { count: list.records.length, got };
      }, anaRecord._id);
      expect(out).toEqual({ count: 0, got: '404 not_found' });
    } finally {
      await ctx.close();
    }
    const q = await callTool(mcp.client, 'query_data', { app_id: appB.app_id, collection: 'members' });
    expect(q.json).toMatchObject({ records: [], total: 0 });
  });

  test("the preview and production hosts share the app's records", async () => {
    skipUnlessLocal();
    const pub = await callTool(mcp.client, 'publish', { app_id: appA.app_id });
    expect(pub.isError, JSON.stringify(pub.json)).toBe(false);
    const prod = prodHost(appA.slug);
    // App A holds 5 records (the dev quota): the admin frees a slot first.
    const freed = await data(hostA, `/members/${anaRecord._id}`, { method: 'DELETE', cookie: boss.cookie });
    expect(freed.status, freed.body).toBe(200);
    expect(json(freed)).toEqual({ id: anaRecord._id, deleted: true });
    const created = await data(prod, '/x', { method: 'POST', body: { text: 'written on production' } });
    expect(created.status, created.body).toBe(201);
    const onPreview = json<{ records: Rec[] }>(await data(hostA, '/x'));
    expect(onPreview.records.map((r) => r.text).sort()).toEqual(['hello from a visitor', 'written on production']);
  });

  test('DATA_MAX_DOCS_PER_APP = 5: the 6th record → 409 quota_exceeded', async () => {
    skipUnlessLocal();
    const c = (await callTool(mcp.client, 'create_app', { name: 'Data quota C', template: 'html' })).json as unknown as Created;
    const held = await configure(mcp, c.app_id, 'data', { collections: { log: { rules: { read: 'public', create: 'public' } } } });
    expect(held.applied).toBe(false);
    const ok = await owner.request.post(`${BASE_URL_WEB}/api/apps/${c.app_id}/modules/data/confirm`, { headers: { Origin: BASE_URL_WEB }, maxRedirects: 0 });
    expect(ok.status(), await ok.text()).toBe(200);
    const host = previewHost(c.slug);
    for (let i = 1; i <= 5; i++) {
      const r = await data(host, '/log', { method: 'POST', body: { n: i } });
      expect(r.status, r.body).toBe(201);
    }
    const sixth = await data(host, '/log', { method: 'POST', body: { n: 6 } });
    expect(sixth.status, sixth.body).toBe(409);
    expect(json(sixth)).toMatchObject({ error: 'quota_exceeded', details: { limit: 'DATA_MAX_DOCS_PER_APP', value: 5 }, hint: "skill_info('data')" });
  });
});
