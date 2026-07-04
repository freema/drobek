import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import {
  loginViaEmail,
  logout,
  skipUnlessLocal,
  uniqueEmail,
} from './helpers/auth';
import {
  callTool,
  deployClient,
  indexHtml,
  initUploadCommit,
  mcpClient,
  waitForState,
} from './helpers/deploy';

/**
 * PHY-123 acceptance (agent loop v1): the deploy→observe→fix loop.
 *   (1) the PUBLIC error beacon ingests errors → app_errors returns them DEDUPED
 *       with counts + a file hint; a missing path bumps app_logs' top-404s; the
 *       dashboard Overview shows both panels; a beacon carrying cookie/token
 *       fields is stored SANITIZED (psql shows no raw secret).
 *   (2) beacon security: a >8 KB payload → 413; a flood from one IP → 429.
 *   (3) authz: a member reads app_errors; a cross-workspace token cannot; a
 *       seeded viewer reads the dashboard panel but a non-member gets 404.
 * Requires the local compose stack + worker (deploys go through the pipeline).
 */

const DB_URL =
  process.env.DATABASE_URL ??
  'postgresql://drobek:drobek@localhost:5441/drobek';

async function withDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function appIdFor(ws: string, appSlug: string): Promise<string> {
  return withDb(async (c) => {
    const res = await c.query(
      `SELECT a.id FROM apps a JOIN workspaces w ON w.id = a.workspace_id
        WHERE w.slug = $1 AND a.slug = $2`,
      [ws, appSlug]
    );
    expect(res.rows.length, 'app row exists').toBe(1);
    return res.rows[0].id as string;
  });
}

async function workspaceIdFor(ws: string): Promise<string> {
  return withDb(async (c) => {
    const res = await c.query(`SELECT id FROM workspaces WHERE slug = $1`, [ws]);
    expect(res.rows.length, 'workspace row exists').toBe(1);
    return res.rows[0].id as string;
  });
}

function beaconUrl(ws: string, appSlug: string): string {
  return `${BASE_URL_WEB}/${ws}/app/${appSlug}/__beacon`;
}

/** Anonymous beacon POST (the `request` fixture carries no session cookie). */
async function postBeacon(
  request: APIRequestContext,
  ws: string,
  appSlug: string,
  body: unknown
) {
  return request.post(beaconUrl(ws, appSlug), { data: body });
}

test('agent loop: beacon → app_errors (deduped) + app_logs (top-404) + dashboard panels + sanitized storage @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const { client, transport } = await deployClient(page, request);
  try {
    const salt = randomBytes(6).toString('hex');
    const dep = await initUploadCommit(client, request, {
      name: `E2E Loop ${salt}`,
      files: [indexHtml(`loop ${salt}`)],
    });
    await waitForState(client, dep.deployId, 'ready');
    const ws = dep.workspaceSlug;
    const appSlug = dep.appSlug;
    const pageUrl = `${BASE_URL_WEB}${dep.url}`;

    // app_errors + app_logs are registered under the apps:read scope.
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('app_errors');
    expect(tools).toContain('app_logs');

    // Post the SAME error 3× (same message + stack head → one dedup group).
    const dupEvent = {
      type: 'error',
      message: 'TypeError: cfg.load is not a function',
      stack:
        'TypeError: cfg.load is not a function\n    at boot (app.js:12:5)\n    at main (app.js:40:3)',
      url: pageUrl,
      ua: 'e2e-agent',
      ts: Date.now(),
    };
    for (let i = 0; i < 3; i++) {
      const r = await postBeacon(request, ws, appSlug, dupEvent);
      expect(r.status(), 'beacon accepted').toBe(204);
    }

    // A beacon carrying PII / secret-shaped fields — must be stored sanitized.
    const secretCookie = `SUPERSECRET${salt}COOKIEVAL0123456789`;
    const secretToken = `SECRETBEARER${salt}TOKEN0123456789abcdef`;
    const secretEmail = `victim-${salt}@example.com`;
    const secretJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.abcDEFghiJKL';
    const secretRes = await postBeacon(request, ws, appSlug, {
      type: 'unhandledrejection',
      message: `auth failed for ${secretEmail} token=Bearer ${secretToken}`,
      stack: `Error\n    at fetch (app.js:5:1)`,
      url: `${pageUrl}?jwt=${secretJwt}`,
      ua: `Cookie: session=${secretCookie}`,
      ts: Date.now(),
    });
    expect(secretRes.status()).toBe(204);

    // MCP app_errors: the deduped error has count >= 3 + a file hint.
    const errs = await callTool(client, 'app_errors', {
      workspace: ws,
      slug: appSlug,
    });
    expect(errs.isError, JSON.stringify(errs.json)).toBe(false);
    expect(errs.json.app).toBe(appSlug);
    const errors = errs.json.errors as {
      message: string;
      count: number;
      fileHint: string | null;
    }[];
    expect((errs.json.distinctErrors as number)).toBeGreaterThanOrEqual(1);
    const dup = errors.find((e) =>
      e.message.includes('cfg.load is not a function')
    );
    expect(dup, 'the repeated error is grouped').toBeTruthy();
    expect(dup!.count, 'dedup count').toBeGreaterThanOrEqual(3);
    expect(dup!.fileHint).toBe('app.js:12:5');

    // Request a missing path → the app_logs top-404 surfaces it.
    const missingPath = `/${ws}/app/${appSlug}/__missing_${salt}.js`;
    const miss = await request.get(`${BASE_URL_WEB}${missingPath}`);
    expect(miss.status()).toBe(404);

    const logs = await callTool(client, 'app_logs', {
      workspace: ws,
      slug: appSlug,
    });
    expect(logs.isError, JSON.stringify(logs.json)).toBe(false);
    expect((logs.json.requests as number)).toBeGreaterThanOrEqual(1);
    const top404 = logs.json.top404Paths as { path: string; count: number }[];
    expect(
      top404.some((p) => p.path.includes(`__missing_${salt}`)),
      `top404 has the missing path: ${JSON.stringify(top404)}`
    ).toBe(true);
    // recent deploys reflect the ready deploy.
    const recent = logs.json.recentDeploys as { active: boolean }[];
    expect(recent.length).toBeGreaterThanOrEqual(1);

    // psql: NOTHING raw-secret was persisted (sanitization worked).
    const appId = await appIdFor(ws, appSlug);
    const rows = await withDb((c) =>
      c.query(
        `SELECT message, url, ua, stack FROM app_errors WHERE app_id = $1`,
        [appId]
      )
    );
    const blob = JSON.stringify(rows.rows);
    expect(blob.includes(secretCookie), 'cookie value stripped').toBe(false);
    expect(blob.includes(secretToken), 'bearer token stripped').toBe(false);
    expect(blob.includes(secretEmail), 'email stripped').toBe(false);
    expect(blob.includes(secretJwt), 'jwt stripped').toBe(false);

    // Dashboard Overview panels (owner is a member → viewer+).
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    await page.goto(`/workspaces/${ws}/apps/${appSlug}`);
    await expect(page.getByTestId('errors-panel')).toBeVisible();
    await expect(
      page.getByTestId('error-row').first()
    ).toBeVisible();
    await expect(page.getByTestId('logs-panel')).toBeVisible();
    await expect(page.getByTestId('top404-row').first()).toBeVisible();
    // The stored error message is rendered (React-escaped) in the panel.
    await expect(
      page.getByTestId('error-message').first()
    ).toContainText('cfg.load is not a function');

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  } finally {
    await transport.close();
  }
});

test('agent loop: beacon rejects a >8 KB payload (413) and rate-limits a flood (429) @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const { client, transport } = await deployClient(page, request);
  try {
    const salt = randomBytes(6).toString('hex');
    const dep = await initUploadCommit(client, request, {
      name: `E2E Beacon Sec ${salt}`,
      files: [indexHtml(`sec ${salt}`)],
    });
    await waitForState(client, dep.deployId, 'ready');
    const ws = dep.workspaceSlug;
    const appSlug = dep.appSlug;

    // >8 KB payload → 413 (rejected before parsing / rate-limit).
    const huge = {
      type: 'error',
      message: 'x'.repeat(9000),
      url: 'https://x/app',
    };
    const tooBig = await postBeacon(request, ws, appSlug, huge);
    expect(tooBig.status(), 'oversize beacon rejected').toBe(413);

    // Flood from one IP → 429 within the dev cap (BEACON_RATE_LIMIT=30).
    let got429 = false;
    for (let i = 0; i < 60; i++) {
      const r = await postBeacon(request, ws, appSlug, {
        type: 'error',
        message: `flood ${i}`,
        url: 'https://x/app',
      });
      if (r.status() === 429) {
        got429 = true;
        break;
      }
      expect([204, 429]).toContain(r.status());
    }
    expect(got429, 'a beacon flood is eventually rate-limited').toBe(true);
  } finally {
    await transport.close();
  }
});

test('agent loop: a cross-workspace token cannot read app_errors; a viewer can (dashboard), a non-member cannot @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();

  // Owner A deploys an app + seeds one error.
  const a = await deployClient(page, request);
  let ws = '';
  let appSlug = '';
  const salt = randomBytes(6).toString('hex');
  try {
    const dep = await initUploadCommit(a.client, request, {
      name: `E2E Loop Authz ${salt}`,
      files: [indexHtml(`authz ${salt}`)],
    });
    await waitForState(a.client, dep.deployId, 'ready');
    ws = dep.workspaceSlug;
    appSlug = dep.appSlug;
    const beacon = await postBeacon(request, ws, appSlug, {
      type: 'error',
      message: `Authz boom ${salt}`,
      stack: 'Error\n    at app.js:3:3',
      url: `${BASE_URL_WEB}${dep.url}`,
    });
    expect(beacon.status()).toBe(204);

    // Owner (a member) can read app_errors over MCP.
    const own = await callTool(a.client, 'app_errors', {
      workspace: ws,
      slug: appSlug,
    });
    expect(own.isError, JSON.stringify(own.json)).toBe(false);
    expect((own.json.errors as unknown[]).length).toBeGreaterThanOrEqual(1);
  } finally {
    await a.transport.close();
  }

  // Client B (a different user/workspace) — its token cannot read A's app.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const b = await mcpClient(pageB, request, {
    tag: 'loop-cross',
    scope: 'mcp:whoami apps:read deploy:write',
  });
  try {
    const cross = await callTool(b.client, 'app_errors', {
      workspace: ws,
      slug: appSlug,
    });
    expect(cross.isError, 'cross-workspace read must be rejected').toBe(true);
    expect(cross.json.error).toBe('not_found');
  } finally {
    await b.transport.close();
    await pageB.close();
    await ctxB.close();
  }

  const adminWorkspaceId = await workspaceIdFor(ws);

  // A seeded VIEWER of A's workspace can read the dashboard error panel.
  const viewerEmail = uniqueEmail('loop-viewer');
  await logout(page);
  await loginViaEmail(page, request, viewerEmail);
  const viewerUserId = await withDb(async (c) => {
    const res = await c.query(`SELECT id FROM users WHERE email = $1`, [
      viewerEmail,
    ]);
    return res.rows[0].id as string;
  });
  await withDb((c) =>
    c.query(
      `INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'viewer')`,
      [viewerUserId, adminWorkspaceId]
    )
  );
  await page.goto(`/workspaces/${ws}/apps/${appSlug}`);
  await expect(page.getByTestId('errors-panel')).toBeVisible();
  await expect(page.getByTestId('error-row').first()).toBeVisible();

  // A NON-member gets 404 on the same app detail page (no panel leak).
  const nonMemberEmail = uniqueEmail('loop-nonmember');
  await logout(page);
  await loginViaEmail(page, request, nonMemberEmail);
  const res = await page.goto(`/workspaces/${ws}/apps/${appSlug}`);
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId('errors-panel')).toHaveCount(0);
});
