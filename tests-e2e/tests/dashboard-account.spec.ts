import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import {
  callTool,
  connectBearer,
  consentAndCapture,
  exchangeCode,
  mcpResource,
  pkcePair,
  rawInitialize,
  registerClient,
} from './helpers/mcp';
import { personalWorkspaceOf } from './helpers/seed';

/**
 * M2-04 (NSO-284) acceptance — the account area:
 *   (1) /me/api-keys: a key created in the dashboard (shown exactly once)
 *       works for MCP `initialize` + a read tool; after "Revoke" the very next
 *       request is 401 (well within 1 s — the RS reads the key row, no cache).
 *   (2) /me/connections: the OAuth client that got a grant is listed with its
 *       DCR name + scopes; "Revoke" kills its access token (401) and BOTH its
 *       rotated and its current refresh token (`invalid_grant` on reuse).
 *   (3) Activity (personal workspace): api_key.create / api_key.revoke /
 *       oauth_client.revoke rows, the actor filter (user vs end_user), and the
 *       CSV export carries the new actions.
 *   (4) The AGPL-3.0 §13 footer links to the running commit of freema/drobek.
 */

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  error?: string;
}

async function refresh(
  request: APIRequestContext,
  opts: { refreshToken: string; clientId: string }
): Promise<{ status: number; body: TokenBody }> {
  const res = await request.post(`${BASE_URL_WEB}/oauth/token`, {
    form: {
      grant_type: 'refresh_token',
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
    },
  });
  return { status: res.status(), body: (await res.json()) as TokenBody };
}

/** Collect console.error + pageerror problems for a "console clean" assertion. */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  return problems;
}

const SOURCE_HREF_RE = /^https:\/\/github\.com\/freema\/drobek\/(commit\/[0-9a-f]{7,40}|tree\/main)$/;

test('account: API key create → MCP initialize → revoke → 401 within 1 s; shown once @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('apikey');
  await loginViaEmail(page, request, email);
  await page.waitForLoadState('networkidle');
  const problems = watchConsole(page);

  await page.getByTestId('me-api-keys-link').click();
  await page.waitForURL(/\/me\/api-keys$/);
  await expect(page.getByTestId('api-keys-empty')).toBeVisible();

  // Create a read-only key (write is pre-checked, publish is not).
  await page.getByTestId('api-key-name').fill('e2e read key');
  await page.getByTestId('api-key-scope-write').uncheck();
  await expect(page.getByTestId('api-key-scope-publish')).not.toBeChecked();
  await page.getByTestId('api-key-create').click();
  const value = page.getByTestId('api-key-value');
  await expect(value).toBeVisible();
  const key = (await value.textContent())?.trim() ?? '';
  expect(key).toMatch(/^drk_[A-Za-z0-9_-]{32}$/);

  const row = page.locator('[data-testid="api-key-row"][data-status="active"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('e2e read key');
  await expect(row).toContainText('read');
  await expect(row.getByTestId('api-key-last-used')).toHaveText('—');

  // The key works: a raw initialize is accepted and the SDK client can call a
  // read tool (only read-scoped tools are registered for this key).
  const init = await rawInitialize(request, { Authorization: `Bearer ${key}` });
  expect(init.status()).toBe(200);
  const { client } = await connectBearer(key);
  const listed = await callTool(client, 'list_apps', {});
  expect(listed.isError, JSON.stringify(listed.json)).toBe(false);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  expect(tools).toContain('list_apps');
  expect(tools).not.toContain('create_app');
  expect(tools).not.toContain('publish');
  await client.close();

  // Shown exactly once: a fresh GET of the page never contains the key again,
  // but the key is now marked as used.
  await page.goto('/me/api-keys');
  await expect(page.getByTestId('api-key-value')).toHaveCount(0);
  expect(await page.content()).not.toContain(key);
  await expect(
    page.locator('[data-testid="api-key-row"][data-status="active"] [data-testid="api-key-last-used"]')
  ).toHaveText(/UTC$/);

  // Revoke → the very next MCP request is 401 (no cache), well within 1 s.
  const posted = page.waitForResponse(
    (r) => r.url().includes('/me/api-keys') && r.request().method() === 'POST'
  );
  await page
    .locator('[data-testid="api-key-row"][data-status="active"]')
    .getByTestId('api-key-revoke')
    .click();
  await posted;
  const revokedAt = Date.now();
  const dead = await rawInitialize(request, { Authorization: `Bearer ${key}` });
  expect(dead.status()).toBe(401);
  expect(Date.now() - revokedAt).toBeLessThan(1000);

  await expect(page.locator('[data-testid="api-key-row"][data-status="revoked"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="api-key-row"][data-status="active"]')).toHaveCount(0);

  // A create with no scope is refused with a message, not a 500.
  await page.getByTestId('api-key-name').fill('no scopes');
  await page.getByTestId('api-key-scope-read').uncheck();
  await page.getByTestId('api-key-scope-write').uncheck();
  await page.getByTestId('api-key-create').click();
  await expect(page.getByTestId('api-key-error')).toContainText('at least one scope');
  await expect(page.locator('[data-testid="api-key-row"]')).toHaveCount(1);

  await page.waitForLoadState('networkidle');
  expect(problems).toEqual([]);
});

test('account: OAuth connection is listed; revoke kills access + refresh (reuse → invalid_grant); Activity + CSV + footer @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('conn');
  await loginViaEmail(page, request, email);
  await page.waitForLoadState('networkidle');

  // A real OAuth grant for a DCR client (consent in the browser, PKCE).
  const resource = await mcpResource(request);
  const clientId = await registerClient(request);
  const { verifier, challenge } = pkcePair();
  const redirect = await consentAndCapture(page, {
    clientId,
    challenge,
    resource,
    scope: 'read write',
  });
  const code = redirect.searchParams.get('code') as string;
  expect(code).toBeTruthy();
  const tok = await exchangeCode(request, { code, verifier, clientId });
  expect(tok.status).toBe(200);
  const firstRefresh = tok.body.refresh_token as string;

  // One rotation, so the lineage holds a used AND a live refresh token.
  const rot = await refresh(request, { refreshToken: firstRefresh, clientId });
  expect(rot.status).toBe(200);
  const access = rot.body.access_token as string;
  const liveRefresh = rot.body.refresh_token as string;
  expect((await rawInitialize(request, { Authorization: `Bearer ${access}` })).status()).toBe(200);

  // Also an API key, so the Activity view gets both account actions.
  await page.goto('/me/api-keys');
  await page.getByTestId('api-key-name').fill('activity key');
  await page.getByTestId('api-key-create').click();
  await expect(page.getByTestId('api-key-value')).toBeVisible();
  await page.getByTestId('api-key-revoke').click();
  await expect(page.locator('[data-testid="api-key-row"][data-status="revoked"]')).toHaveCount(1);

  // /me/connections lists the client with its DCR name and granted scopes.
  await page.goto('/me/connections');
  const row = page.locator(`[data-testid="connection-row"][data-client-id="${clientId}"]`);
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('connection-name')).toHaveText('drobek e2e MCP client');
  await expect(row).toHaveAttribute('data-source', 'dcr');
  await expect(row).toContainText('read');
  await expect(row).toContainText('write');
  await expect(row.getByTestId('connection-last-used')).toHaveText(/UTC$/);

  await row.getByTestId('connection-revoke').click();
  await expect(page.getByTestId('connections-empty')).toBeVisible();

  // The access token is dead on the next call…
  expect((await rawInitialize(request, { Authorization: `Bearer ${access}` })).status()).toBe(401);
  // …and neither refresh token of the lineage can mint a new grant.
  for (const refreshToken of [liveRefresh, firstRefresh]) {
    const reuse = await refresh(request, { refreshToken, clientId });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe('invalid_grant');
    expect(reuse.body.access_token).toBeUndefined();
  }

  // ── Activity (personal workspace): the new actions, actor filter, CSV ─────
  const ws = await personalWorkspaceOf(email);
  await page.goto(`/workspaces/${ws.slug}/activity`);
  await expect(page.getByTestId('activity-table')).toBeVisible();
  for (const action of ['api_key.create', 'api_key.revoke', 'oauth_client.revoke']) {
    const r = page.locator(`[data-testid="activity-row"][data-action="${action}"]`);
    await expect(r).toHaveCount(1);
    await expect(r).toHaveAttribute('data-actor-kind', 'user');
    await expect(r.getByTestId('activity-actor')).toContainText(email);
  }
  await expect(
    page.locator('[data-testid="activity-row"][data-action="oauth_client.revoke"]')
  ).toHaveAttribute('data-subject', clientId);

  // The actor filter: end-user rows only → none in a personal workspace
  // without apps; user rows → the account actions.
  await page.getByTestId('filter-actor').selectOption('end_user');
  await page.getByTestId('filter-apply').click();
  await page.waitForURL(/actor=end_user/);
  await expect(page.getByTestId('activity-empty')).toBeVisible();
  await page.getByTestId('filter-actor').selectOption('user');
  await page.getByTestId('filter-apply').click();
  await page.waitForURL(/actor=user/);
  await expect(
    page.locator('[data-testid="activity-row"][data-action="api_key.create"]')
  ).toHaveCount(1);

  // The action dropdown knows the new actions.
  const options = await page.getByTestId('filter-action').locator('option').allTextContents();
  for (const a of ['api_key.create', 'api_key.revoke', 'oauth_client.revoke', 'data.export']) {
    expect(options).toContain(a);
  }

  const csvRes = await page.request.get(`/workspaces/${ws.slug}/activity/export.csv?actor=user`);
  expect(csvRes.status()).toBe(200);
  const csvLines = (await csvRes.text()).split('\r\n').filter((l) => l.length > 0);
  expect(csvLines[0]).toBe('time,action,actor_kind,actor,subject_type,subject');
  const actions = csvLines.slice(1).map((l) => l.split(',')[1]);
  expect(actions).toEqual(
    expect.arrayContaining(['api_key.create', 'api_key.revoke', 'oauth_client.revoke'])
  );
  const revokeLine = csvLines.find((l) => l.split(',')[1] === 'oauth_client.revoke') as string;
  expect(revokeLine.split(',').slice(2)).toEqual(['user', email, 'oauth_client', clientId]);
  const endUserCsv = await (
    await page.request.get(`/workspaces/${ws.slug}/activity/export.csv?actor=end_user`)
  ).text();
  expect(endUserCsv.split('\r\n').filter((l) => l.length > 0)).toHaveLength(1);

  // ── AGPL-3.0 §13 footer: every dashboard page links to the running commit ─
  const version = (await (await request.get(`${BASE_URL_WEB}/api/version`)).json()) as {
    sha: string;
  };
  for (const path of ['/', '/me', '/me/api-keys', '/me/connections', `/workspaces/${ws.slug}/activity`]) {
    await page.goto(path);
    const link = page.getByTestId('source-link');
    await expect(link, `footer on ${path}`).toBeVisible();
    const href = (await link.getAttribute('href')) ?? '';
    expect(href).toMatch(SOURCE_HREF_RE);
    if (/^[0-9a-f]{7,40}$/.test(version.sha)) {
      expect(href).toBe(`https://github.com/freema/drobek/commit/${version.sha}`);
      await expect(link).toHaveText(`Source (AGPL-3.0) · ${version.sha.slice(0, 7)}`);
    } else {
      expect(href).toBe('https://github.com/freema/drobek/tree/main');
      await expect(link).toHaveText('Source (AGPL-3.0) · dev');
    }
  }
  await page.waitForLoadState('networkidle');
});

test('account pages require a session @local', async ({ page }) => {
  skipUnlessLocal();
  for (const path of ['/me/api-keys', '/me/connections']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login/);
  }
});
