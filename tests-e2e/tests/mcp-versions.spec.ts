import { expect, test } from '@playwright/test';
import { hostRequest, versionHost } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { setFakePlan } from './helpers/limits';
import { callTool, mcpClient, type McpClient } from './helpers/mcp';
import { addMembership, personalWorkspaceOf, userIdByEmail, withDb } from './helpers/seed';

/**
 * The version history tools over MCP against the local compose stack:
 *   - list_versions pages newest first through `next_before`, each version
 *     flagged `published` / `preview` / `kept`, the pinned ones on every page;
 *     a viewer may list but neither keep nor delete (`forbidden`);
 *   - keep_version keeps a version (get_app shows it) up to
 *     APP_VERSIONS_KEPT_MAX of the workspace's plan (the fake limits provider
 *     sets 1), past it `limit_exceeded`;
 *   - delete_versions answers `user_confirmation_required` with the plan and
 *     its `plan_id` and changes nothing; a yes with another plan_id answers
 *     `plan_changed` and deletes nothing; with `user_confirmed: true` and the
 *     plan's `plan_id` the versions are gone for
 *     good (their version hosts 404, read_file not_found), the protected ones
 *     reported by reason, audited `app.versions.delete` as the agent.
 * The versions are aged past the last hour in SQL, the way time would.
 */

type Version = { number: number; published: boolean; preview: boolean; kept: boolean };

const HTML = (text: string) =>
  `<!doctype html><html><head><title>${text}</title><meta name="description" content="Version ${text}."><link rel="icon" href="data:,"></head><body><h1>${text}</h1></body></html>`;

async function write(m: McpClient, appId: string, text: string) {
  const w = await callTool(m.client, 'write_files', {
    app_id: appId,
    files: [{ path: 'index.html', content: HTML(text) }],
    reasoning: `Versions e2e: ${text}`,
  });
  expect(w.isError, w.text).toBe(false);
  return w.json.version as number;
}

const numbers = (versions: unknown) => (versions as Version[]).map((v) => v.number);

test('MCP version history: list_versions pages, keep_version keeps, delete_versions deletes old versions after the yes @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();
  test.setTimeout(120_000);
  const a = await mcpClient(page, request, { tag: 'versions-a' });
  const ws = await personalWorkspaceOf(a.email);
  const ctxB = await browser.newContext();
  let b: McpClient | undefined;
  try {
    b = await mcpClient(await ctxB.newPage(), request, { tag: 'versions-b' });
    const userA = await userIdByEmail(a.email);
    await addMembership(await userIdByEmail(b.email), ws.id, 'viewer');

    const created = await callTool(a.client, 'create_app', { name: 'Versions E2E', template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const appId = created.json.app_id as string;
    const slug = created.json.slug as string;
    for (const i of [2, 3, 4, 5, 6]) expect(await write(a, appId, `v${i}`)).toBe(i);
    const published = await callTool(a.client, 'publish', { app_id: appId, version: 2 });
    expect(published.isError, published.text).toBe(false);

    // ── list_versions: pages through next_before, any role. ─────────────────
    const first = await callTool(b.client, 'list_versions', { app_id: appId, limit: 2 });
    expect(first.isError, first.text).toBe(false);
    expect(numbers(first.json.versions)).toEqual([6, 5]);
    expect(first.json.next_before).toBe(5);
    expect(numbers(first.json.pinned)).toEqual([6, 2]);
    const second = await callTool(b.client, 'list_versions', { app_id: appId, limit: 2, before: 5 });
    expect(numbers(second.json.versions)).toEqual([4, 3]);
    const last = await callTool(b.client, 'list_versions', { app_id: appId, limit: 2, before: second.json.next_before });
    expect(numbers(last.json.versions)).toEqual([2, 1]);
    expect(last.json.next_before).toBeNull();
    expect((last.json.versions as Version[])[0]).toMatchObject({ number: 2, published: true, preview: false, kept: false });
    const tooMany = await callTool(b.client, 'list_versions', { app_id: appId, limit: 500 });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.json.code).toBe('invalid_params');

    // ── A viewer may neither keep nor delete. ───────────────────────────────
    for (const [name, args] of [
      ['keep_version', { version: 3, kept: true }],
      ['delete_versions', { up_to: 6, plan_id: 'abc', user_confirmed: true }],
    ] as const) {
      const refused = await callTool(b.client, name, { app_id: appId, ...args });
      expect(refused.isError, name).toBe(true);
      expect(refused.json.code, name).toBe('forbidden');
    }

    // ── keep_version, capped by the plan's APP_VERSIONS_KEPT_MAX. ───────────
    await setFakePlan(ws.id, { APP_VERSIONS_KEPT_MAX: 1 });
    const kept = await callTool(a.client, 'keep_version', { app_id: appId, version: 3, kept: true });
    expect(kept.isError, kept.text).toBe(false);
    expect(kept.json).toMatchObject({ app_id: appId, version: 3, kept: true, changed: true });
    const over = await callTool(a.client, 'keep_version', { app_id: appId, version: 4, kept: true });
    expect(over.isError).toBe(true);
    expect(over.json).toMatchObject({ code: 'limit_exceeded', limit: 'APP_VERSIONS_KEPT_MAX', value: 1 });
    const app = await callTool(a.client, 'get_app', { app_id: appId });
    expect((app.json.versions as Version[]).find((v) => v.number === 3)).toMatchObject({ kept: true });
    expect((app.json.versions as Version[]).find((v) => v.number === 6)).toMatchObject({ preview: true });

    // ── delete_versions: the plan first, then gone for good. ────────────────
    await withDb((c) => c.query(`UPDATE app_versions SET created_at = created_at - interval '90 minutes' WHERE app_id = $1`, [appId]));
    expect((await hostRequest(versionHost(slug, 1))).status).toBe(200);
    const ask = await callTool(a.client, 'delete_versions', { app_id: appId, up_to: 6 });
    expect(ask.isError).toBe(true);
    expect(ask.json).toMatchObject({
      code: 'user_confirmation_required',
      delete: ['1', '4-5'],
      count: 3,
      skipped: { published: ['2'], kept: ['3'], preview: ['6'] },
    });
    expect(String(ask.json.message)).toContain('Delete 3 old versions of Versions E2E for good?');
    const planId = String(ask.json.plan_id);
    expect(planId).toMatch(/^[0-9a-f]+$/);
    expect((await hostRequest(versionHost(slug, 1))).status).toBe(200);

    const stale = await callTool(a.client, 'delete_versions', { app_id: appId, up_to: 5, plan_id: planId.split('').reverse().join(''), user_confirmed: true });
    expect(stale.isError).toBe(true);
    expect(stale.json.code).toBe('plan_changed');
    expect((await hostRequest(versionHost(slug, 1))).status).toBe(200);

    const done = await callTool(a.client, 'delete_versions', { app_id: appId, up_to: 6, plan_id: planId, user_confirmed: true });
    expect(done.isError, done.text).toBe(false);
    expect(done.json).toMatchObject({ deleted: ['1', '4-5'], count: 3, skipped: { published: ['2'], kept: ['3'], preview: ['6'] } });
    expect(numbers((await callTool(a.client, 'list_versions', { app_id: appId })).json.versions)).toEqual([6, 3, 2]);
    expect((await hostRequest(versionHost(slug, 1))).status).toBe(404);
    expect((await hostRequest(versionHost(slug, 2))).status).toBe(200);
    const gone = await callTool(a.client, 'read_file', { app_id: appId, path: 'index.html', version: 4 });
    expect(gone.isError).toBe(true);
    expect(gone.json.code).toBe('not_found');
    expect(String(gone.json.message)).toContain('Version 4 is no longer stored');

    const rows = await withDb(async (c) =>
      (await c.query(`SELECT action, actor_kind, actor_user_id, meta FROM audit_log WHERE target = $1 AND action IN ('app.version.keep', 'app.version.unkeep', 'app.versions.delete') ORDER BY created_at, id`, [slug])).rows
    );
    expect(rows.map((r) => [r.action, r.actor_kind, r.actor_user_id])).toEqual([
      ['app.version.keep', 'agent', userA],
      ['app.versions.delete', 'agent', userA],
    ]);
    expect(rows[1].meta).toMatchObject({ appId, count: 3, from: 1, to: 5, failedOnly: false });
  } finally {
    await setFakePlan(ws.id, null);
    await a.transport.close();
    await b?.transport.close();
    await ctxB.close();
  }
});
