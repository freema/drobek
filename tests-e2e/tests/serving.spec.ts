import { randomBytes, scryptSync } from 'node:crypto';
import pg from 'pg';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { skipUnlessLocal } from './helpers/auth';
import {
  callTool,
  deployClient,
  file,
  indexHtml,
  initUploadCommit,
  waitForState,
  type DeployResult,
} from './helpers/deploy';

/**
 * U7 acceptance (PHY-58 / PHY-52 / PHY-82 / PHY-76): hardened same-origin path
 * serving at `/:ws/app/:slug/*`.
 *   (a) a PUBLIC app loads with strict CSP + nosniff; a hashed asset is
 *       immutable + carries an ETag; If-None-Match → 304; the entry HTML
 *       revalidates.
 *   (b) the served response never sets `drobek_session` and the admin session
 *       is not readable by app JS on the app path.
 *   (c) a TEAM-only app 404s an anonymous request but serves a member.
 *   (d) a PASSWORD app shows the password page with no cookie, denies the wrong
 *       password, and serves after the correct one (scoped app-access cookie).
 *   (e) a rollback busts the serve cache — the rolled-back version serves at once.
 * Requires the local compose stack + worker.
 *
 * Visibility/password are set by direct DB mutation BEFORE the app's first
 * serve (there is no MCP tool for them in U7): the serve caches are only
 * populated on a serve request, so mutating first means no stale cache.
 */

const DB_URL =
  process.env.DATABASE_URL ??
  'postgresql://drobek:drobek@localhost:5441/drobek';

/** scrypt hash matching @drobek/serving/password (format: scrypt$salt$hash). */
function hashAppPassword(password: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

async function withDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Resolve (workspaceId, appId) for a deployed app via its slugs. */
async function appIds(dep: DeployResult): Promise<{ workspaceId: string; appId: string }> {
  return withDb(async (c) => {
    const res = await c.query(
      `SELECT a.id AS app_id, a.workspace_id
         FROM apps a JOIN workspaces w ON w.id = a.workspace_id
        WHERE w.slug = $1 AND a.slug = $2`,
      [dep.workspaceSlug, dep.appSlug]
    );
    expect(res.rows.length, 'app row exists').toBe(1);
    return { workspaceId: res.rows[0].workspace_id, appId: res.rows[0].app_id };
  });
}

function setCookieValues(res: { headersArray(): { name: string; value: string }[] }): string[] {
  return res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => h.value);
}

test('public app: CSP + nosniff, immutable hashed asset + ETag/304, entry revalidates, no admin cookie @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const { client, transport } = await deployClient(page, request);
  try {
    const salt = randomBytes(6).toString('hex');
    const assetPath = `assets/app-${salt}.js`;
    const dep = await initUploadCommit(client, request, {
      name: `E2E Serve ${salt}`,
      files: [
        indexHtml(`v1 ${salt}`),
        file(assetPath, `console.log("asset ${salt}");`, 'application/javascript'),
      ],
    });
    const ready = await waitForState(client, dep.deployId, 'ready');
    expect(ready.active).toBe(true);
    const url = dep.url;
    expect(url, 'serving url is /:ws/app/:slug').toContain(`/${dep.workspaceSlug}/app/${dep.appSlug}`);

    // (a) entry HTML: 200, strict CSP + nosniff, revalidate, body served.
    const idx = await page.request.get(url);
    expect(idx.status()).toBe(200);
    const h = idx.headers();
    expect(h['content-security-policy']).toContain("default-src 'self'");
    expect(h['content-security-policy']).toContain("object-src 'none'");
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['content-type']).toContain('text/html');
    expect(h['cache-control']).toBe('no-cache');
    expect(h['etag']).toBeTruthy();
    expect(await idx.text()).toContain(`v1 ${salt}`);

    // (b) the app response must NOT set the dashboard session cookie.
    expect(setCookieValues(idx).some((v) => v.includes('drobek_session'))).toBe(false);

    // hashed asset: 200, immutable one-year cache + ETag.
    const assetUrl = `${url}/${assetPath}`;
    const asset = await page.request.get(assetUrl);
    expect(asset.status()).toBe(200);
    const ah = asset.headers();
    expect(ah['content-type']).toContain('javascript');
    expect(ah['cache-control']).toContain('immutable');
    expect(ah['cache-control']).toContain('max-age=31536000');
    const etag = ah['etag'];
    expect(etag).toBeTruthy();

    // conditional GET → 304.
    const notModified = await page.request.get(assetUrl, {
      headers: { 'If-None-Match': etag },
    });
    expect(notModified.status()).toBe(304);

    // (b) admin session (HttpOnly, Path=/) is not readable by app JS.
    await page.goto(url);
    const cookie = await page.evaluate(() => document.cookie);
    expect(cookie).not.toContain('drobek_session');
  } finally {
    await transport.close();
  }
});

test('spa fallback + exact 404 @local', async ({ page, request }) => {
  skipUnlessLocal();
  const { client, transport } = await deployClient(page, request);
  try {
    const salt = randomBytes(6).toString('hex');
    const dep = await initUploadCommit(client, request, {
      name: `E2E Spa ${salt}`,
      files: [indexHtml(`spa ${salt}`)],
    });
    await waitForState(client, dep.deployId, 'ready');

    // SPA (default routing): an extensionless client route serves index.html.
    const route = await request.get(`${dep.url}/dashboard/settings`);
    expect(route.status()).toBe(200);
    expect(await route.text()).toContain(`spa ${salt}`);

    // A missing ASSET (has an extension) is a real 404 — never HTML-as-JS.
    const missing = await request.get(`${dep.url}/assets/missing.js`);
    expect(missing.status()).toBe(404);
  } finally {
    await transport.close();
  }
});

test('team-only app gates anonymous (404) but serves a member @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const { client, transport } = await deployClient(page, request);
  try {
    const salt = randomBytes(6).toString('hex');
    const dep = await initUploadCommit(client, request, {
      name: `E2E Team ${salt}`,
      files: [indexHtml(`team ${salt}`)],
    });
    await waitForState(client, dep.deployId, 'ready');
    const { appId } = await appIds(dep);

    // Flip to team-only BEFORE the first serve (serve cache is still empty).
    await withDb((c) =>
      c.query(`UPDATE apps SET visibility = 'team' WHERE id = $1`, [appId])
    );

    // Anonymous (the isolated request context has no session) → anti-enum 404.
    const anon = await request.get(dep.url);
    expect(anon.status(), 'anonymous is 404, not the app bytes').toBe(404);
    expect(await anon.text()).not.toContain(`team ${salt}`);

    // The deployer (page has the session; owner of the workspace) → served.
    const member = await page.request.get(dep.url);
    expect(member.status()).toBe(200);
    expect(await member.text()).toContain(`team ${salt}`);
  } finally {
    await transport.close();
  }
});

test('password app: page → wrong denied → correct unlocks via scoped cookie @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const { client, transport } = await deployClient(page, request);
  try {
    const salt = randomBytes(6).toString('hex');
    const password = `sekret-${salt}`;
    const dep = await initUploadCommit(client, request, {
      name: `E2E Pw ${salt}`,
      files: [indexHtml(`pw ${salt}`)],
    });
    await waitForState(client, dep.deployId, 'ready');
    const { appId } = await appIds(dep);

    await withDb((c) =>
      c.query(
        `UPDATE apps SET visibility = 'password', password_hash = $2 WHERE id = $1`,
        [appId, hashAppPassword(password)]
      )
    );

    // The test's `request` fixture is cookie-isolated from the browser page —
    // anonymous and not a workspace member.
    const anon: APIRequestContext = request;

    // No cookie → the password page (NOT the app bytes).
    const page1 = await anon.get(dep.url);
    expect(page1.status()).toBe(200);
    const page1Body = await page1.text();
    expect(page1Body).toContain('password protected');
    expect(page1Body).not.toContain(`pw ${salt}`);

    // Wrong password → 401, no access cookie.
    const wrong = await anon.post(dep.url, {
      form: { password: 'not-it' },
      maxRedirects: 0,
    });
    expect(wrong.status()).toBe(401);
    expect(setCookieValues(wrong).some((v) => v.includes('drobek_app_access'))).toBe(false);

    // Correct password → 303 + a path-scoped app-access cookie.
    const ok = await anon.post(dep.url, {
      form: { password },
      maxRedirects: 0,
    });
    expect(ok.status()).toBe(303);
    const accessCookie = setCookieValues(ok).find((v) => v.includes('drobek_app_access'));
    expect(accessCookie, 'app-access cookie set').toBeTruthy();
    expect(accessCookie).toContain(`Path=/${dep.workspaceSlug}/app/${dep.appSlug}`);
    expect(accessCookie).toContain('HttpOnly');

    // The cookie is now in the jar → the app serves.
    const served = await anon.get(dep.url);
    expect(served.status()).toBe(200);
    expect(await served.text()).toContain(`pw ${salt}`);
  } finally {
    await transport.close();
  }
});

test('rollback busts the serve cache — the prior version serves immediately @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const { client, transport } = await deployClient(page, request);
  try {
    const salt = randomBytes(6).toString('hex');
    const slug = `rbserve-${salt}`;

    // v1
    const v1 = await initUploadCommit(client, request, {
      slug,
      files: [indexHtml(`v1 ${salt}`), file('app.js', `// v1 ${salt}`, 'application/javascript')],
    });
    await waitForState(client, v1.deployId, 'ready');

    // v2 becomes active
    const v2 = await initUploadCommit(client, request, {
      slug,
      files: [indexHtml(`v2 ${salt}`), file('app.js', `// v2 ${salt}`, 'application/javascript')],
    });
    const v2ready = await waitForState(client, v2.deployId, 'ready');
    expect(v2ready.active).toBe(true);

    // Serve v2 (populates the serve cache with the v2 pointer + manifest).
    const serveV2 = await request.get(v1.url);
    expect(serveV2.status()).toBe(200);
    expect(await serveV2.text()).toContain(`v2 ${salt}`);

    // Roll back to v1.
    const rb = await callTool(client, 'rollback', { slug });
    expect(rb.isError, JSON.stringify(rb.json)).toBe(false);
    expect(rb.json.restoredDeployId).toBe(v1.deployId);

    // Immediately after: the rolled-back v1 content serves (cache was busted).
    const serveV1 = await request.get(v1.url);
    expect(serveV1.status()).toBe(200);
    expect(await serveV1.text()).toContain(`v1 ${salt}`);
  } finally {
    await transport.close();
  }
});
