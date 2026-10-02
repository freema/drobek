import { expect, test } from '@playwright/test';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';
import { withDb } from './helpers/seed';

/**
 * DB_LOCK_TIMEOUT_MS against the local compose stack (default 10 s): while
 * another session holds the app's row lock, write_files waits for it at most
 * the lock timeout and answers `busy` with `reason: "database_timeout"` and
 * the catalogue hint — never the driver's message. Nothing was stored, and
 * once the lock is gone the same write goes through.
 */
test('a write blocked past DB_LOCK_TIMEOUT_MS answers busy (database_timeout); the next one works @local', async ({ page, request }) => {
  skipUnlessLocal();
  test.setTimeout(120_000);
  const mcp = await mcpClient(page, request, { tag: 'db-lock-timeout' });
  try {
    const created = await callTool(mcp.client, 'create_app', { name: 'Locked row', workspace: mcp.workspace, template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const appId = String(created.json.app_id);
    const write = () =>
      callTool(mcp.client, 'write_files', {
        app_id: appId,
        files: [{ path: 'index.html', content: '<!doctype html><title>Locked row</title><p>Second</p>' }],
        reasoning: 'Second version',
      });

    const started = Date.now();
    const blocked = await withDb(async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT id FROM apps WHERE id = $1 FOR UPDATE', [appId]);
      try {
        return await write();
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.json).toMatchObject({ code: 'busy', reason: 'database_timeout' });
    expect(String(blocked.json.hint)).toContain('database_timeout');
    expect(blocked.text).not.toMatch(/canceling statement|Failed query|lock_not_available|55P03/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
    expect((await callTool(mcp.client, 'get_app', { app_id: appId })).json.latest_version).toBe(1);

    const after = await write();
    expect(after.isError, after.text).toBe(false);
    expect(after.json.version).toBe(2);
  } finally {
    await mcp.client.close();
  }
});
