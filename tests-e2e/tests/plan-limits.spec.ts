import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';
import { personalWorkspaceOf, withDb } from './helpers/seed';

/**
 * NSO-329: APPS_MAX_PER_WORKSPACE over MCP against the local compose stack.
 * The dev stack does not set the variable and runs without a limits provider,
 * so the limit is the production default, 50. A fresh user's personal
 * workspace is filled up to 49 live apps straight in SQL (plus one soft-deleted
 * app, which must not count); create_app then makes the 50th, refuses the
 * 51st with `limit_exceeded` naming the limit, and makes room again once an
 * app is deleted. The per-workspace provider override and DOMAINS_MAX_PER_APP=0
 * need a provider / env the dev stack cannot switch per test — they are
 * covered by the unit tests (@drobek/modules limits, @drobek/mcp create_app,
 * @drobek/domains addDomain).
 */

const APPS_MAX_PER_WORKSPACE = 50;

function slugBase(): string {
  return `e2e-lim-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
}

test('create_app stops at APPS_MAX_PER_WORKSPACE; deleted apps do not count @local', async ({ page, request }) => {
  skipUnlessLocal();
  test.setTimeout(120_000);
  const mcp = await mcpClient(page, request, { tag: 'plan-limit' });
  const ws = await personalWorkspaceOf(mcp.email);
  const base = slugBase();

  await withDb(async (c) => {
    // One soft-deleted app (holds its slug, not a place in the limit)…
    await c.query(
      `INSERT INTO apps (id, workspace_id, slug, deleted_at) VALUES ($1, $2, $3, now())`,
      [`app${randomBytes(12).toString('hex')}`, ws.id, `${base}-gone~deleted-${randomBytes(3).toString('hex')}`]
    );
    // …and 49 live ones.
    for (let i = 0; i < APPS_MAX_PER_WORKSPACE - 1; i++) {
      await c.query(`INSERT INTO apps (id, workspace_id, slug) VALUES ($1, $2, $3)`, [
        `app${randomBytes(12).toString('hex')}`,
        ws.id,
        `${base}-${i}`,
      ]);
    }
  });

  try {
    const last = await callTool(mcp.client, 'create_app', { name: 'Fiftieth app', workspace: mcp.workspace, template: 'html' });
    expect(last.isError, JSON.stringify(last.json)).toBe(false);

    const over = await callTool(mcp.client, 'create_app', { name: 'One too many', workspace: mcp.workspace, template: 'html' });
    expect(over.isError).toBe(true);
    expect(over.json.code).toBe('limit_exceeded');
    expect(over.json.limit).toBe('APPS_MAX_PER_WORKSPACE');
    expect(over.json.value).toBe(APPS_MAX_PER_WORKSPACE);
    expect(String(over.json.message)).toContain('APPS_MAX_PER_WORKSPACE');
    expect(String(over.json.hint)).toContain('APPS_MAX_PER_WORKSPACE');

    const live = await withDb((c) =>
      c.query(`SELECT count(*)::int AS n FROM apps WHERE workspace_id = $1 AND deleted_at IS NULL`, [ws.id])
    );
    expect(live.rows[0].n).toBe(APPS_MAX_PER_WORKSPACE);

    // Deleting an app makes room again.
    await withDb((c) => c.query(`UPDATE apps SET deleted_at = now() WHERE workspace_id = $1 AND slug = $2`, [ws.id, `${base}-0`]));
    const again = await callTool(mcp.client, 'create_app', { name: 'Room again', workspace: mcp.workspace, template: 'html' });
    expect(again.isError, JSON.stringify(again.json)).toBe(false);
  } finally {
    await mcp.client.close();
  }
});
