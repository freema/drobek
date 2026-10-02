import { expect, test } from '@playwright/test';
import { hostRequest, previewHost } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient, type McpClient } from './helpers/mcp';
import { addMembership, personalWorkspaceOf, seedRecords, userIdByEmail, withDb } from './helpers/seed';

/**
 * The data write tools over MCP change an app's stored records through the
 * data module, like the dashboard's Data tab (dev: DATA_MAX_DOCS_PER_APP=5):
 *   - create_records stores a batch all or nothing: a record the schema
 *     refuses names its index, a batch past the quota answers limit_exceeded,
 *     and the app's own REST route serves what was stored;
 *   - update_record merges by default, `replace: true` sets exactly the
 *     given fields; delete_record deletes once;
 *   - a viewer is forbidden from every one of them;
 *   - purge_orphan_records and delete_collection ask first
 *     (`user_confirmation_required`), then delete — the collection's route
 *     answers 404 afterwards;
 *   - every change is an audit row with the agent as the actor;
 *   - a taken-down app answers app_locked_by_admin.
 */

const TODO_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: { title: { type: 'string', maxLength: 200 }, done: { type: 'boolean' } },
};

type Rec = Record<string, unknown> & { _id: string };

async function auditRows(slug: string): Promise<{ action: string; actor_kind: string }[]> {
  return withDb(async (c) => {
    const res = await c.query(`SELECT action, actor_kind FROM audit_log WHERE target = $1 AND action LIKE 'data.%' ORDER BY created_at, id`, [slug]);
    return res.rows;
  });
}

async function records(m: McpClient, appId: string): Promise<Rec[]> {
  const r = await callTool(m.client, 'query_data', { app_id: appId, collection: 'todos', sort: '_created_at', dir: 'asc' });
  expect(r.isError, r.text).toBe(false);
  return r.json.records as Rec[];
}

test('MCP data writes: create, update, delete, purge orphans and delete a collection — validated, confirmed and audited like the Data tab @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();
  const a = await mcpClient(page, request, { tag: 'data-writes-a' });
  const ctxB = await browser.newContext();
  let b: McpClient | undefined;
  try {
    b = await mcpClient(await ctxB.newPage(), request, { tag: 'data-writes-b' });
    const ws = await personalWorkspaceOf(a.email);
    await addMembership(await userIdByEmail(b.email), ws.id, 'viewer');

    const created = await callTool(a.client, 'create_app', { name: 'Data writes E2E', template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const appId = created.json.app_id as string;
    const slug = created.json.slug as string;
    const cfg = await callTool(a.client, 'configure_module', {
      app_id: appId,
      module: 'data',
      config: { collections: { todos: { schema: TODO_SCHEMA, rules: { read: 'public' } } } },
    });
    expect(cfg.isError, cfg.text).toBe(false);
    expect(cfg.json.applied).toBe(true);

    // ── create_records: all or nothing, the quota as a whole batch. ─────────
    const added = await callTool(a.client, 'create_records', { app_id: appId, collection: 'todos', records: [{ title: 'Milk' }, { title: 'Bread', done: false }] });
    expect(added.isError, added.text).toBe(false);
    expect(added.json).toMatchObject({ app_id: appId, collection: 'todos', created: 2 });
    const ids = added.json.ids as string[];
    expect(ids).toHaveLength(2);
    const served = await hostRequest(previewHost(slug), '/__drobek/v1/data/todos');
    expect(served.status, served.body).toBe(200);
    expect((JSON.parse(served.body) as { records: Rec[] }).records.map((r) => r.title).sort()).toEqual(['Bread', 'Milk']);

    const refused = await callTool(a.client, 'create_records', { app_id: appId, collection: 'todos', records: [{ title: 'ok' }, { done: 'yes' }] });
    expect(refused.json).toMatchObject({ code: 'invalid_params', index: 1, hint: "skill_info('data')" });
    expect((refused.json.issues as unknown[]).length).toBeGreaterThan(0);
    const over = await callTool(a.client, 'create_records', { app_id: appId, collection: 'todos', records: [{ title: '1' }, { title: '2' }, { title: '3' }, { title: '4' }] });
    expect(over.json).toMatchObject({ code: 'limit_exceeded', limit: 'DATA_MAX_DOCS_PER_APP', value: 5 });
    const unknown = await callTool(a.client, 'create_records', { app_id: appId, collection: 'notes', records: [{ title: 'x' }] });
    expect(unknown.json).toMatchObject({ code: 'not_found', available: ['todos'] });
    expect((await records(a, appId)).map((r) => r._id)).toEqual(ids);

    // ── update_record merges, replace sets; delete_record once. ─────────────
    const merged = await callTool(a.client, 'update_record', { app_id: appId, collection: 'todos', id: ids[1], fields: { done: true } });
    expect(merged.isError, merged.text).toBe(false);
    expect(merged.json).toMatchObject({ id: ids[1], replaced: false });
    expect((await records(a, appId))[1]).toMatchObject({ title: 'Bread', done: true });
    const replaced = await callTool(a.client, 'update_record', { app_id: appId, collection: 'todos', id: ids[1], fields: { title: 'Rye bread' }, replace: true });
    expect(replaced.isError, replaced.text).toBe(false);
    const after = (await records(a, appId))[1];
    expect(after).toMatchObject({ title: 'Rye bread' });
    expect(after).not.toHaveProperty('done');
    const invalid = await callTool(a.client, 'update_record', { app_id: appId, collection: 'todos', id: ids[1], fields: { done: 'yes' } });
    expect(invalid.json).toMatchObject({ code: 'invalid_params' });

    const deleted = await callTool(a.client, 'delete_record', { app_id: appId, collection: 'todos', id: ids[0] });
    expect(deleted.json).toEqual({ app_id: appId, collection: 'todos', id: ids[0], deleted: true });
    expect((await callTool(a.client, 'delete_record', { app_id: appId, collection: 'todos', id: ids[0] })).json).toMatchObject({ code: 'not_found' });

    // ── A viewer may call none of them; nothing changes. ─────────────────────
    for (const [name, args] of [
      ['create_records', { collection: 'todos', records: [{ title: 'viewer' }] }],
      ['update_record', { collection: 'todos', id: ids[1], fields: { title: 'viewer' } }],
      ['delete_record', { collection: 'todos', id: ids[1] }],
      ['delete_collection', { collection: 'todos', user_confirmed: true }],
      ['purge_orphan_records', { user_confirmed: true }],
    ] as const) {
      const r = await callTool(b.client, name, { app_id: appId, ...args });
      expect(r.isError, name).toBe(true);
      expect(r.json.code, name).toBe('forbidden');
    }
    expect((await records(a, appId)).map((r) => r.title)).toEqual(['Rye bread']);

    // ── Orphan records: listed in the question, purged after the yes. ────────
    await seedRecords(appId, 'old', [{ x: 1 }, { x: 2 }]);
    const askPurge = await callTool(a.client, 'purge_orphan_records', { app_id: appId });
    expect(askPurge.json).toMatchObject({ code: 'user_confirmation_required', orphans: [{ name: 'old', records: 2 }] });
    const purged = await callTool(a.client, 'purge_orphan_records', { app_id: appId, user_confirmed: true });
    expect(purged.isError, purged.text).toBe(false);
    expect(purged.json).toMatchObject({ purged: [{ name: 'old', records: 2 }] });

    // ── delete_collection: asks with the count, then the route is gone. ─────
    const askDrop = await callTool(a.client, 'delete_collection', { app_id: appId, collection: 'todos' });
    expect(askDrop.json).toMatchObject({ code: 'user_confirmation_required', collection: 'todos', records: 1 });
    expect((await records(a, appId))).toHaveLength(1);
    const dropped = await callTool(a.client, 'delete_collection', { app_id: appId, collection: 'todos', user_confirmed: true });
    expect(dropped.isError, dropped.text).toBe(false);
    expect(dropped.json).toMatchObject({ collection: 'todos', deleted_records: 1 });
    expect((await hostRequest(previewHost(slug), '/__drobek/v1/data/todos')).status).toBe(404);
    expect((await callTool(a.client, 'query_data', { app_id: appId, collection: 'todos' })).json).toMatchObject({ code: 'not_found' });

    // ── Every change is audited with the agent as the actor. ─────────────────
    expect(await auditRows(slug)).toEqual([
      { action: 'data.record_create', actor_kind: 'agent' },
      { action: 'data.record_update', actor_kind: 'agent' },
      { action: 'data.record_update', actor_kind: 'agent' },
      { action: 'data.record_delete', actor_kind: 'agent' },
      { action: 'data.collection.purge', actor_kind: 'agent' },
      { action: 'data.collection_delete', actor_kind: 'agent' },
    ]);

    // ── A taken-down app refuses every data write. ───────────────────────────
    await withDb((c) => c.query(`UPDATE apps SET locked_reason = 'spam' WHERE id = $1`, [appId]));
    const locked = await callTool(a.client, 'create_records', { app_id: appId, collection: 'todos', records: [{ title: 'x' }] });
    expect(locked.json).toMatchObject({ code: 'app_locked_by_admin', reason: 'spam' });
  } finally {
    await b?.client.close();
    await a.client.close();
    await ctxB.close();
  }
});
