import { expect, test } from '@playwright/test';
import { skipUnlessLocal } from './helpers/auth';
import { setFakePlan } from './helpers/limits';
import { callTool, mcpClient } from './helpers/mcp';
import { personalWorkspaceOf, withDb } from './helpers/seed';

/**
 * The version history's limits against the local compose stack. The env
 * defaults (200 versions per app, 1 GiB per workspace) are too big to reach
 * in a spec, so the fake limits provider (proxy-echo, helpers/limits.ts) sets
 * a small plan for the test user's personal workspace.
 *  - APP_VERSIONS_KEEP: 2 → get_app's `version_retention`, the briefing and
 *    the dashboard's version history state it. The retention job runs hourly
 *    in the server (its rules are unit-tested in @drobek/apps); the spec
 *    deletes version 1 in SQL as the job would, then read_file and
 *    restore_version of it answer `not_found` saying it is no longer stored,
 *    and its Files page is a 404.
 *  - WORKSPACE_SOURCE_QUOTA → a write whose new bytes do not fit answers
 *    `limit_exceeded` naming the limit with the catalogue hint and stores
 *    nothing; a restore (no new bytes) still works; create_app in a full
 *    workspace is refused before an app exists.
 */

test('APP_VERSIONS_KEEP: get_app and the dashboard state what is kept; a deleted version answers not_found @local', async ({ page, request }) => {
  skipUnlessLocal();
  test.setTimeout(120_000);
  const mcp = await mcpClient(page, request, { tag: 'version-keep' });
  const ws = await personalWorkspaceOf(mcp.email);
  await setFakePlan(ws.id, { APP_VERSIONS_KEEP: 2 });
  try {
    const created = await callTool(mcp.client, 'create_app', { name: 'Long history', workspace: mcp.workspace, template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const appId = String(created.json.app_id);
    const slug = String(created.json.slug);
    expect(String(created.json.briefing)).toContain('an app keeps its newest 2 versions');
    for (const i of [2, 3]) {
      const w = await callTool(mcp.client, 'write_files', {
        app_id: appId,
        files: [{ path: 'index.html', content: `<!doctype html><title>History ${i}</title><p>${i}</p>` }],
        reasoning: `Write ${i}`,
      });
      expect(w.json.version).toBe(i);
    }
    expect((await callTool(mcp.client, 'get_app', { app_id: appId })).json.version_retention).toEqual({
      keep_newest: 2,
      stored: 3,
      oldest_version: 1,
    });

    const base = `/workspaces/${mcp.workspace}/apps/${slug}`;
    await page.goto(base);
    const note = page.getByTestId('version-retention');
    await expect(note).toHaveAttribute('data-keep', '2');
    await expect(note).toContainText('drobek keeps the newest 2 versions of this app');
    await expect(note).toContainText('3 versions are stored now, the oldest is v1');

    // What the hourly retention does to version 1 (older than the newest 2, not published).
    await withDb((c) => c.query(`DELETE FROM app_versions WHERE app_id = $1 AND number = 1`, [appId]));

    const read = await callTool(mcp.client, 'read_file', { app_id: appId, path: 'index.html', version: 1 });
    expect(read.isError).toBe(true);
    expect(read.json.code).toBe('not_found');
    expect(String(read.json.message)).toBe(
      "Version 1 is no longer stored: the history retention or a member's clean-up deleted it. An app keeps its newest 2 versions, the published one, the kept ones and those kept for a rollback; the oldest version still stored is 2."
    );
    expect(String(read.json.hint)).toContain('a version the retention deleted cannot be brought back');
    const restored = await callTool(mcp.client, 'restore_version', { app_id: appId, version: 1 });
    expect(restored.isError).toBe(true);
    expect(restored.json.code).toBe('not_found');
    expect(String(restored.json.message)).toContain('Version 1 is no longer stored');
    expect((await callTool(mcp.client, 'get_app', { app_id: appId })).json.version_retention).toEqual({
      keep_newest: 2,
      stored: 2,
      oldest_version: 2,
    });

    await page.goto(base);
    await expect(page.getByTestId('version-retention')).toContainText('2 versions are stored now, the oldest is v2');
    await expect(page.locator('[data-testid="version-row"][data-version="1"]')).toHaveCount(0);
    const files = await page.request.get(`${base}/files?version=1`);
    expect(files.status()).toBe(404);
  } finally {
    await setFakePlan(ws.id, null);
    await mcp.client.close();
  }
});

test('WORKSPACE_SOURCE_QUOTA: a write past the plan answers limit_exceeded and stores nothing @local', async ({ page, request }) => {
  skipUnlessLocal();
  test.setTimeout(120_000);
  const mcp = await mcpClient(page, request, { tag: 'source-quota' });
  const ws = await personalWorkspaceOf(mcp.email);
  await setFakePlan(ws.id, { WORKSPACE_SOURCE_QUOTA: 20_000 });
  try {
    const created = await callTool(mcp.client, 'create_app', { name: 'Small storage', workspace: mcp.workspace, template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const appId = String(created.json.app_id);
    expect(String(created.json.briefing)).toContain('may store 20 KiB of unique files');

    const big = await callTool(mcp.client, 'write_files', {
      app_id: appId,
      files: [{ path: 'index.html', content: `<!doctype html><title>Big</title><p>${'x'.repeat(30_000)}</p>` }],
      reasoning: 'Too big for the plan',
    });
    expect(big.isError).toBe(true);
    expect(big.json).toMatchObject({ code: 'limit_exceeded', limit: 'WORKSPACE_SOURCE_QUOTA', value: 20_000 });
    expect(Number(big.json.used_bytes)).toBeGreaterThan(0);
    expect(String(big.json.message)).toContain('nothing was stored');
    expect(String(big.json.hint)).toContain('WORKSPACE_SOURCE_QUOTA');
    expect((await callTool(mcp.client, 'get_app', { app_id: appId })).json.latest_version).toBe(1);

    const small = await callTool(mcp.client, 'write_files', {
      app_id: appId,
      files: [{ path: 'index.html', content: '<!doctype html><title>Small</title>' }],
      reasoning: 'Fits',
    });
    expect(small.isError, small.text).toBe(false);
    expect(small.json.version).toBe(2);
    // A restore adds no bytes: it fits whatever the quota.
    const restored = await callTool(mcp.client, 'restore_version', { app_id: appId, version: 1 });
    expect(restored.isError, restored.text).toBe(false);
    expect(restored.json.version).toBe(3);

    await setFakePlan(ws.id, { WORKSPACE_SOURCE_QUOTA: 10 });
    const refused = await callTool(mcp.client, 'create_app', { name: 'No room', workspace: mcp.workspace, template: 'html' });
    expect(refused.isError).toBe(true);
    expect(refused.json).toMatchObject({ code: 'limit_exceeded', limit: 'WORKSPACE_SOURCE_QUOTA', value: 10 });
    const live = await withDb((c) => c.query(`SELECT count(*)::int AS n FROM apps WHERE workspace_id = $1 AND deleted_at IS NULL`, [ws.id]));
    expect(live.rows[0].n).toBe(1);
  } finally {
    await setFakePlan(ws.id, null);
    await mcp.client.close();
  }
});
