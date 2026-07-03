import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { expect, test } from '@playwright/test';
import {
  loginViaEmail,
  logout,
  skipUnlessLocal,
  uniqueEmail,
} from './helpers/auth';
import {
  deployClient,
  file,
  indexHtml,
  initUploadCommit,
  waitForState,
} from './helpers/deploy';

/**
 * U8 acceptance (PHY-74 slice / PHY-62): the minimal dashboard.
 *   (1) admin flow — deploy v1 then v2 (active=v2), then via the UI:
 *       /workspaces/:slug/apps lists the app with its live URL → the app detail
 *       shows the deploy HISTORY (v1 + v2, v2 active) → "Roll back" on v1 makes
 *       v1 active AND the served app now returns v1 (rollback busted the cache).
 *   (2) viewer — a viewer member sees the app + history but NO rollback button,
 *       and a direct POST to the rollback action is rejected 403 server-side.
 *   (3) @smoke — an anonymous request to the apps route redirects to /login.
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

async function workspaceIdFor(ws: string, appSlug: string): Promise<string> {
  return withDb(async (c) => {
    const res = await c.query(
      `SELECT a.workspace_id
         FROM apps a JOIN workspaces w ON w.id = a.workspace_id
        WHERE w.slug = $1 AND a.slug = $2`,
      [ws, appSlug]
    );
    expect(res.rows.length, 'app row exists').toBe(1);
    return res.rows[0].workspace_id as string;
  });
}

test('dashboard: apps list → deploy history → UI rollback reflects new active + serving @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const { client, transport } = await deployClient(page, request);
  try {
    const salt = randomBytes(6).toString('hex');
    const slug = `dash-${salt}`;

    // v1 (ready)
    const v1 = await initUploadCommit(client, request, {
      name: `E2E Dash ${salt}`,
      slug,
      files: [
        indexHtml(`v1 ${salt}`),
        file('app.js', `// v1 ${salt}`, 'application/javascript'),
      ],
    });
    await waitForState(client, v1.deployId, 'ready');

    // v2 (becomes active)
    const v2 = await initUploadCommit(client, request, {
      slug,
      files: [
        indexHtml(`v2 ${salt}`),
        file('app.js', `// v2 ${salt}`, 'application/javascript'),
      ],
    });
    const v2ready = await waitForState(client, v2.deployId, 'ready');
    expect(v2ready.active).toBe(true);

    const ws = v1.workspaceSlug;
    const appSlug = v1.appSlug;

    // APPS LIST: the app appears with its live URL.
    await page.goto(`/workspaces/${ws}/apps`);
    const appRow = page.locator(
      `[data-testid="app-row"][data-app-slug="${appSlug}"]`
    );
    await expect(appRow).toHaveCount(1);
    await expect(
      appRow.locator('[data-testid="app-live-url"]')
    ).toHaveAttribute('href', `/${ws}/app/${appSlug}`);

    // Open the app detail via the list link.
    await appRow.locator('[data-testid="app-detail-link"]').click();
    await page.waitForURL(new RegExp(`/workspaces/${ws}/apps/${appSlug}$`));

    // DEPLOY HISTORY: v1 + v2 present, v2 flagged active.
    const v1row = page.locator(
      `[data-testid="deploy-row"][data-deploy-id="${v1.deployId}"]`
    );
    const v2row = page.locator(
      `[data-testid="deploy-row"][data-deploy-id="${v2.deployId}"]`
    );
    await expect(v1row).toHaveCount(1);
    await expect(v2row).toHaveCount(1);
    await expect(v2row.locator('[data-testid="deploy-active"]')).toBeVisible();
    await expect(v1row.locator('[data-testid="deploy-active"]')).toHaveCount(0);

    // Serving currently returns v2.
    const before = await request.get(v1.url);
    expect(before.status()).toBe(200);
    expect(await before.text()).toContain(`v2 ${salt}`);

    // ROLL BACK to v1 from the UI.
    await v1row.locator('[data-testid="rollback-button"]').click();

    // The page reflects v1 as the active deploy now.
    await expect(
      page.locator(
        `[data-testid="deploy-row"][data-deploy-id="${v1.deployId}"] [data-testid="deploy-active"]`
      )
    ).toBeVisible();
    await expect(
      page.locator(
        `[data-testid="deploy-row"][data-deploy-id="${v2.deployId}"] [data-testid="deploy-active"]`
      )
    ).toHaveCount(0);

    // And serving now returns v1 (rollback busted the serve cache).
    const after = await request.get(v1.url);
    expect(after.status()).toBe(200);
    expect(await after.text()).toContain(`v1 ${salt}`);
  } finally {
    await transport.close();
  }
});

test('dashboard: a viewer sees the app + history but cannot roll back (no button, POST 403) @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();

  const salt = randomBytes(6).toString('hex');
  const slug = `dashv-${salt}`;

  // Admin deploys v1 + v2 into their (personal) workspace.
  const { client, transport } = await deployClient(page, request);
  let ws = '';
  let appSlug = '';
  let v1Id = '';
  let v2Id = '';
  try {
    const v1 = await initUploadCommit(client, request, {
      name: `E2E DashV ${salt}`,
      slug,
      files: [
        indexHtml(`v1 ${salt}`),
        file('app.js', `// v1 ${salt}`, 'application/javascript'),
      ],
    });
    await waitForState(client, v1.deployId, 'ready');
    const v2 = await initUploadCommit(client, request, {
      slug,
      files: [
        indexHtml(`v2 ${salt}`),
        file('app.js', `// v2 ${salt}`, 'application/javascript'),
      ],
    });
    await waitForState(client, v2.deployId, 'ready');
    ws = v1.workspaceSlug;
    appSlug = v1.appSlug;
    v1Id = v1.deployId;
    v2Id = v2.deployId;
  } finally {
    await transport.close();
  }

  const adminWorkspaceId = await workspaceIdFor(ws, appSlug);

  // A DIFFERENT user signs in and is made a VIEWER of the admin's workspace
  // (personal workspaces have no invite form, so seed the membership directly —
  // the role middleware only reads the memberships table).
  const viewerEmail = uniqueEmail('dash-viewer');
  await logout(page);
  await loginViaEmail(page, request, viewerEmail);
  const viewerUserId = await withDb(async (c) => {
    const res = await c.query(`SELECT id FROM users WHERE email = $1`, [
      viewerEmail,
    ]);
    expect(res.rows.length, 'viewer user exists').toBe(1);
    return res.rows[0].id as string;
  });
  await withDb((c) =>
    c.query(
      `INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'viewer')`,
      [viewerUserId, adminWorkspaceId]
    )
  );

  // The viewer sees the app in the list...
  await page.goto(`/workspaces/${ws}/apps`);
  await expect(
    page.locator(`[data-testid="app-row"][data-app-slug="${appSlug}"]`)
  ).toHaveCount(1);

  // ...and the full deploy history on the detail page...
  await page.goto(`/workspaces/${ws}/apps/${appSlug}`);
  await expect(
    page.locator(`[data-testid="deploy-row"][data-deploy-id="${v1Id}"]`)
  ).toHaveCount(1);
  await expect(
    page.locator(`[data-testid="deploy-row"][data-deploy-id="${v2Id}"]`)
  ).toHaveCount(1);

  // ...but NO rollback button anywhere.
  await expect(page.locator('[data-testid="rollback-button"]')).toHaveCount(0);

  // A direct POST to the rollback action is rejected server-side (editor gate).
  const res = await page.request.post(`/workspaces/${ws}/apps/${appSlug}`, {
    form: { toDeployId: v1Id },
  });
  expect(res.status()).toBe(403);

  // The blocked POST changed nothing — the app still serves v2.
  const serve = await request.get(`/${ws}/app/${appSlug}`);
  expect(serve.status()).toBe(200);
  expect(await serve.text()).toContain(`v2 ${salt}`);
});

test('anonymous /workspaces/:slug/apps redirects to /login @smoke', async ({
  page,
}) => {
  await page.goto('/workspaces/dash-smoke-nobody/apps');
  await page.waitForURL(/\/login/);
  await expect(page.getByLabel('Email')).toBeVisible();
});
