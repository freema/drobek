import { expect, test } from '@playwright/test';
import {
  loginViaEmail,
  logout,
  skipUnlessLocal,
  uniqueEmail,
} from './helpers/auth';
import {
  addMembership,
  personalWorkspaceOf,
  publishVersion,
  seedApp,
  seedVersion,
  userIdByEmail,
  withDb,
} from './helpers/seed';

/**
 * U8 acceptance (PHY-74 slice / PHY-62) on the immutable-versions model
 * (NSO-281): the minimal dashboard. Apps + versions are SEEDED via SQL.
 *   (1) admin flow — /workspaces/:slug/apps lists the seeded apps with their
 *       published state + latest version → the app detail shows the VERSION
 *       HISTORY (v1 ok, v2 ok published, v3 compile error) → "Publish" on v1
 *       moves the published badge + pointer to v1. No publish button on the
 *       published version or the one that failed to compile; a direct POST of
 *       an unpublishable/unknown version is a 400 with the publish-error alert.
 *   (2) viewer — a viewer member sees the app + history but NO publish button,
 *       and a direct POST to the publish action is rejected 403 server-side.
 *   (3) @smoke — an anonymous request to the apps route redirects to /login.
 */

async function publishedVersionId(appId: string): Promise<string | null> {
  return withDb(async (c) => {
    const res = await c.query(
      `SELECT published_version_id FROM apps WHERE id = $1`,
      [appId]
    );
    return (res.rows[0]?.published_version_id as string | null) ?? null;
  });
}

test('dashboard: apps list → version history → UI publish of an older version moves the published pointer @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('dash-admin');
  await loginViaEmail(page, request, email);
  // Watch the console from here on: the login helper navigates away from /me
  // mid route-discovery, which aborts a harmless manifest prefetch.
  await page.waitForLoadState('networkidle');
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  const ws = await personalWorkspaceOf(email);
  const userId = await userIdByEmail(email);

  const app = await seedApp({ workspaceId: ws.id });
  const v1 = await seedVersion({
    appId: app.id,
    files: [{ path: 'index.html', content: '<h1>v1</h1>' }],
    reasoning: 'first cut',
  });
  const v2 = await seedVersion({
    appId: app.id,
    files: [{ path: 'index.html', content: '<h1>v2</h1>' }],
    actorKind: 'user',
    userId,
  });
  const v3 = await seedVersion({
    appId: app.id,
    files: [{ path: 'index.html', content: '<h1>v3 <broken</h1>' }],
    compileStatus: 'error',
    compileErrors: [{ message: 'Unexpected token' }],
  });
  await publishVersion(app.id, v2.id);
  // A second app with no versions at all → "not published".
  const empty = await seedApp({ workspaceId: ws.id });

  // ── APPS LIST ───────────────────────────────────────────────────────────────
  await page.goto(`/workspaces/${ws.slug}/apps`);
  const appRow = page.locator(
    `[data-testid="app-row"][data-app-slug="${app.slug}"]`
  );
  await expect(appRow).toHaveCount(1);
  await expect(appRow).toContainText('published');
  await expect(appRow).not.toContainText('not published');
  await expect(appRow.getByTestId('app-latest-version')).toContainText('v3');

  const emptyRow = page.locator(
    `[data-testid="app-row"][data-app-slug="${empty.slug}"]`
  );
  await expect(emptyRow).toContainText('not published');
  await expect(emptyRow.getByTestId('app-latest-version')).toHaveCount(0);

  // Open the app detail via the list link.
  await appRow.getByTestId('app-detail-link').click();
  await page.waitForURL(new RegExp(`/workspaces/${ws.slug}/apps/${app.slug}$`));

  // ── VERSION HISTORY: newest first, v2 published ─────────────────────────────
  const rows = page.locator('[data-testid="version-row"]');
  await expect(rows).toHaveCount(3);
  expect(
    await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-version')))
  ).toEqual(['3', '2', '1']);

  const row = (n: number) =>
    page.locator(`[data-testid="version-row"][data-version="${n}"]`);
  await expect(page.getByTestId('app-published-version')).toContainText('v2');
  await expect(row(2).getByTestId('version-published')).toBeVisible();
  await expect(page.getByTestId('version-published')).toHaveCount(1);
  await expect(row(1)).toContainText('first cut');
  await expect(row(1)).toContainText('agent');
  await expect(row(2)).toContainText('user');
  await expect(row(3)).toContainText('errors');

  // Publish is offered ONLY on v1: v2 is already published, v3 did not compile.
  const buttons = page.getByTestId('publish-button');
  await expect(buttons).toHaveCount(1);
  await expect(buttons).toHaveAttribute('data-version', '1');
  await expect(row(3).getByTestId('publish-button')).toHaveCount(0);

  // ── PUBLISH v1 (the rollback) from the UI ───────────────────────────────────
  await row(1).getByTestId('publish-button').click();
  await expect(row(1).getByTestId('version-published')).toBeVisible();
  await expect(row(2).getByTestId('version-published')).toHaveCount(0);
  await expect(page.getByTestId('app-published-version')).toContainText('v1');
  // …and now v2 is the publishable one.
  await expect(page.getByTestId('publish-button')).toHaveCount(1);
  await expect(page.getByTestId('publish-button')).toHaveAttribute('data-version', '2');
  expect(await publishedVersionId(app.id)).toBe(v1.id);

  // ── A version that failed to compile / an unknown id → 400 + alert ─────────
  const bad = await page.request.post(`/workspaces/${ws.slug}/apps/${app.slug}`, {
    form: { versionId: v3.id },
  });
  expect(bad.status()).toBe(400);
  expect(await bad.text()).toContain('publish-error');
  const unknown = await page.request.post(`/workspaces/${ws.slug}/apps/${app.slug}`, {
    form: { versionId: 'ver-does-not-exist' },
  });
  expect(unknown.status()).toBe(400);
  // Neither moved the pointer.
  expect(await publishedVersionId(app.id)).toBe(v1.id);

  await page.waitForTimeout(300);
  expect(problems).toEqual([]);
});

test('dashboard: a viewer sees the app + history but cannot publish (no button, POST 403) @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();

  // The owner signs in (materializes their personal workspace) and gets an app.
  const ownerEmail = uniqueEmail('dash-owner');
  await loginViaEmail(page, request, ownerEmail);
  const ws = await personalWorkspaceOf(ownerEmail);
  const app = await seedApp({ workspaceId: ws.id });
  const v1 = await seedVersion({ appId: app.id });
  const v2 = await seedVersion({ appId: app.id });
  await publishVersion(app.id, v2.id);

  // A DIFFERENT user signs in and is made a VIEWER of the owner's workspace.
  const viewerEmail = uniqueEmail('dash-viewer');
  await logout(page);
  await loginViaEmail(page, request, viewerEmail);
  await addMembership(await userIdByEmail(viewerEmail), ws.id, 'viewer');

  // The viewer sees the app in the list...
  await page.goto(`/workspaces/${ws.slug}/apps`);
  await expect(
    page.locator(`[data-testid="app-row"][data-app-slug="${app.slug}"]`)
  ).toHaveCount(1);

  // ...and the full version history on the detail page...
  await page.goto(`/workspaces/${ws.slug}/apps/${app.slug}`);
  await expect(page.locator('[data-testid="version-row"]')).toHaveCount(2);
  await expect(
    page.locator('[data-testid="version-row"][data-version="2"] [data-testid="version-published"]')
  ).toBeVisible();

  // ...but NO publish button anywhere.
  await expect(page.getByTestId('publish-button')).toHaveCount(0);

  // A direct POST to the publish action is rejected server-side (editor gate).
  const res = await page.request.post(`/workspaces/${ws.slug}/apps/${app.slug}`, {
    form: { versionId: v1.id },
  });
  expect(res.status()).toBe(403);

  // The blocked POST changed nothing — v2 is still published.
  expect(await publishedVersionId(app.id)).toBe(v2.id);
});

test('anonymous /workspaces/:slug/apps redirects to /login @smoke', async ({
  page,
}) => {
  await page.goto('/workspaces/dash-smoke-nobody/apps');
  await page.waitForURL(/\/login/);
  await expect(page.getByLabel('Email')).toBeVisible();
});
