import { expect, test } from '@playwright/test';
import {
  loginViaEmail,
  logout,
  skipUnlessLocal,
  uniqueEmail,
} from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';
import {
  addMembership,
  publishVersion,
  seedApp,
  seedAppErrors,
  seedDailyStats,
  seedVersion,
  userIdByEmail,
  withDb,
  workspaceIdBySlug,
} from './helpers/seed';

/**
 * PHY-123 acceptance (agent loop v1): the observe half of the change→observe→fix
 * loop. The public error beacon + app serving routes are gone (NSO-281), so the
 * captured signals are SEEDED straight into app_errors / app_daily_stats — the
 * rows the ingest path stores — and the READ side is asserted end-to-end:
 *   (1) app_errors returns them DEDUPED (message + stack head) with counts + a
 *       file hint; `since` narrows the window; app_logs returns requests / 5xx /
 *       top-404s + recentVersions with the compile status + published flag; the
 *       dashboard Overview renders both panels (stored text React-escaped).
 *   (2) authz: a member reads app_errors/app_logs (unknown app → not_found); a
 *       cross-workspace token cannot; a seeded viewer reads the dashboard panel
 *       but a non-member gets 404; a soft-deleted app 404s for the member too.
 */

const READ_SCOPE = 'read';

test('agent loop: app_errors (deduped) + app_logs (top-404, recentVersions) over MCP + dashboard panels @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const { client, transport, workspace: ws } = await mcpClient(page, request, {
    tag: 'loop',
    scope: READ_SCOPE,
  });
  try {
    // app_errors + app_logs are registered under the read scope.
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('app_errors');
    expect(tools).toContain('app_logs');

    const app = await seedApp({ workspaceId: await workspaceIdBySlug(ws) });
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

    // ── MCP app_errors: deduped + counted + file hint ─────────────────────────
    const errs = await callTool(client, 'app_errors', {
      workspace: ws,
      slug: app.slug,
    });
    expect(errs.isError, JSON.stringify(errs.json)).toBe(false);
    expect(errs.json.workspace).toBe(ws);
    expect(errs.json.app).toBe(app.slug);
    expect(errs.json.totalEvents).toBe(4);
    expect(errs.json.distinctErrors).toBe(2);
    const errors = errs.json.errors as {
      type: string;
      message: string;
      count: number;
      fileHint: string | null;
      lastUrl: string;
    }[];
    // Sorted by count desc → the repeated error first.
    expect(errors[0].message).toBe(dup.message);
    expect(errors[0].count).toBe(3);
    expect(errors[0].type).toBe('error');
    expect(errors[0].fileHint).toBe('app.js:12:5');
    expect(errors[0].lastUrl).toBe(pageUrl);
    expect(errors[1]).toMatchObject({
      type: 'unhandledrejection',
      message: markup,
      count: 1,
      fileHint: 'api.js:5:1',
    });

    // `since` in the future → an empty window.
    const later = await callTool(client, 'app_errors', {
      workspace: ws,
      slug: app.slug,
      since: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(later.isError, JSON.stringify(later.json)).toBe(false);
    expect(later.json.totalEvents).toBe(0);
    expect(later.json.errors).toEqual([]);

    // ── MCP app_logs: serving signals + recent versions ───────────────────────
    const logs = await callTool(client, 'app_logs', {
      workspace: ws,
      slug: app.slug,
    });
    expect(logs.isError, JSON.stringify(logs.json)).toBe(false);
    expect(logs.json.app).toBe(app.slug);
    expect(logs.json.requests).toBe(12);
    expect(logs.json.count5xx).toBe(1);
    expect(logs.json.top404Paths).toEqual([
      { path: '/missing.js', count: 3 },
      { path: '/favicon.ico', count: 1 },
    ]);
    expect(logs.json).not.toHaveProperty('recentDeploys');
    const recent = logs.json.recentVersions as {
      number: number;
      compileStatus: string;
      actorKind: string;
      published: boolean;
      createdAt: string;
    }[];
    expect(
      recent.map(({ number, compileStatus, actorKind, published }) => ({
        number,
        compileStatus,
        actorKind,
        published,
      }))
    ).toEqual([
      { number: 3, compileStatus: 'error', actorKind: 'agent', published: false },
      { number: 2, compileStatus: 'ok', actorKind: 'user', published: true },
      { number: 1, compileStatus: 'ok', actorKind: 'agent', published: false },
    ]);
    expect(Number.isNaN(Date.parse(recent[0].createdAt))).toBe(false);

    // ── Dashboard Overview panels (owner is a member → viewer+) ───────────────
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
  } finally {
    await transport.close();
  }
});

test('agent loop: a cross-workspace token cannot read app_errors/app_logs; a viewer can (dashboard), a non-member cannot @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();

  // Owner A gets an app + one captured error.
  const a = await mcpClient(page, request, { tag: 'loop-owner', scope: READ_SCOPE });
  const ws = a.workspace;
  const workspaceId = await workspaceIdBySlug(ws);
  const app = await seedApp({ workspaceId });
  await seedVersion({ appId: app.id });
  const message = `Authz boom ${app.slug}`;
  await seedAppErrors(app.id, [
    { message, stack: 'Error\n    at app.js:3:3', url: 'https://x.example.test/' },
  ]);
  try {
    // Owner (a member) can read both tools over MCP.
    const own = await callTool(a.client, 'app_errors', { workspace: ws, slug: app.slug });
    expect(own.isError, JSON.stringify(own.json)).toBe(false);
    expect((own.json.errors as { message: string }[])[0].message).toBe(message);
    const ownLogs = await callTool(a.client, 'app_logs', { workspace: ws, slug: app.slug });
    expect(ownLogs.isError, JSON.stringify(ownLogs.json)).toBe(false);
    expect(ownLogs.json.requests).toBe(0);
    expect((ownLogs.json.recentVersions as unknown[]).length).toBe(1);

    // An unknown app in the right workspace → not_found.
    const missing = await callTool(a.client, 'app_errors', {
      workspace: ws,
      slug: 'e2e-no-such-app',
    });
    expect(missing.isError).toBe(true);
    expect(missing.json.error).toBe('not_found');
  } finally {
    await a.transport.close();
  }

  // Client B (a different user, not a member of A's workspace) cannot read A's app.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const b = await mcpClient(pageB, request, { tag: 'loop-cross', scope: READ_SCOPE });
  try {
    expect(b.workspace).not.toBe(ws);
    for (const tool of ['app_errors', 'app_logs']) {
      const cross = await callTool(b.client, tool, { workspace: ws, slug: app.slug });
      expect(cross.isError, `cross-workspace ${tool} must be rejected`).toBe(true);
      expect(cross.json.error).toBe('not_found');
    }
  } finally {
    await b.transport.close();
    await pageB.close();
    await ctxB.close();
  }

  // A seeded VIEWER of A's workspace can read the dashboard error panel.
  const viewerEmail = uniqueEmail('loop-viewer');
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
    await loginViaEmail(pageC, request, uniqueEmail('loop-nonmember'));
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
