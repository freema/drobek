import { expect, test } from '@playwright/test';
import { DASHBOARD_ORIGIN, hostRequest, prodHost, previewHost, urlOf, versionHost } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient, type McpClient } from './helpers/mcp';
import { addMembership, personalWorkspaceOf, userIdByEmail, withDb } from './helpers/seed';

/**
 * The app lifecycle tools over MCP do what the dashboard's app page and
 * Settings tab do, with the same audit rows (as the agent):
 *   - a viewer gets `forbidden` from every one of them, nothing changes;
 *   - set_frame_ancestors: an invalid list is refused, a valid one reaches the
 *     apps host's CSP, null restores the default;
 *   - set_visibility: `password` without a stored password answers
 *     `password_not_set` with the Settings link (the password is set there,
 *     in the browser, never over MCP); `public` on a protected app needs
 *     `user_confirmed: true` and then opens every host again;
 *   - release_lease frees only the caller's own lease: another member's agent
 *     writes at once afterwards, while someone else's lease stays (`app_locked`);
 *   - unpublish and delete_app need `user_confirmed: true`; then production
 *     answers 404 (the preview keeps serving), and after the delete every host
 *     answers 404 and MCP no longer knows the app.
 */

async function auditRows(slug: string): Promise<{ action: string; actor_kind: string; actor_user_id: string | null }[]> {
  return withDb(async (c) => {
    const res = await c.query(
      `SELECT action, actor_kind, actor_user_id FROM audit_log WHERE target = $1 ORDER BY created_at, id`,
      [slug]
    );
    return res.rows;
  });
}

const HTML = (text: string) =>
  `<!doctype html><html><head><title>${text}</title><meta name="description" content="Version ${text}."><link rel="icon" href="data:,"></head><body><h1>${text}</h1></body></html>`;

async function write(m: McpClient, appId: string, text: string) {
  return callTool(m.client, 'write_files', {
    app_id: appId,
    files: [{ path: 'index.html', content: HTML(text) }],
    reasoning: `Lifecycle e2e: ${text}`,
  });
}

test('MCP app lifecycle: embedding, visibility, release_lease, unpublish and delete — confirmed and audited like the dashboard @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();
  const a = await mcpClient(page, request, { tag: 'lifecycle-a' });
  const ctxB = await browser.newContext();
  let b: McpClient | undefined;
  try {
    b = await mcpClient(await ctxB.newPage(), request, { tag: 'lifecycle-b' });
    const userA = await userIdByEmail(a.email);
    const userB = await userIdByEmail(b.email);
    const ws = await personalWorkspaceOf(a.email);
    await addMembership(userB, ws.id, 'viewer');

    const created = await callTool(a.client, 'create_app', { name: 'Lifecycle E2E', template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const appId = created.json.app_id as string;
    const slug = created.json.slug as string;
    const published = await callTool(a.client, 'publish', { app_id: appId });
    expect(published.isError, published.text).toBe(false);
    expect((await hostRequest(prodHost(slug))).status).toBe(200);

    // ── A viewer may call none of them; nothing changes. ─────────────────────
    for (const [name, args] of [
      ['unpublish', { user_confirmed: true }],
      ['set_visibility', { visibility: 'public', user_confirmed: true }],
      ['set_frame_ancestors', { frame_ancestors: 'https://viewer.example.com' }],
      ['release_lease', {}],
      ['delete_app', { user_confirmed: true }],
    ] as const) {
      const refused = await callTool(b.client, name, { app_id: appId, ...args });
      expect(refused.isError, name).toBe(true);
      expect(refused.json.code, name).toBe('forbidden');
    }
    expect((await hostRequest(prodHost(slug))).status).toBe(200);

    // ── set_frame_ancestors → the apps host's CSP. ───────────────────────────
    const invalid = await callTool(a.client, 'set_frame_ancestors', {
      app_id: appId,
      frame_ancestors: 'https://x.example.com; script-src *',
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.json.code).toBe('invalid_params');
    const framed = await callTool(a.client, 'set_frame_ancestors', {
      app_id: appId,
      frame_ancestors: 'https://intranet.example.com https://intranet.example.com',
    });
    expect(framed.isError, framed.text).toBe(false);
    expect(framed.json).toMatchObject({ app_id: appId, frame_ancestors: 'https://intranet.example.com', previous: null, changed: true });
    expect(String((await hostRequest(prodHost(slug))).headers['content-security-policy'])).toContain(
      `frame-ancestors https://intranet.example.com ${DASHBOARD_ORIGIN};`
    );
    const again = await callTool(a.client, 'set_frame_ancestors', { app_id: appId, frame_ancestors: 'https://intranet.example.com' });
    expect(again.json).toMatchObject({ changed: false });
    expect((await callTool(a.client, 'get_app', { app_id: appId })).json).toMatchObject({
      visibility: 'public',
      frame_ancestors: 'https://intranet.example.com',
    });
    const reset = await callTool(a.client, 'set_frame_ancestors', { app_id: appId, frame_ancestors: null });
    expect(reset.json).toMatchObject({ frame_ancestors: null, previous: 'https://intranet.example.com', changed: true });
    expect(String((await hostRequest(prodHost(slug))).headers['content-security-policy'])).toContain(
      `frame-ancestors ${DASHBOARD_ORIGIN};`
    );

    // ── set_visibility: the password only ever comes from the dashboard. ─────
    const noPassword = await callTool(a.client, 'set_visibility', { app_id: appId, visibility: 'password' });
    expect(noPassword.isError).toBe(true);
    expect(noPassword.json.code).toBe('password_not_set');
    const settingsUrl = new URL(String(noPassword.json.settings_url));
    expect(settingsUrl.pathname).toBe(`/workspaces/${a.workspace}/apps/${slug}/settings`);
    expect((await hostRequest(prodHost(slug))).status).toBe(200);

    await page.goto(settingsUrl.pathname);
    await page.getByTestId('visibility-password').check();
    await page.getByTestId('password-input').fill('correct horse');
    await page.getByTestId('visibility-save').click();
    await expect(page.getByTestId('settings-visibility-current')).toHaveText('password');
    expect((await hostRequest(prodHost(slug))).status).toBe(401);

    const kept = await callTool(a.client, 'set_visibility', { app_id: appId, visibility: 'password' });
    expect(kept.isError, kept.text).toBe(false);
    expect(kept.json).toMatchObject({ visibility: 'password', changed: false });
    expect(kept.text).not.toContain('correct horse');

    const ask = await callTool(a.client, 'set_visibility', { app_id: appId, visibility: 'public' });
    expect(ask.isError).toBe(true);
    expect(ask.json.code).toBe('user_confirmation_required');
    expect(String(ask.json.message)).toContain('Ask the user');
    expect((await hostRequest(prodHost(slug))).status).toBe(401);
    const opened = await callTool(a.client, 'set_visibility', { app_id: appId, visibility: 'public', user_confirmed: true });
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.json).toMatchObject({ visibility: 'public', changed: true });
    expect((await hostRequest(prodHost(slug))).status).toBe(200);
    expect((await hostRequest(previewHost(slug))).status).toBe(200);

    // ── release_lease: only one's own lease. ─────────────────────────────────
    await withDb((c) =>
      c.query(`UPDATE memberships SET role = 'editor' WHERE user_id = $1 AND workspace_id = $2`, [userB, ws.id])
    );
    expect((await write(a, appId, 'by A')).isError).toBe(false);
    expect((await write(b, appId, 'by B')).json.code).toBe('app_locked');
    const notMine = await callTool(b.client, 'release_lease', { app_id: appId });
    expect(notMine.isError).toBe(true);
    expect(notMine.json.code).toBe('app_locked');
    expect(String(notMine.json.message)).toContain('only your own lease');
    expect((await callTool(a.client, 'get_app', { app_id: appId })).json.locked_by).toBeTruthy();

    const freed = await callTool(a.client, 'release_lease', { app_id: appId });
    expect(freed.isError, freed.text).toBe(false);
    expect(freed.json).toMatchObject({ app_id: appId, released: true });
    expect((await callTool(a.client, 'get_app', { app_id: appId })).json.locked_by).toBeUndefined();
    const bWrites = await write(b, appId, 'by B');
    expect(bWrites.isError, bWrites.text).toBe(false);
    expect((await callTool(b.client, 'release_lease', { app_id: appId })).json).toMatchObject({ released: true });
    expect((await callTool(b.client, 'release_lease', { app_id: appId })).json).toMatchObject({ released: false });

    // ── unpublish: production goes offline, the preview keeps serving. ───────
    const askOff = await callTool(a.client, 'unpublish', { app_id: appId });
    expect(askOff.isError).toBe(true);
    expect(askOff.json).toMatchObject({ code: 'user_confirmation_required', published_url: urlOf(prodHost(slug)) });
    expect((await hostRequest(prodHost(slug))).status).toBe(200);
    const off = await callTool(a.client, 'unpublish', { app_id: appId, user_confirmed: true });
    expect(off.isError, off.text).toBe(false);
    expect(off.json).toMatchObject({ app_id: appId, unpublished_version: 1 });
    expect((await hostRequest(prodHost(slug))).status).toBe(404);
    expect((await hostRequest(previewHost(slug))).status).toBe(200);
    const twice = await callTool(a.client, 'unpublish', { app_id: appId, user_confirmed: true });
    expect(twice.json.code).toBe('not_published');

    // ── delete_app: every host 404, MCP no longer knows the app. ─────────────
    const askDelete = await callTool(a.client, 'delete_app', { app_id: appId });
    expect(askDelete.isError).toBe(true);
    expect(askDelete.json).toMatchObject({ code: 'user_confirmation_required', slug, published: false });
    expect((await hostRequest(previewHost(slug))).status).toBe(200);
    const deleted = await callTool(a.client, 'delete_app', { app_id: appId, user_confirmed: true });
    expect(deleted.isError, deleted.text).toBe(false);
    expect(deleted.json).toMatchObject({ deleted: slug, app_id: appId });
    expect(Date.parse(deleted.json.slug_released_at as string)).toBeGreaterThan(Date.now());
    expect((await hostRequest(prodHost(slug))).status).toBe(404);
    expect((await hostRequest(previewHost(slug))).status).toBe(404);
    expect((await hostRequest(versionHost(slug, 1))).status).toBe(404);
    expect((await callTool(a.client, 'get_app', { app_id: appId })).json.code).toBe('not_found');
    const listed = await callTool(a.client, 'list_apps', {});
    expect((listed.json.apps as { app_id: string }[]).map((x) => x.app_id)).not.toContain(appId);

    // The same audit rows as the dashboard writes, as the agent (the password: the user).
    const watched = new Set([
      'app.publish',
      'app.frame_ancestors.change',
      'app.visibility.password',
      'app.visibility.public',
      'app.lock.release',
      'app.unpublish',
      'app.delete',
    ]);
    const rows = (await auditRows(slug)).filter((r) => watched.has(r.action));
    expect(rows.map((r) => [r.action, r.actor_kind, r.actor_user_id])).toEqual([
      ['app.publish', 'agent', userA],
      ['app.frame_ancestors.change', 'agent', userA],
      ['app.frame_ancestors.change', 'agent', userA],
      ['app.visibility.password', 'user', userA],
      ['app.visibility.public', 'agent', userA],
      ['app.lock.release', 'agent', userA],
      ['app.lock.release', 'agent', userB],
      ['app.unpublish', 'agent', userA],
      ['app.delete', 'agent', userA],
    ]);
  } finally {
    await a.transport.close();
    await b?.transport.close();
    await ctxB.close();
  }
});
