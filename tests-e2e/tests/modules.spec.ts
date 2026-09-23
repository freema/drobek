import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, urlOf } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient, type McpClient } from './helpers/mcp';
import { withDb } from './helpers/seed';

/**
 * M1-01 (NSO-287): platform modules end to end against the stack running the
 * example module `hello` (DROBEK_MODULES=hello, loaded from the EXTERNAL
 * package drobek-module-hello; HELLO_WAVES_PER_MINUTE=5 in both composes).
 *
 *  - /__drobek/sdk.js on the app hosts: only active modules, ETag + 304,
 *    immutable under the current ?v=, revalidate otherwise; not on the
 *    dashboard origin; the compiler maps the bare `drobek` import to it;
 *  - a real browser runs `drobek.hello.ping()` / `wave()` in a preview app;
 *  - the module router: CSRF (foreign Origin, missing SDK header), zod body
 *    validation with field paths, the per-IP rate limit (429 + Retry-After);
 *  - configure_module: invalid_params with the field path, a confirmRequired
 *    change → pending + confirm_url, get_app.modules.hello.pending, then the
 *    dashboard API confirms (audit module.confirm, actor_kind user) or rejects;
 *  - skill_info: the list (also on create_app), one skill, unknown → not_found,
 *    never a secret value (a secret row in the DB), the compile hint.
 */

interface Created {
  app_id: string;
  slug: string;
  workspace: string;
  preview_url: string;
  skills: { name: string; use_when: string }[];
}

const HELLO_APP_HTML = [
  '<!doctype html>',
  '<html><head><meta charset="utf-8"><title>hello module</title></head>',
  '<body><p id="out">loading</p><p id="waves"></p><p id="err"></p>',
  '<script type="module" src="/main.js"></script></body></html>',
].join('\n');

const HELLO_APP_TS = [
  "import { drobek } from 'drobek';",
  '',
  "const out = document.getElementById('out')!;",
  "const waves = document.getElementById('waves')!;",
  "const err = document.getElementById('err')!;",
  'drobek.hello',
  '  .ping()',
  '  .then(async (h: { message: string }) => {',
  '    out.textContent = h.message;',
  "    const w = await drobek.hello.wave('browser');",
  '    waves.textContent = `waves:${w.waves}`;',
  '  })',
  '  .catch((e: { code?: string; message: string }) => {',
  '    err.textContent = `${e.code}:${e.message}`;',
  '  });',
  '',
].join('\n');

async function createHelloApp(mcp: McpClient, name: string): Promise<Created & { sdkUrl: string }> {
  const created = await callTool(mcp.client, 'create_app', { name, template: 'html' });
  expect(created.isError, JSON.stringify(created.json)).toBe(false);
  const app = created.json as unknown as Created;
  const w = await callTool(mcp.client, 'write_files', {
    app_id: app.app_id,
    files: [
      { path: 'index.html', content: HELLO_APP_HTML },
      { path: 'src/main.ts', content: HELLO_APP_TS },
    ],
    reasoning: 'Use the hello platform module',
  });
  expect(w.isError, JSON.stringify(w.json)).toBe(false);
  expect((w.json.compile as { ok: boolean }).ok, JSON.stringify(w.json.compile)).toBe(true);
  // The compiled bundle imports the server's versioned SDK URL.
  const main = await hostRequest(previewHost(app.slug), '/main.js');
  expect(main.status).toBe(200);
  const m = /\/__drobek\/sdk\.js\?v=([0-9a-f]{16})/.exec(main.body);
  expect(m, 'main.js imports /__drobek/sdk.js?v=<hash>').toBeTruthy();
  return { ...app, sdkUrl: m![0] };
}

function decide(api: APIRequestContext, appId: string, decision: 'confirm' | 'reject', origin: string | null = BASE_URL_WEB) {
  return api.post(`${BASE_URL_WEB}/api/apps/${appId}/modules/hello/${decision}`, {
    headers: origin ? { Origin: origin } : {},
    maxRedirects: 0,
  });
}

async function auditRows(slug: string): Promise<{ action: string; actor_kind: string; meta: unknown }[]> {
  return withDb(async (c) => {
    const r = await c.query(
      `SELECT action, actor_kind, meta FROM audit_log WHERE target = $1 AND action LIKE 'module.%' ORDER BY created_at`,
      [slug]
    );
    return r.rows as { action: string; actor_kind: string; meta: unknown }[];
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('platform modules — the hello example (M1-01) @local', () => {
  let mcp: McpClient;
  let app: Created & { sdkUrl: string };
  /** The owner's signed-in dashboard session (captured once: re-signing in the same e-mail races the OTP mail). */
  let owner: BrowserContext;

  test.afterAll(async () => {
    await mcp?.client.close();
    await owner?.close();
  });

  test('an agent builds an app on the hello module (the compiler maps `drobek` to the SDK)', async ({ page, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'modules' });
    owner = await page.context().browser()!.newContext({ storageState: await page.context().storageState() });
    app = await createHelloApp(mcp, 'Hello module');
    expect(app.skills.map((s) => s.name)).toContain('hello');
  });

  test('sdk.js: only active modules; ETag + 304; immutable under ?v=; not on the dashboard origin', async () => {
    skipUnlessLocal();
    const host = previewHost(app.slug);
    const pinned = await hostRequest(host, app.sdkUrl);
    expect(pinned.status).toBe(200);
    expect(pinned.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(pinned.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(pinned.body).toContain('"hello"');
    expect(pinned.body).toContain('X-Drobek-SDK');
    const etag = pinned.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);

    const bare = await hostRequest(host, '/__drobek/sdk.js');
    expect(bare.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
    expect((await hostRequest(host, '/__drobek/sdk.js?v=0000000000000000')).headers['cache-control']).toBe(
      'public, max-age=0, must-revalidate'
    );
    const cached = await hostRequest(host, '/__drobek/sdk.js', { headers: { 'If-None-Match': etag } });
    expect(cached.status).toBe(304);

    const dts = await hostRequest(host, '/__drobek/sdk.d.ts');
    expect(dts.status).toBe(200);
    expect(dts.body).toContain('export declare namespace hello {');
    expect(dts.body).toContain('readonly hello: hello.Api;');
    // The app CSP still applies to platform responses.
    expect(pinned.headers['content-security-policy']).toContain("connect-src 'self'");

    // The dashboard origin never serves the platform endpoints.
    const dash = await fetch(`${BASE_URL_WEB}/__drobek/sdk.js`);
    expect(dash.status).toBe(404);
    expect(await dash.text()).not.toContain('X-Drobek-SDK');
  });

  test('a browser runs drobek.hello.ping() + wave() in the preview app', async ({ page }) => {
    skipUnlessLocal();
    await page.goto(urlOf(previewHost(app.slug)));
    await expect(page.locator('#out')).toHaveText('Hello.');
    await expect(page.locator('#waves')).toHaveText(/^waves:\d+$/);
    await expect(page.locator('#err')).toHaveText('');
  });

  test('module router: GET JSON, CSRF guard, body validation with paths, rate limit', async () => {
    skipUnlessLocal();
    const host = previewHost(app.slug);
    const origin = urlOf(host);
    const ping = await hostRequest(host, '/__drobek/v1/hello');
    expect(ping.status).toBe(200);
    expect(ping.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(ping.body)).toMatchObject({ greeting: 'Hello', message: 'Hello.', signed: false });

    const json = { 'Content-Type': 'application/json' };
    const body = JSON.stringify({ name: 'curl' });
    const foreign = await hostRequest(host, '/__drobek/v1/hello/wave', {
      method: 'POST',
      headers: { ...json, Origin: 'https://evil.example', 'X-Drobek-SDK': '1' },
      body,
    });
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body)).toMatchObject({ error: 'csrf_rejected', hint: "skill_info('hello')" });
    const noHeader = await hostRequest(host, '/__drobek/v1/hello/wave', { method: 'POST', headers: { ...json, Origin: origin }, body });
    expect(noHeader.status).toBe(403);

    const sdk = { ...json, Origin: origin, 'X-Drobek-SDK': '1' };
    const bad = await hostRequest(host, '/__drobek/v1/hello/wave', { method: 'POST', headers: sdk, body: JSON.stringify({ name: '' }) });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body)).toMatchObject({ error: 'invalid_request', details: [{ path: 'name' }] });

    const wrong = await hostRequest(host, '/__drobek/v1/hello/wave');
    expect(wrong.status).toBe(405);
    expect(wrong.headers.allow).toBe('POST');
    const nope = await hostRequest(host, '/__drobek/v1/nope');
    expect(nope.status).toBe(404);
    expect(JSON.parse(nope.body)).toMatchObject({ error: 'not_found', details: { available: ['hello', 'auth'] } });

    // HELLO_WAVES_PER_MINUTE=5 per visitor IP (the browser test already waved once).
    const statuses: number[] = [];
    let limited: Awaited<ReturnType<typeof hostRequest>> | null = null;
    for (let i = 0; i < 6; i++) {
      const r = await hostRequest(host, '/__drobek/v1/hello/wave', { method: 'POST', headers: sdk, body });
      statuses.push(r.status);
      if (r.status === 429) {
        limited = r;
        break;
      }
    }
    expect(limited, `statuses ${statuses.join(',')}`).toBeTruthy();
    expect(Number(limited!.headers['retry-after'])).toBeGreaterThan(0);
    expect(JSON.parse(limited!.body)).toMatchObject({ error: 'rate_limited', details: { limit: 5, window_seconds: 60 } });
  });

  test('configure_module: invalid → invalid_params with the path; safe change applies', async () => {
    skipUnlessLocal();
    const bad = await callTool(mcp.client, 'configure_module', { app_id: app.app_id, module: 'hello', config: { greeting: '', excited: 'yes' } });
    expect(bad.isError).toBe(true);
    expect(bad.json).toMatchObject({
      code: 'invalid_params',
      hint: "skill_info('hello')",
      issues: [{ path: 'greeting' }, { path: 'excited' }],
    });
    const ok = await callTool(mcp.client, 'configure_module', { app_id: app.app_id, module: 'hello', config: { excited: true } });
    expect(ok.isError, JSON.stringify(ok.json)).toBe(false);
    expect(ok.json).toMatchObject({ applied: true, config: { greeting: 'Hello', excited: true }, pending_confirmation: [] });
    const ping = await hostRequest(previewHost(app.slug), '/__drobek/v1/hello');
    expect(JSON.parse(ping.body)).toMatchObject({ message: 'Hello!' });
  });

  test('confirm flow: pending → get_app.pending → dashboard confirm (audit user) → applied', async ({ request }) => {
    skipUnlessLocal();
    const held = await callTool(mcp.client, 'configure_module', { app_id: app.app_id, module: 'hello', config: { greeting: 'Ahoj' } });
    expect(held.isError, JSON.stringify(held.json)).toBe(false);
    expect(held.json).toMatchObject({
      applied: false,
      pending_confirmation: ['greeting: "Hello" → "Ahoj"'],
      confirm_url: `${BASE_URL_WEB}/workspaces/${app.workspace}/apps/${app.slug}/modules/hello`,
    });
    const got = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
    expect((got.json.modules as Record<string, unknown>).hello).toMatchObject({ pending: true, config: { greeting: 'Hello' } });
    // Still the old greeting on the app host.
    expect(JSON.parse((await hostRequest(previewHost(app.slug), '/__drobek/v1/hello')).body).greeting).toBe('Hello');

    // The owner's dashboard session.
    const api = owner.request;
    // Guards: no Origin → 403; an app host Origin → 403; unknown app → 404.
    expect((await decide(api, app.app_id, 'confirm', null)).status()).toBe(403);
    expect((await decide(api, app.app_id, 'confirm', urlOf(previewHost(app.slug)))).status()).toBe(403);
    expect((await decide(api, 'no-such-app', 'confirm')).status()).toBe(404);
    // Anonymous → 401.
    const anon = await request.post(`${BASE_URL_WEB}/api/apps/${app.app_id}/modules/hello/confirm`, {
      headers: { Origin: BASE_URL_WEB },
      maxRedirects: 0,
    });
    expect(anon.status()).toBe(401);

    const res = await decide(api, app.app_id, 'confirm');
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      decision: 'confirm',
      module: 'hello',
      config: { greeting: 'Ahoj', excited: true },
      confirmed: ['greeting: "Hello" → "Ahoj"'],
    });
    expect(JSON.parse((await hostRequest(previewHost(app.slug), '/__drobek/v1/hello')).body)).toMatchObject({
      greeting: 'Ahoj',
      message: 'Ahoj!',
    });
    const again = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
    expect((again.json.modules as Record<string, unknown>).hello).toMatchObject({ pending: false });
    // Nothing pending any more → 409.
    expect((await decide(api, app.app_id, 'confirm')).status()).toBe(409);

    const rows = await auditRows(app.slug);
    const confirm = rows.find((r) => r.action === 'module.confirm');
    expect(confirm, JSON.stringify(rows)).toBeTruthy();
    expect(confirm!.actor_kind).toBe('user');
    expect(rows.find((r) => r.action === 'module.pending')?.actor_kind).toBe('agent');
  });

  test('reject flow: the pending change is dropped, the config stays (audit module.reject)', async () => {
    skipUnlessLocal();
    const held = await callTool(mcp.client, 'configure_module', { app_id: app.app_id, module: 'hello', config: { greeting: 'Servus' } });
    expect(held.json).toMatchObject({ applied: false, pending_confirmation: ['greeting: "Ahoj" → "Servus"'] });
    const res = await decide(owner.request, app.app_id, 'reject');
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, decision: 'reject', config: { greeting: 'Ahoj' }, rejected: ['greeting: "Ahoj" → "Servus"'] });
    expect(JSON.parse((await hostRequest(previewHost(app.slug), '/__drobek/v1/hello')).body).greeting).toBe('Ahoj');
    const rows = await auditRows(app.slug);
    expect(rows.find((r) => r.action === 'module.reject')?.actor_kind).toBe('user');
  });

  test('another user cannot see or decide on the app (anti-enumeration 404)', async ({ browser, request }) => {
    skipUnlessLocal();
    const held = await callTool(mcp.client, 'configure_module', { app_id: app.app_id, module: 'hello', config: { greeting: 'Nazdar' } });
    expect(held.json).toMatchObject({ applied: false });
    const page = await browser.newPage();
    const other = await mcpClient(page, request, { tag: 'modules-other' });
    try {
      const res = await decide(page.request, app.app_id, 'confirm');
      expect(res.status()).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'not_found' });
      const cfg = await callTool(other.client, 'configure_module', { app_id: app.app_id, module: 'hello', config: { excited: false } });
      expect(cfg.json).toMatchObject({ code: 'not_found' });
      const got = await callTool(other.client, 'get_app', { app_id: app.app_id });
      expect(got.json).toMatchObject({ code: 'not_found' });
    } finally {
      await other.client.close();
      await page.close();
    }
    // The owner still has the change pending.
    const mine = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
    expect((mine.json.modules as Record<string, unknown>).hello).toMatchObject({ pending: true });
  });

  test('skill_info: list (also on create_app), one skill, unknown → not_found, compile hint', async () => {
    skipUnlessLocal();
    const list = await callTool(mcp.client, 'skill_info', {});
    expect(list.isError).toBe(false);
    const skills = list.json.skills as { name: string; use_when: string }[];
    expect(skills.map((s) => s.name)).toContain('hello');
    expect(skills.map((s) => s.name)).not.toContain('drobek');
    expect(app.skills).toEqual(skills);

    const one = await callTool(mcp.client, 'skill_info', { name: 'hello' });
    expect(one.json).toMatchObject({
      name: 'hello',
      kind: 'module',
      sdk: { import: "import { drobek } from 'drobek';" },
      config: { defaults: { greeting: 'Hello', excited: false } },
      limits: [{ name: 'HELLO_WAVES_PER_MINUTE', value: 5 }],
      secrets: [{ name: 'HELLO_SIGNATURE', required: false }],
    });
    expect(String(one.json.content)).toContain('drobek.hello.ping()');

    const unknown = await callTool(mcp.client, 'skill_info', { name: 'firebase' });
    expect(unknown.isError).toBe(true);
    expect(unknown.json).toMatchObject({ code: 'not_found', available: skills.map((s) => s.name), hint: 'skill_info()' });

    const fb = await callTool(mcp.client, 'write_files', {
      app_id: app.app_id,
      files: [{ path: 'src/main.ts', content: "import { initializeApp } from 'firebase/app';\ninitializeApp({});\n" }],
      reasoning: 'firebase habit',
    });
    const err = (fb.json.compile as { errors: { code: string; hint?: string }[] }).errors[0];
    expect(err.code).toBe('unresolved_import');
    // No `data` skill on this server → the hint points at the list.
    expect(err.hint).toMatch(/^skill_info\((?:'data')?\)$/);
  });

  test('skill_info and get_app never return a secret value (secret row in the DB)', async () => {
    skipUnlessLocal();
    const secretApp = await callTool(mcp.client, 'create_app', { name: 'Secret holder', template: 'html' });
    const appId = secretApp.json.app_id as string;
    const MARKER = `NEVER-LEAK-${Date.now()}`;
    await withDb((c) =>
      c.query(
        `INSERT INTO module_secrets (app_id, module, name, ciphertext, iv, auth_tag, wrapped_dek, kek_id)
         VALUES ($1, 'hello', 'HELLO_SIGNATURE', $2, $3, $4, $5, 'v1')`,
        [appId, MARKER, 'AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAA==', MARKER]
      )
    );
    const info = await callTool(mcp.client, 'skill_info', { name: 'hello' });
    const got = await callTool(mcp.client, 'get_app', { app_id: appId });
    for (const r of [info, got]) {
      expect(r.text).not.toContain(MARKER);
      expect(JSON.stringify(r.json)).not.toContain(MARKER);
    }
    expect((got.json.modules as Record<string, { secrets: unknown }>).hello.secrets).toEqual([
      { name: 'HELLO_SIGNATURE', hasSecret: true },
    ]);
  });
});
