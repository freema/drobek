import { expect, test, type APIRequestContext } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { getAppUrl, type Raw } from './helpers/apps-host';
import { MAILPIT_URL, mailpitMessagesFor, pollLoginCode } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * Path routing (APPS_ROUTING_MODE=path) end to end — the personal deployment
 * without an own domain: the dashboard + MCP on one origin, every app under
 * `<APPS_BASE_URL>/apps/<slug>[--preview|--v<N>]/`, reached through the
 * apps-host proxy (`node dist/server/apps-proxy.js`).
 *
 *  - create_app → write_files → the preview at `/apps/<slug>--preview/`
 *    renders in a browser (bundle, stylesheet and uploaded asset through the
 *    injected `<base>`), a nested client route falls back to index.html;
 *  - publish → `/apps/<slug>/` (and `/apps/<slug>` 308s there), the version
 *    address `/apps/<slug>--v<N>/`;
 *  - the auth + data modules from inside the page: sign-in by e-mailed code,
 *    a per-app session cookie, records through the base-aware SDK;
 *  - a session of app A is never one of app B, whatever path it is sent to;
 *  - the apps host never reaches the dashboard, its API, MCP or OAuth —
 *    whatever the path, encoding or forwarding header;
 *  - the personal instance: no code, account or invite for anyone but the owner.
 *
 * Runs only against a path-routing stack (`task e2e:path`, scripts/e2e-path.sh):
 * E2E_PATH_ROUTING=1, E2E_APPS_BASE_URL, E2E_OWNER_EMAIL (= SUPERADMIN_EMAIL).
 */

const ON = process.env.E2E_PATH_ROUTING === '1';
const APPS = (process.env.E2E_APPS_BASE_URL ?? 'http://apps.localhost:3062').replace(/\/$/, '');
const OWNER = process.env.E2E_OWNER_EMAIL ?? 'owner@drobek.test';
const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const ANA = `e2e-path-ana-${STAMP}@example.com`;

interface Created {
  app_id: string;
  slug: string;
  preview_url?: string;
}

const MAIN_TSX = `
import { drobek } from 'drobek';
import './styles.css';

const base = (document.querySelector('meta[name="drobek-base"]')?.getAttribute('content') ?? '/').replace(/\\/$/, '');
const route = location.pathname.slice(base.length) || '/';
const root = document.getElementById('root')!;
root.innerHTML = '<h1 id="title">Path app</h1><p id="route"></p><p id="me"></p><img id="hero" src="img/hero.svg" alt="hero">';
document.getElementById('route')!.textContent = route;
drobek.auth.me().then((me) => {
  document.getElementById('me')!.textContent = me ? me.email : 'anonymous';
});
`;

function skipUnlessPath(): void {
  test.skip(!ON, 'needs a path-routing stack (task e2e:path)');
}

const apps = (path: string, opts: Parameters<typeof getAppUrl>[2] = {}): Promise<Raw> => getAppUrl(APPS, path, opts);

function sdkHeaders(cookie?: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Origin: APPS, 'X-Drobek-SDK': '1', ...(cookie ? { Cookie: cookie } : {}) };
}

/** send-code → the Mailpit code → verify under `base`: the session cookie (`name=value`). */
async function signIn(request: APIRequestContext, base: string, email: string, appId: string): Promise<string> {
  const sent = await apps(`${base}/__drobek/v1/auth/send-code`, { method: 'POST', headers: sdkHeaders(), body: JSON.stringify({ email }) });
  expect(sent.status, sent.body).toBe(200);
  const code = await pollLoginCode(request, email);
  const verified = await apps(`${base}/__drobek/v1/auth/verify`, { method: 'POST', headers: sdkHeaders(), body: JSON.stringify({ email, code }) });
  expect(verified.status, verified.body).toBe(200);
  const sc = verified.headers['set-cookie'];
  const line = (Array.isArray(sc) ? sc : sc ? [sc] : []).find((c) => c.includes(`drobek_eu-${appId}=`));
  expect(line, `a per-app session cookie in ${JSON.stringify(sc)}`).toBeTruthy();
  expect(line).toContain('Path=/');
  expect(line).toContain('HttpOnly');
  return line!.split(';')[0];
}

test.describe.configure({ mode: 'serial' });

test.describe('path routing @path', () => {
  let mcp: McpClient;
  let app: Created;
  let other: Created;
  let anaCookie: string;

  test.afterAll(async () => {
    await mcp?.client.close();
  });

  test('setup: the owner signs in and gets an MCP client', async ({ page, request }) => {
    skipUnlessPath();
    mcp = await mcpClient(page, request, { email: OWNER, scope: FULL_SCOPE });
  });

  test('create + write: the preview lives at /apps/<slug>--preview and renders through <base>', async ({ page }) => {
    skipUnlessPath();
    app = (await callTool(mcp.client, 'create_app', { name: `Path notes ${STAMP}`, template: 'react-ts' })).json as unknown as Created;
    other = (await callTool(mcp.client, 'create_app', { name: `Path other ${STAMP}`, template: 'html' })).json as unknown as Created;
    const w = await callTool(mcp.client, 'write_files', {
      app_id: app.app_id,
      files: [
        { path: 'src/main.tsx', content: MAIN_TSX },
        { path: 'src/styles.css', content: 'h1 { color: rgb(1, 2, 3); }\n#root { background-image: url(./bg.svg); }\n' },
        { path: 'src/bg.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>' },
        { path: 'img/hero.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>' },
      ],
      reasoning: 'path routing e2e',
    });
    expect(w.isError, JSON.stringify(w.json)).toBe(false);
    expect((w.json.compile as { ok: boolean }).ok, JSON.stringify(w.json.compile)).toBe(true);
    const previewUrl = String(w.json.preview_url);
    expect(previewUrl).toBe(`${APPS}/apps/${app.slug}--preview`);

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(`${previewUrl}/`);
    await expect(page.locator('#title')).toHaveText('Path app');
    await expect(page.locator('#title')).toHaveCSS('color', 'rgb(1, 2, 3)');
    await expect(page.locator('#route')).toHaveText('/');
    await expect(page.locator('#me')).toHaveText('anonymous');
    await expect.poll(() => page.locator('#hero').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(40);
    expect(errors).toEqual([]);

    // A file the bundle references is emitted relative to the entry, so it resolves under the base.
    const css = await apps(`/apps/${app.slug}--preview/main.css`);
    const bg = /url\("?(\.\/assets\/bg-[^")]+)"?\)/.exec(css.body);
    expect(bg, css.body.slice(0, 400)).toBeTruthy();
    expect((await apps(`/apps/${app.slug}--preview/${bg![1].slice(2)}`)).status).toBe(200);
    const bgLoaded = await page.evaluate(async (url) => (await fetch(url)).status, new URL(bg![1], `${previewUrl}/main.css`).href);
    expect(bgLoaded).toBe(200);

    const html = await apps(`/apps/${app.slug}--preview/`);
    expect(html.body).toContain(`<base href="/apps/${app.slug}--preview/">`);
    expect(html.body).toContain(`src="/apps/${app.slug}--preview/main.js"`);
    expect(html.headers['content-security-policy']).toContain("base-uri 'self'");
  });

  test('a nested client route is the same app (SPA fallback under the base)', async ({ page }) => {
    skipUnlessPath();
    await page.goto(`${APPS}/apps/${app.slug}--preview/orders/42`);
    await expect(page.locator('#route')).toHaveText('/orders/42');
    await expect(page.locator('#title')).toHaveText('Path app');
  });

  test('an uploaded asset is served under the app base', async ({ request }) => {
    skipUnlessPath();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const grant = await callTool(mcp.client, 'create_asset_upload', { app_id: app.app_id, path: 'img/dot.png', size: png.length });
    expect(grant.isError, JSON.stringify(grant.json)).toBe(false);
    const put = await request.put(String(grant.json.upload_url), {
      data: png,
      headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${mcp.token}` },
    });
    expect(put.status(), await put.text()).toBe(201);
    const got = await apps(`/apps/${app.slug}--preview/img/dot.png`);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.bytes.equals(png)).toBe(true);
    // Never at the root and never under another app.
    expect((await apps('/img/dot.png')).status).toBe(404);
    expect((await apps(`/apps/${other.slug}--preview/img/dot.png`)).status).not.toBe(200);
  });

  test('publish: /apps/<slug>/ serves the published version, /apps/<slug> 308s there, /apps/<slug>--v<N>/ a version', async ({ page }) => {
    skipUnlessPath();
    expect((await apps(`/apps/${app.slug}/`)).status).toBe(404);
    const pub = await callTool(mcp.client, 'publish', { app_id: app.app_id });
    expect(pub.isError, JSON.stringify(pub.json)).toBe(false);
    expect(String(pub.json.published_url)).toBe(`${APPS}/apps/${app.slug}`);
    const redirect = await apps(`/apps/${app.slug}?ref=x`);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.location).toBe(`/apps/${app.slug}/?ref=x`);
    await page.goto(`${APPS}/apps/${app.slug}`);
    expect(new URL(page.url()).pathname).toBe(`/apps/${app.slug}/`);
    await expect(page.locator('#title')).toHaveText('Path app');

    const versions = await callTool(mcp.client, 'list_versions', { app_id: app.app_id });
    const number = (versions.json.versions as { number: number }[])[0].number;
    const v = await apps(`/apps/${app.slug}--v${number}/`);
    expect(v.status).toBe(200);
    expect(v.body).toContain(`<base href="/apps/${app.slug}--v${number}/">`);
  });

  test('auth + data: sign in by code and store a record from the page through the base-aware SDK', async ({ page, request }) => {
    skipUnlessPath();
    const auth = await callTool(mcp.client, 'configure_module', { app_id: app.app_id, module: 'auth', config: { allow: { emails: [ANA] } } });
    expect(auth.isError, JSON.stringify(auth.json)).toBe(false);
    const data = await callTool(mcp.client, 'configure_module', { app_id: app.app_id, module: 'data', config: { collections: { notes: {} } } });
    expect(data.isError, JSON.stringify(data.json)).toBe(false);

    // Provider sign-in is off on a shared origin: e-mail code only.
    const providers = await apps(`/apps/${app.slug}--preview/__drobek/v1/auth/providers`, { headers: sdkHeaders() });
    expect(providers.status, providers.body).toBe(200);
    expect(JSON.stringify(JSON.parse(providers.body))).not.toMatch(/google|oidc/i);

    const base = `/apps/${app.slug}--preview`;
    anaCookie = await signIn(request, base, ANA, app.app_id);
    const [name, value] = anaCookie.split('=');
    await page.context().addCookies([{ name, value, url: APPS }]);
    await page.goto(`${APPS}${base}/`);
    await expect(page.locator('#me')).toHaveText(ANA);

    const created = await page.evaluate(async () => {
      const { drobek } = await import('/__drobek/sdk.js' as string);
      await drobek.data.collection('notes').create({ text: 'from the page' });
      return (await drobek.data.collection('notes').list()).records.map((r: { text: string }) => r.text);
    });
    expect(created).toEqual(['from the page']);
    const listed = await apps(`${base}/__drobek/v1/data/notes`, { headers: sdkHeaders(anaCookie) });
    expect(listed.status, listed.body).toBe(200);
    expect(listed.body).toContain('from the page');
  });

  test("app A's session is never app B's, whatever path it is sent to", async () => {
    skipUnlessPath();
    const b = `/apps/${other.slug}--preview`;
    const me = await apps(`${b}/__drobek/v1/auth/me`, { headers: sdkHeaders(anaCookie) });
    expect(me.body).not.toContain(ANA);
    for (const path of [
      `${b}/__drobek/v1/data/notes`,
      `/apps/${app.slug}--preview/../${other.slug}--preview/__drobek/v1/data/notes`,
      `/apps/${other.slug}--preview/%2e%2e/${app.slug}--preview/__drobek/v1/data/notes`,
      `/__drobek/v1/data/notes`,
    ]) {
      const r = await apps(path, { headers: sdkHeaders(anaCookie) });
      expect(r.body, path).not.toContain('from the page');
    }
  });

  test('the apps host never reaches the dashboard, its API, MCP or OAuth', async () => {
    skipUnlessPath();
    const bearer = { Authorization: `Bearer ${mcp.token}` };
    for (const [method, path] of [
      ['GET', '/'],
      ['GET', '/login'],
      ['GET', '/me'],
      ['POST', '/mcp'],
      ['GET', '/mcp'],
      ['GET', '/api/me'],
      ['GET', '/oauth/authorize'],
      ['POST', '/oauth/token'],
      ['GET', '/.well-known/oauth-authorization-server'],
      ['GET', '/admin'],
      ['GET', '/healthz/../mcp'],
      ['GET', '/apps/%2e%2e/mcp'],
      ['GET', '/apps/..%2fmcp'],
      ['GET', `/apps/${app.slug}/../../mcp`],
    ] as const) {
      const r = await apps(path, {
        method,
        headers: { ...bearer, 'Content-Type': 'application/json', 'X-Forwarded-Host': new URL(BASE_URL_WEB).host, Forwarded: `host=${new URL(BASE_URL_WEB).host}` },
        body: method === 'POST' ? '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' : undefined,
      });
      expect([404, 405], `${method} ${path} → ${r.status}`).toContain(r.status);
      expect(r.body, path).not.toContain('jsonrpc');
      expect(r.headers['set-cookie'], path).toBeUndefined();
    }
  });

  test('personal instance: no code, account or invite for anyone but the owner', async ({ request }) => {
    skipUnlessPath();
    const stranger = `e2e-path-stranger-${STAMP}@example.com`;
    const before = (await mailpitMessagesFor(request, stranger)).length;
    const login = await request.post(`${BASE_URL_WEB}/login`, {
      form: { email: stranger },
      headers: { Origin: BASE_URL_WEB },
      maxRedirects: 0,
    });
    expect([302, 303]).toContain(login.status());
    await new Promise((r) => setTimeout(r, 1500));
    expect((await mailpitMessagesFor(request, stranger)).length, `no mail for ${stranger} (${MAILPIT_URL})`).toBe(before);

    const ws = await callTool(mcp.client, 'create_workspace', { slug: `team-${STAMP}`, name: `Team ${STAMP}` });
    expect(ws.isError, ws.text).toBe(false);
    const invite = await callTool(mcp.client, 'invite_member', {
      workspace: `team-${STAMP}`,
      email: stranger,
      role: 'editor',
      user_confirmed: true,
    });
    expect(invite.isError, invite.text).toBe(true);
    expect(invite.text).toMatch(/personal instance/i);
  });
});
