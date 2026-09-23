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
  seedAppErrors,
  seedDailyStats,
  seedVersion,
  userIdByEmail,
  withDb,
} from './helpers/seed';

/**
 * Dashboard insight panels (PHY-123, formerly agent-loop.spec.ts — the agent
 * loop itself is mcp-loop.spec.ts since M0-08): the captured runtime signals
 * render on the app Overview. The signals are SEEDED straight into app_errors /
 * app_daily_stats — the rows the ingest path stores — and the Errors + Logs
 * panels are asserted end-to-end (stored text React-escaped), plus the authz:
 * a seeded viewer reads the panel, a non-member gets 404, a soft-deleted app
 * 404s for the member too.
 */

test('dashboard insights: deduped errors + serving signals render on the app Overview @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('insights');
  await loginViaEmail(page, request, email);
  const personal = await personalWorkspaceOf(email);
  const ws = personal.slug;
  const app = await seedApp({ workspaceId: personal.id });
  await seedVersion({ appId: app.id });
  const v2 = await seedVersion({ appId: app.id, actorKind: 'user' });
  await seedVersion({ appId: app.id, compileStatus: 'error' });
  await publishVersion(app.id, v2.id);

  // The SAME error 3× (same message + stack head → one dedup group) plus one
  // distinct rejection whose message carries markup (must render escaped).
  const pageUrl = `https://${app.slug}.example.test/`;
  const dup = {
    message: 'TypeError: cfg.load is not a function',
    stack:
      'TypeError: cfg.load is not a function\n    at boot (app.js:12:5)\n    at main (app.js:40:3)',
    url: pageUrl,
    ua: 'e2e-agent',
  };
  const markup = '<b data-xss="1">boom</b> rejected';
  await seedAppErrors(app.id, [
    dup,
    dup,
    dup,
    {
      type: 'unhandledrejection',
      message: markup,
      stack: 'Error\n    at fetch (api.js:5:1)',
      url: `${pageUrl}list`,
    },
  ]);
  await seedDailyStats(app.id, {
    requestCount: 12,
    count5xx: 1,
    path404Counts: { '/missing.js': 3, '/favicon.ico': 1 },
  });

  // ── Dashboard Overview panels (owner is a member → viewer+) ───────────────
  // Let the previous page settle first: in dev, React Router's lazy route
  // discovery (`/__manifest`) aborted by our own navigation logs "Failed to
  // fetch manifest patches" — noise from the test, not from this page.
  await page.waitForLoadState('networkidle');
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(`/workspaces/${ws}/apps/${app.slug}`);
  await expect(page.getByTestId('errors-panel')).toBeVisible();
  await expect(page.getByTestId('errors-total')).toHaveText('4 events');
  const errorRows = page.getByTestId('error-row');
  await expect(errorRows).toHaveCount(2);
  await expect(errorRows.first().getByTestId('error-count')).toHaveText('3×');
  await expect(errorRows.first().getByTestId('error-message')).toHaveText(
    dup.message
  );
  await expect(errorRows.first()).toContainText('app.js:12:5');
  // The stored markup is rendered as TEXT, never as an element.
  await expect(errorRows.nth(1).getByTestId('error-message')).toHaveText(markup);
  await expect(page.locator('[data-xss]')).toHaveCount(0);

  await expect(page.getByTestId('logs-panel')).toBeVisible();
  await expect(page.getByTestId('logs-requests')).toHaveText('12');
  await expect(page.getByTestId('logs-5xx')).toHaveText('1');
  await expect(page.getByTestId('logs-404-distinct')).toHaveText('2');
  await expect(page.getByTestId('top404-path').first()).toHaveText('/missing.js');

  await page.waitForTimeout(300);
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});

test('dashboard insights: a viewer reads the error panel, a non-member cannot @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();

  // Owner A gets an app + one captured error.
  const ownerEmail = uniqueEmail('insights-owner');
  await loginViaEmail(page, request, ownerEmail);
  const personal = await personalWorkspaceOf(ownerEmail);
  const ws = personal.slug;
  const workspaceId = personal.id;
  const app = await seedApp({ workspaceId });
  await seedVersion({ appId: app.id });
  const message = `Authz boom ${app.slug}`;
  await seedAppErrors(app.id, [
    { message, stack: 'Error\n    at app.js:3:3', url: 'https://x.example.test/' },
  ]);
  await page.goto(`/workspaces/${ws}/apps/${app.slug}`);
  await expect(page.getByTestId('error-message').first()).toHaveText(message);

  // A seeded VIEWER of A's workspace can read the dashboard error panel.
  const viewerEmail = uniqueEmail('insights-viewer');
  await logout(page);
  await loginViaEmail(page, request, viewerEmail);
  await addMembership(await userIdByEmail(viewerEmail), workspaceId, 'viewer');
  await page.goto(`/workspaces/${ws}/apps/${app.slug}`);
  await expect(page.getByTestId('errors-panel')).toBeVisible();
  await expect(page.getByTestId('error-message').first()).toHaveText(message);

  // A NON-member (isolated context) gets 404 on the same page (no panel leak).
  const ctxC = await browser.newContext();
  try {
    const pageC = await ctxC.newPage();
    await loginViaEmail(pageC, request, uniqueEmail('insights-nonmember'));
    const res = await pageC.goto(`/workspaces/${ws}/apps/${app.slug}`);
    expect(res?.status()).toBe(404);
    await expect(pageC.getByTestId('errors-panel')).toHaveCount(0);
  } finally {
    await ctxC.close();
  }

  // A soft-deleted app is gone for the member too (dashboard 404).
  await withDb((c) => c.query(`UPDATE apps SET deleted_at = now() WHERE id = $1`, [app.id]));
  const gone = await page.goto(`/workspaces/${ws}/apps/${app.slug}`);
  expect(gone?.status()).toBe(404);
});
