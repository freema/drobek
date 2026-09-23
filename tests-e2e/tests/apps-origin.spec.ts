import { createHash, randomBytes, scrypt } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Redis } from 'ioredis';
import { APPS_URL_SCHEME, BASE_URL_WEB, TEST_ENV } from '../playwright.config';
import {
  hostRequest,
  prodHost,
  previewHost,
  urlOf,
  versionHost,
  type Raw,
} from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, connectBearer, mcpClient } from './helpers/mcp';
import { userIdByEmail, withDb } from './helpers/seed';

/**
 * M0-06 (NSO-285) acceptance, end to end against the local compose stack:
 * every app is its own origin under APPS_DOMAIN (dev: apps.localhost:3041).
 *   - <slug>--preview.<APPS_DOMAIN> = the newest version that compiled,
 *     <slug>.<APPS_DOMAIN> = the published one (404 "not published" before),
 *     <slug>--v<N>.<APPS_DOMAIN> = exactly version N;
 *   - built files win, sources (*.tsx) are never served, SPA fallback, ETag/304,
 *     the Cache-Control policy, the security header set (CSP, noindex on
 *     preview/version hosts, no-referrer, nosniff, frame-ancestors 'none');
 *   - MCP publish (scope `publish`, only ok versions, rollback, audited);
 *   - the cache is busted on publish / a new version (no stale first request);
 *   - the dashboard never serves an app, app hosts never read or set the
 *     dashboard session; the session cookie is host-only (`__Host-` + Secure
 *     over https / in production — plain-http dev drops the prefix because
 *     browsers refuse `__Host-` on http://localhost);
 *   - the password gate sets a host-only cookie on that app host only;
 *   - a mutating dashboard request with an app Origin → 403.
 * App hosts are reached over node:http(s) at 127.0.0.1 with an explicit Host
 * header / SNI (helpers/apps-host.ts — exactly what a browser sends for
 * *.localhost), and in the browser directly (Chromium resolves *.localhost to
 * loopback).
 */

const WEB = new URL(BASE_URL_WEB);

/** Cookie mode of the target stack: `__Host-` + Secure over https, plain on http dev. */
const DASH_SECURE = WEB.protocol === 'https:';
const APPS_SECURE = APPS_URL_SCHEME === 'https';
const SESSION_NAME = DASH_SECURE ? '__Host-drobek_session' : 'drobek_session';
const ACCESS_NAME = APPS_SECURE ? '__Host-drobek_app_access' : 'drobek_app_access';

/** The Cookie header the BROWSER actually sent for a navigation (not Playwright's jar view). */
async function sentCookies(page: import('@playwright/test').Page, url: string): Promise<{ status: number; cookie: string }> {
  const res = await page.goto(url);
  expect(res, url).toBeTruthy();
  const headers = await res!.request().allHeaders();
  return { status: res!.status(), cookie: headers.cookie ?? '' };
}

function cookieNames(header: string): string[] {
  return header
    .split(';')
    .map((p) => p.trim().split('=')[0])
    .filter(Boolean);
}

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self' https://esm.sh 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; " +
  "font-src 'self' data: https:; connect-src 'self' https://esm.sh; object-src 'none'; " +
  "base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

/** Seed a `drk_` API key for `email` (only its SHA-256 is stored). */
async function seedApiKey(email: string, scopes: string): Promise<string> {
  const key = `drk_${randomBytes(24).toString('base64url')}`;
  const keyId = `key${randomBytes(8).toString('hex')}`;
  const userId = await userIdByEmail(email);
  await withDb((c) =>
    c.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, scopes) VALUES ($1, $2, 'e2e', $3, $4)`,
      [keyId, userId, createHash('sha256').update(key).digest('hex'), scopes]
    )
  );
  return key;
}

/** The app-password hash format @drobek/serving verifies: `scrypt$<saltHex>$<hashHex>`. */
function hashAppPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (err, dk) =>
      err ? reject(err) : resolve(`scrypt$${salt.toString('hex')}$${dk.toString('hex')}`)
    )
  );
}

const LOCAL_REDIS_HOSTS = ['localhost', '127.0.0.1', 'redis'];

/** Publish a `drobek:app-changed` event (what the dashboard settings path does). */
async function announceAppChanged(appId: string, slug: string): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url || TEST_ENV !== 'local' || !LOCAL_REDIS_HOSTS.includes(new URL(url).hostname)) {
    throw new Error('announceAppChanged needs TEST_ENV=local and a local REDIS_URL (task e2e sets both)');
  }
  const redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
  await redis.connect();
  try {
    await redis.publish('drobek:app-changed', JSON.stringify({ app_id: appId, slug, kind: 'settings' }));
  } finally {
    redis.disconnect();
  }
  await new Promise((r) => setTimeout(r, 150));
}

function expectAppSecurityHeaders(r: Raw, opts: { noindex: boolean }): void {
  expect(r.headers['content-security-policy']).toBe(EXPECTED_CSP);
  expect(r.headers['x-content-type-options']).toBe('nosniff');
  expect(r.headers['referrer-policy']).toBe('no-referrer');
  if (opts.noindex) expect(r.headers['x-robots-tag']).toBe('noindex');
  else expect(r.headers['x-robots-tag']).toBeUndefined();
  expect(r.headers['set-cookie']).toBeUndefined();
}

function marker(label: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head><meta charset="utf-8" /><title>Origin E2E</title><link rel="stylesheet" href="/main.css" /></head>',
    `  <body><p id="marker">${label}</p><div id="root"></div><script type="module" src="/main.js"></script></body>`,
    '</html>',
    '',
  ].join('\n');
}

test('app hosts: preview / publish / rollback / --vN, served files, headers, cache + bust @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const a = await mcpClient(page, request, { tag: 'origin' });
  try {
    // publish is advertised under the full scope, with its annotations.
    const listed = (await a.client.listTools()).tools;
    const publishTool = listed.find((t) => t.name === 'publish');
    expect(publishTool?.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true });

    const created = await callTool(a.client, 'create_app', { name: 'Origin E2E' });
    expect(created.isError, created.text).toBe(false);
    const appId = created.json.app_id as string;
    const slug = created.json.slug as string;
    expect(created.json.preview_url).toBe(urlOf(previewHost(slug)));

    // ── Not published yet: the production host is a 404 page. ──────────────
    const unpublished = await hostRequest(prodHost(slug));
    expect(unpublished.status).toBe(404);
    expect(unpublished.body).toContain('Not published yet');
    expectAppSecurityHeaders(unpublished, { noindex: false });

    // ── Preview = v1: built output served, sources never. ─────────────────
    const html = await hostRequest(previewHost(slug));
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toMatch(/^text\/html/);
    expect(html.body).toContain('<script type="module" src="/main.js"></script>');
    expect(html.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
    expect(html.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expectAppSecurityHeaders(html, { noindex: true });

    const js = await hostRequest(previewHost(slug), '/main.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.body).toContain('https://esm.sh/');
    expect(js.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
    const hashed = await hostRequest(previewHost(slug), '/main.js?v=3f9a1c2b7d');
    expect(hashed.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    // TS/TSX/JSX sources and drobek.json are never served (404, not the SPA shell).
    for (const source of ['/src/main.tsx', '/drobek.json']) {
      const r = await hostRequest(previewHost(slug), source);
      expect(r.status, source).toBe(404);
      expect(r.body, source).not.toContain('createRoot');
    }
    // The built stylesheet is served.
    const css = await hostRequest(previewHost(slug), '/main.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toMatch(/^text\/css/);

    // SPA fallback: a client-side route gets index.html.
    const deep = await hostRequest(previewHost(slug), '/settings/profile');
    expect(deep.status).toBe(200);
    expect(deep.body).toBe(html.body);

    // ETag → 304 with no body; HEAD has headers but no body.
    const notModified = await hostRequest(previewHost(slug), '/', {
      headers: { 'If-None-Match': String(html.headers.etag) },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.body).toBe('');
    const head = await hostRequest(previewHost(slug), '/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(html.body)));

    // Methods other than GET/HEAD are refused on an app host.
    expect((await hostRequest(previewHost(slug), '/', { method: 'POST' })).status).toBe(405);

    // ── publish (default = newest ok) → production serves v1. ──────────────
    const pub1 = await callTool(a.client, 'publish', { app_id: appId });
    expect(pub1.isError, pub1.text).toBe(false);
    expect(pub1.json).toEqual({
      published_version: 1,
      previous_version: null,
      published_url: urlOf(prodHost(slug)),
      domains: [prodHost(slug)],
    });
    const prod1 = await hostRequest(prodHost(slug));
    expect(prod1.status).toBe(200);
    expect(prod1.body).toBe(html.body);
    expectAppSecurityHeaders(prod1, { noindex: false });

    // ── A new version: preview follows at once (bust), production does not. ─
    const v2 = await callTool(a.client, 'write_files', {
      app_id: appId,
      files: [{ path: 'index.html', content: marker('second') }],
      reasoning: 'Add a marker',
    });
    expect(v2.isError, v2.text).toBe(false);
    expect(v2.json).toMatchObject({ version: 2, compile: { ok: true } });
    expect((await hostRequest(previewHost(slug))).body).toContain('<p id="marker">second</p>');
    expect((await hostRequest(prodHost(slug))).body).toBe(html.body);
    // A stale ETag no longer matches.
    expect(
      (await hostRequest(previewHost(slug), '/', { headers: { 'If-None-Match': String(html.headers.etag) } })).status
    ).toBe(200);

    // A broken v3: preview stays on v2, --v3 is a 404, publish(3) is refused.
    const v3 = await callTool(a.client, 'write_files', {
      app_id: appId,
      files: [{ path: 'src/main.tsx', content: 'const = ;\n' }],
      reasoning: 'Break it',
    });
    expect(v3.json).toMatchObject({ version: 3, compile: { ok: false } });
    expect((await hostRequest(previewHost(slug))).body).toContain('<p id="marker">second</p>');
    expect((await hostRequest(versionHost(slug, 3))).status).toBe(404);
    const refused = await callTool(a.client, 'publish', { app_id: appId, version: 3 });
    expect(refused.isError).toBe(true);
    expect(refused.json.code).toBe('not_publishable');
    const missing = await callTool(a.client, 'publish', { app_id: appId, version: 99 });
    expect(missing.isError).toBe(true);
    expect(missing.json.code).toBe('not_found');

    // ── publish(2) → the very first production request serves v2. ──────────
    const pub2 = await callTool(a.client, 'publish', { app_id: appId, version: 2 });
    expect(pub2.json).toMatchObject({ published_version: 2, previous_version: 1 });
    expect((await hostRequest(prodHost(slug))).body).toContain('<p id="marker">second</p>');

    // ── Rollback = publish an older version. ──────────────────────────────
    const rollback = await callTool(a.client, 'publish', { app_id: appId, version: 1 });
    expect(rollback.json).toMatchObject({ published_version: 1, previous_version: 2 });
    expect((await hostRequest(prodHost(slug))).body).toBe(html.body);

    // ── --vN = exactly version N (noindex). ────────────────────────────────
    const v1Host = await hostRequest(versionHost(slug, 1));
    expect(v1Host.body).toBe(html.body);
    expectAppSecurityHeaders(v1Host, { noindex: true });
    expect((await hostRequest(versionHost(slug, 2))).body).toContain('<p id="marker">second</p>');
    expect((await hostRequest(versionHost(slug, 42))).status).toBe(404);

    // Unknown app / malformed app labels: an apps-side 404, never the dashboard.
    const unknown = await hostRequest(previewHost(`${slug}-nope`));
    expect(unknown.status).toBe(404);
    expectAppSecurityHeaders(unknown, { noindex: true });
    if (APPS_URL_SCHEME === 'https') {
      // Behind Caddy a nested label matches no certificate (`*.<APPS_DOMAIN>`
      // covers one label): the handshake is refused before drobek sees it.
      await expect(hostRequest(`x.${prodHost(slug)}`)).rejects.toThrow(/SSL|TLS|alert|EPROTO/i);
    } else {
      expect((await hostRequest(`x.${prodHost(slug)}`)).status).toBe(404);
    }

    // Audit: app.publish rows by the agent.
    const audit = await withDb(async (c) =>
      (
        await c.query(`SELECT actor_kind FROM audit_log WHERE action = 'app.publish' AND target = $1`, [slug])
      ).rows as { actor_kind: string }[]
    );
    expect(audit.length).toBe(3);
    for (const row of audit) expect(row.actor_kind).toBe('agent');

    // ── Scope: a `read write` key does not get publish. ────────────────────
    const key = await seedApiKey(a.email, 'read write');
    const rw = await connectBearer(key);
    try {
      expect((await rw.client.listTools()).tools.map((t) => t.name)).not.toContain('publish');
      const denied = await callTool(rw.client, 'publish', { app_id: appId }).catch(() => ({ isError: true }));
      expect(denied.isError).toBe(true);
    } finally {
      await rw.transport.close();
    }
    // …a `publish` key does.
    const pubKey = await seedApiKey(a.email, 'read publish');
    const pk = await connectBearer(pubKey);
    try {
      const ok = await callTool(pk.client, 'publish', { app_id: appId, version: 2 });
      expect(ok.isError, ok.text).toBe(false);
      expect(ok.json.published_version).toBe(2);
    } finally {
      await pk.transport.close();
    }
  } finally {
    await a.transport.close();
  }
});

test('dashboard vs app origin: host-only session, no session on app hosts, origin check, no app routes @local', async ({
  page,
  request,
  context,
}) => {
  skipUnlessLocal();
  const a = await mcpClient(page, request, { tag: 'origin-iso' });
  try {
    // The dashboard session cookie: host-only (no leading-dot domain), Path=/,
    // HttpOnly, Lax; `__Host-` + Secure over https.
    const dashCookies = await context.cookies(BASE_URL_WEB);
    const session = dashCookies.find((c) => c.name === SESSION_NAME);
    expect(session, `the ${SESSION_NAME} cookie is set`).toBeTruthy();
    expect(session).toMatchObject({
      domain: WEB.hostname,
      path: '/',
      secure: DASH_SECURE,
      httpOnly: true,
      sameSite: 'Lax',
    });
    expect(dashCookies.filter((c) => c.name.endsWith('drobek_session'))).toHaveLength(1);

    const created = await callTool(a.client, 'create_app', { name: 'Isolation E2E' });
    expect(created.isError, created.text).toBe(false);
    const slug = created.json.slug as string;

    // The browser sends the session to the dashboard, never to an app host.
    expect(cookieNames((await sentCookies(page, `${BASE_URL_WEB}/me`)).cookie)).toContain(SESSION_NAME);
    const onApp = await sentCookies(page, urlOf(previewHost(slug)));
    expect(onApp.status).toBe(200);
    expect(cookieNames(onApp.cookie)).not.toContain(SESSION_NAME);

    // Sending the real session cookie to an app host changes nothing, sets nothing.
    const plain = await hostRequest(previewHost(slug));
    const withSession = await hostRequest(previewHost(slug), '/', {
      headers: { Cookie: `__Host-drobek_session=${session?.value}; drobek_session=${session?.value}` },
    });
    expect(plain.headers['set-cookie']).toBeUndefined();
    expect(withSession.status).toBe(200);
    expect(withSession.body).toBe(plain.body);
    expect(withSession.headers['set-cookie']).toBeUndefined();

    // Dashboard paths on an app host are app paths (SPA shell), never dashboard routes.
    for (const p of ['/me', '/workspaces', '/oauth/authorize', '/login']) {
      const r = await hostRequest(previewHost(slug), p, {
        headers: { Cookie: `${SESSION_NAME}=${session?.value}` },
      });
      expect(r.body, p).toBe(plain.body);
      expect(r.body, p).not.toContain(a.email);
    }

    // The dashboard never serves an app (the old /:ws/app/:slug path is gone).
    const old = await page.request.get(`${BASE_URL_WEB}/${a.workspace}/app/${slug}`);
    expect(old.status()).toBe(404);
    expect(await old.text()).not.toContain('src="/main.js"');

    // The browser renders the preview on its own origin.
    const nav = await page.goto(urlOf(previewHost(slug)));
    expect(nav?.status()).toBe(200);
    await expect(page).toHaveTitle('Isolation E2E');
    await page.goto(`${BASE_URL_WEB}/me`);

    // ── Origin check on mutating dashboard requests. ──────────────────────
    const appOrigin = urlOf(previewHost(slug));
    const fromApp = await page.request.post(`${BASE_URL_WEB}/auth/logout`, {
      headers: { Origin: appOrigin },
      maxRedirects: 0,
    });
    expect(fromApp.status()).toBe(403);
    expect(await fromApp.text()).toBe('Forbidden: cross-origin request refused');
    const fromProd = await page.request.post(`${BASE_URL_WEB}/workspaces/${a.workspace}/apps/${slug}`, {
      headers: { Origin: urlOf(prodHost(slug)) },
      form: { intent: 'publish', version: '1' },
      maxRedirects: 0,
    });
    expect(fromProd.status()).toBe(403);
    // …still signed in: the refused logout did nothing.
    await page.goto(`${BASE_URL_WEB}/me`);
    await expect(page).toHaveURL(/\/me$/);

    // The token + registration endpoints are exempt (cross-origin by design, no cookies).
    const token = await request.post(`${BASE_URL_WEB}/oauth/token`, {
      headers: { Origin: appOrigin },
      form: { grant_type: 'authorization_code', code: 'nope' },
    });
    expect(token.status()).not.toBe(403);
    const register = await request.post(`${BASE_URL_WEB}/oauth/register`, {
      headers: { Origin: appOrigin },
      data: {},
    });
    expect(register.status()).not.toBe(403);

    // The dashboard's own origin passes.
    const own = await page.request.post(`${BASE_URL_WEB}/auth/logout`, {
      headers: { Origin: WEB.origin },
      maxRedirects: 0,
    });
    expect(own.status()).not.toBe(403);
  } finally {
    await a.transport.close();
  }
});

test('password gate: 401 form, wrong password, unlock sets a host-only cookie on that host only @local', async ({
  page,
  request,
  context,
}) => {
  skipUnlessLocal();
  const a = await mcpClient(page, request, { tag: 'origin-pw' });
  try {
    const created = await callTool(a.client, 'create_app', { name: 'Gated E2E' });
    expect(created.isError, created.text).toBe(false);
    const appId = created.json.app_id as string;
    const slug = created.json.slug as string;
    const pub = await callTool(a.client, 'publish', { app_id: appId });
    expect(pub.isError, pub.text).toBe(false);
    expect((await hostRequest(prodHost(slug))).status).toBe(200);

    // Switch the app to password visibility, then announce the change.
    const hash = await hashAppPassword('correct horse');
    await withDb((c) =>
      c.query(`UPDATE apps SET visibility = 'password', password_hash = $2 WHERE id = $1`, [appId, hash])
    );
    await announceAppChanged(appId, slug);

    // Raw: a 401 password page with the security headers, no app bytes.
    const gated = await hostRequest(prodHost(slug), '/deep/link?x=1');
    expect(gated.status).toBe(401);
    expect(gated.body).toContain('This app is password protected');
    expect(gated.body).toContain('value="/deep/link?x=1"');
    expect(gated.body).not.toContain('src="/main.js"');
    expectAppSecurityHeaders(gated, { noindex: false });
    // Every host of the app is gated, sources included.
    expect((await hostRequest(previewHost(slug))).status).toBe(401);
    expect((await hostRequest(prodHost(slug), '/main.js')).status).toBe(401);
    // The dashboard session does not unlock it.
    const dash = (await context.cookies(BASE_URL_WEB)).find((c) => c.name === SESSION_NAME);
    expect(dash).toBeTruthy();
    const withSession = await hostRequest(prodHost(slug), '/', {
      headers: { Cookie: `__Host-drobek_session=${dash?.value}; drobek_session=${dash?.value}` },
    });
    expect(withSession.status).toBe(401);

    // Browser: wrong password → 401 + error; right password → back to the page.
    const first = await page.goto(urlOf(prodHost(slug)));
    expect(first?.status()).toBe(401);
    await page.locator('#drobek-app-password').fill('wrong');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('alert')).toContainText('Incorrect password');
    await page.locator('#drobek-app-password').fill('correct horse');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page).toHaveTitle('Gated E2E');
    expect(new URL(page.url()).host).toBe(prodHost(slug));

    // The access cookie: host-only on THIS host, Path=/, HttpOnly, Lax
    // (`__Host-` + Secure over https).
    const access = (await context.cookies(urlOf(prodHost(slug)))).find((c) => c.name === ACCESS_NAME);
    expect(access, `the ${ACCESS_NAME} cookie is set`).toBeTruthy();
    expect(access).toMatchObject({
      domain: prodHost(slug).replace(/:\d+$/, ''),
      path: '/',
      secure: APPS_SECURE,
      httpOnly: true,
      sameSite: 'Lax',
    });
    // What the browser actually sends: the access cookie to this host only;
    // never the dashboard session to an app host, never the access cookie to
    // the dashboard or to the app's other hosts.
    const onProd = await sentCookies(page, urlOf(prodHost(slug)));
    expect(onProd.status).toBe(200);
    expect(cookieNames(onProd.cookie)).toEqual([ACCESS_NAME]);
    const onPreview = await sentCookies(page, urlOf(previewHost(slug)));
    expect(onPreview.status).toBe(401);
    expect(cookieNames(onPreview.cookie)).not.toContain(ACCESS_NAME);
    const onDash = await sentCookies(page, `${BASE_URL_WEB}/me`);
    expect(cookieNames(onDash.cookie)).toContain(SESSION_NAME);
    expect(cookieNames(onDash.cookie)).not.toContain(ACCESS_NAME);

    // The access cookie works on its host over raw HTTP too, and only there.
    const unlocked = await hostRequest(prodHost(slug), '/', {
      headers: { Cookie: `${ACCESS_NAME}=${access?.value}` },
    });
    expect(unlocked.status).toBe(200);
    expect(unlocked.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    // A token is bound to its app: it never opens another app.
    const other = await callTool(a.client, 'create_app', { name: 'Other Gated E2E' });
    const otherSlug = other.json.slug as string;
    await withDb((c) =>
      c.query(`UPDATE apps SET visibility = 'password', password_hash = $2 WHERE id = $1`, [
        other.json.app_id,
        hash,
      ])
    );
    await announceAppChanged(other.json.app_id as string, otherSlug);
    const replayed = await hostRequest(previewHost(otherSlug), '/', {
      headers: { Cookie: `${ACCESS_NAME}=${access?.value}` },
    });
    expect(replayed.status).toBe(401);
  } finally {
    await a.transport.close();
  }
});
