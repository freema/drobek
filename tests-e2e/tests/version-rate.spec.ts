import { expect, test } from '@playwright/test';
import { skipUnlessLocal } from './helpers/auth';
import { setFakePlan } from './helpers/limits';
import { callTool, mcpClient } from './helpers/mcp';
import { personalWorkspaceOf, withDb } from './helpers/seed';

/**
 * The rate limit on new versions against the local compose stack. The env
 * defaults (600 per app, 1200 per person per hour) are too big to reach in a
 * spec, so the fake limits provider (proxy-echo, helpers/limits.ts) sets a
 * small plan for the test user's personal workspace — which also proves a
 * plan overrides the env.
 *  - VERSIONS_PER_APP_HOUR: 3 → create_app (v1) and two writes fit; the next
 *    write_files and restore_version answer `rate_limited` naming the limit,
 *    with `retry_after_seconds` and the catalogue hint; the dashboard's
 *    Restore answers 429 with Retry-After and shows the message. Once the
 *    versions are older than an hour (moved back in SQL) writing works again.
 *  - VERSIONS_PER_USER_HOUR: 2 → create_app (v1) and one write fit; the next
 *    create_app is refused before an app exists.
 */

test('VERSIONS_PER_APP_HOUR: writes and restores past the plan are rate_limited over MCP and in the dashboard @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  test.setTimeout(120_000);
  const mcp = await mcpClient(page, request, { tag: 'version-rate-app' });
  const ws = await personalWorkspaceOf(mcp.email);
  await setFakePlan(ws.id, { VERSIONS_PER_APP_HOUR: 3 });
  try {
    const created = await callTool(mcp.client, 'create_app', { name: 'Busy loop', workspace: mcp.workspace, template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const appId = String(created.json.app_id);
    const slug = String(created.json.slug);
    expect(String(created.json.briefing)).toContain('New versions are rate-limited: 3 per app');

    const write = (i: number) =>
      callTool(mcp.client, 'write_files', {
        app_id: appId,
        files: [{ path: 'index.html', content: `<!doctype html><title>Busy ${i}</title><p>${i}</p>` }],
        reasoning: `Write ${i}`,
      });
    expect((await write(2)).json.version).toBe(2);
    expect((await write(3)).json.version).toBe(3);

    const over = await write(4);
    expect(over.isError).toBe(true);
    expect(over.json).toMatchObject({ code: 'rate_limited', limit: 'VERSIONS_PER_APP_HOUR', value: 3 });
    expect(Number(over.json.retry_after_seconds)).toBeGreaterThan(3000);
    expect(String(over.json.message)).toContain('nothing was stored');
    expect(String(over.json.hint)).toContain('VERSIONS_PER_APP_HOUR');

    const restored = await callTool(mcp.client, 'restore_version', { app_id: appId, version: 1 });
    expect(restored.isError).toBe(true);
    expect(restored.json).toMatchObject({ code: 'rate_limited', limit: 'VERSIONS_PER_APP_HOUR' });
    expect((await callTool(mcp.client, 'get_app', { app_id: appId })).json.latest_version).toBe(3);

    // The dashboard's Restore shares the limit.
    const base = `/workspaces/${mcp.workspace}/apps/${slug}`;
    await page.goto(base);
    await page.locator('[data-testid="restore-button"][data-version="1"]').click();
    await expect(page.getByTestId('action-error')).toContainText('VERSIONS_PER_APP_HOUR');
    const refused = await page.request.post(base, { form: { intent: 'restore', version: '1' }, maxRedirects: 0 });
    expect(refused.status()).toBe(429);
    expect(Number(refused.headers()['retry-after'])).toBeGreaterThan(3000);

    // An hour later the window is free again.
    await withDb((c) => c.query(`UPDATE app_versions SET created_at = created_at - interval '61 minutes' WHERE app_id = $1`, [appId]));
    const again = await write(4);
    expect(again.isError, again.text).toBe(false);
    expect(again.json.version).toBe(4);
  } finally {
    await setFakePlan(ws.id, null);
    await mcp.client.close();
  }
});

test('VERSIONS_PER_USER_HOUR: create_app past the plan is refused before the app exists @local', async ({ page, request }) => {
  skipUnlessLocal();
  test.setTimeout(120_000);
  const mcp = await mcpClient(page, request, { tag: 'version-rate-user' });
  const ws = await personalWorkspaceOf(mcp.email);
  await setFakePlan(ws.id, { VERSIONS_PER_USER_HOUR: 2 });
  try {
    const first = await callTool(mcp.client, 'create_app', { name: 'First of two', workspace: mcp.workspace, template: 'html' });
    expect(first.isError, first.text).toBe(false);
    const write = await callTool(mcp.client, 'write_files', {
      app_id: String(first.json.app_id),
      files: [{ path: 'index.html', content: '<!doctype html><title>Second</title>' }],
      reasoning: 'Second version',
    });
    expect(write.json.version).toBe(2);

    const second = await callTool(mcp.client, 'create_app', { name: 'One too many', workspace: mcp.workspace, template: 'html' });
    expect(second.isError).toBe(true);
    expect(second.json).toMatchObject({ code: 'rate_limited', limit: 'VERSIONS_PER_USER_HOUR', value: 2 });
    expect(Number(second.json.retry_after_seconds)).toBeGreaterThan(3000);
    const live = await withDb((c) => c.query(`SELECT count(*)::int AS n FROM apps WHERE workspace_id = $1 AND deleted_at IS NULL`, [ws.id]));
    expect(live.rows[0].n).toBe(1);
  } finally {
    await setFakePlan(ws.id, null);
    await mcp.client.close();
  }
});
