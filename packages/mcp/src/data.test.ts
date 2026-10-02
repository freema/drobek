/**
 * The data write tools over a real MCP client on a real (PGlite) database:
 * create_records, update_record, delete_record, delete_collection and
 * purge_orphan_records go through the module runtime's records binding (the
 * dashboard's), so the module's validation and quotas answer — mapped to the
 * tool errors the agent acts on. editor+ (a viewer forbidden, a non-member
 * not_found), a taken-down app app_locked_by_admin, the destructive two only
 * with `user_confirmed: true`, every change audited as the agent.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { takedownApp } from '@drobek/apps';
import { CREATE_RECORDS_MAX } from '@drobek/agent-dx';
import { noopLogger } from '@drobek/core';
import { apps, auditLog, memberships, moduleConfigs, users, workspaces } from '@drobek/db';
import { defineModule, loadModuleRuntime, memoryRateLimiter, z, type ModuleRuntime } from '@drobek/modules';
import type { ToolPrincipal } from './context.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps, type TestDeps } from './test/harness.js';
import { STORE_DATA, STORE_MAX, greet, store } from './test/modules.js';

let db: TestDb;
let close: () => Promise<void>;
const P = {} as Record<'alice' | 'ed' | 'vera' | 'eve', ToolPrincipal>;
let wsId: string;
let rootId: string;
let deps: TestDeps;
let rt: ModuleRuntime;

const RUNTIME_ENV = { APPS_DOMAIN: 'drobek.app', PUBLIC_APP_URL: 'https://dash.drobek.test', DROBEK_MIGRATE_ON_START: '0', DROBEK_MASTER_KEY: '22'.repeat(32) };
const RUNTIME_DEPS = { rateLimit: memoryRateLimiter(), principal: async () => ({ kind: 'anon' as const }), email: { send: async () => {} } };

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const mk = async (email: string) => (await db.insert(users).values({ email }).returning())[0].id;
  const ids = {
    alice: await mk('alice@example.test'),
    ed: await mk('ed@example.test'),
    vera: await mk('vera@example.test'),
    eve: await mk('eve@example.test'),
  };
  rootId = await mk('root@example.test');
  const [team] = await db.insert(workspaces).values({ kind: 'team', slug: 'team-d', name: 'Data' }).returning();
  const [other] = await db.insert(workspaces).values({ kind: 'personal', slug: 'eve-d', name: 'Eve' }).returning();
  wsId = team.id;
  await db.insert(memberships).values([
    { userId: ids.alice, workspaceId: team.id, role: 'workspace-admin' },
    { userId: ids.ed, workspaceId: team.id, role: 'editor' },
    { userId: ids.vera, workspaceId: team.id, role: 'viewer' },
    { userId: ids.eve, workspaceId: other.id, role: 'workspace-admin' },
  ]);
  for (const k of Object.keys(ids) as (keyof typeof ids)[]) P[k] = { userId: ids[k], email: `${k}@example.test`, superAdmin: false };
  rt = await loadModuleRuntime({ env: RUNTIME_ENV, log: noopLogger, modules: [greet, store], deps: RUNTIME_DEPS });
});
afterAll(async () => close());
beforeEach(() => {
  deps = { ...testDeps(), modules: async () => rt };
  STORE_DATA.clear();
});

let n = 0;
async function newApp(collections: string[] = ['todos']): Promise<{ id: string; slug: string }> {
  n += 1;
  const [a] = await db.insert(apps).values({ workspaceId: wsId, slug: `data-${n}`, name: `Data ${n}` }).returning();
  await rt.configure({
    app: { id: a.id, slug: a.slug, workspaceId: wsId, workspaceSlug: 'team-d' },
    module: 'store',
    patch: { collections },
    actorUserId: P.alice.userId,
    surface: 'web',
  });
  return { id: a.id, slug: a.slug };
}

type Conn = Awaited<ReturnType<typeof connect>>;

async function as<T>(who: keyof typeof P, fn: (c: Conn) => Promise<T>, d: TestDeps = deps): Promise<T> {
  const c = await connect(P[who], d);
  try {
    return await fn(c);
  } finally {
    await c.close();
  }
}

function errorOf(r: { isError: boolean; text: string }): Record<string, unknown> {
  expect(r.isError, r.text).toBe(true);
  return JSON.parse(r.text) as Record<string, unknown>;
}

function ok(r: { isError: boolean; text: string; body: Record<string, unknown> }): Record<string, unknown> {
  expect(r.isError, r.text).toBe(false);
  return r.body;
}

async function audits(slug: string): Promise<{ action: string; actorKind: string; actorUserId: string | null; meta: unknown }[]> {
  const rows = await db.select().from(auditLog).where(and(eq(auditLog.workspaceId, wsId), eq(auditLog.target, slug))).orderBy(auditLog.createdAt);
  return rows
    .filter((r) => r.action.startsWith('data.'))
    .map((r) => ({ action: r.action, actorKind: r.actorKind, actorUserId: r.actorUserId, meta: r.meta }));
}

const todos = (appId: string) => STORE_DATA.get(appId)?.todos ?? [];

describe('create_records', () => {
  it('stores the batch through the records module and audits it as the agent', async () => {
    const app = await newApp();
    await as('ed', async (c) => {
      const out = ok(await c.call('create_records', { app_id: app.id, collection: 'todos', records: [{ title: 'Milk' }, { title: 'Bread' }] }));
      expect(out).toMatchObject({ app_id: app.id, collection: 'todos', created: 2 });
      expect(out.ids).toEqual(todos(app.id).map((r) => r._id));
      expect(String(out.note)).toContain('no _owner');
      expect(todos(app.id).map((r) => r.title)).toEqual(['Milk', 'Bread']);
    });
    expect(await audits(app.slug)).toEqual([
      { action: 'data.record_create', actorKind: 'agent', actorUserId: P.ed.userId, meta: { module: 'store', collection: 'todos', records: 2 } },
    ]);
  });

  it('all or nothing: a record the module refuses names its index and issues, nothing is stored', async () => {
    const app = await newApp();
    await as('ed', async (c) => {
      const e = errorOf(await c.call('create_records', { app_id: app.id, collection: 'todos', records: [{ title: 'ok' }, { bad: 1 }] }));
      expect(e).toMatchObject({ code: 'invalid_params', index: 1, issues: [{ path: '/bad', message: 'is not allowed' }], hint: "skill_info('store')" });
      const notObject = await c.call('create_records', { app_id: app.id, collection: 'todos', records: [{ title: 'ok' }, 'text'] });
      expect(notObject.isError).toBe(true);
      expect(notObject.text).toContain('Input validation error');
    });
    expect(todos(app.id)).toEqual([]);
    expect(await audits(app.slug)).toEqual([]);
  });

  it(`1–${CREATE_RECORDS_MAX} records per call; a quota answers limit_exceeded; an unknown collection not_found with the declared ones`, async () => {
    const app = await newApp();
    await as('ed', async (c) => {
      for (const records of [[], Array.from({ length: CREATE_RECORDS_MAX + 1 }, () => ({ x: 1 }))]) {
        expect(errorOf(await c.call('create_records', { app_id: app.id, collection: 'todos', records }))).toMatchObject({
          code: 'invalid_params',
          limit: CREATE_RECORDS_MAX,
        });
      }
      ok(await c.call('create_records', { app_id: app.id, collection: 'todos', records: [{ n: 1 }, { n: 2 }] }));
      const over = errorOf(await c.call('create_records', { app_id: app.id, collection: 'todos', records: Array.from({ length: STORE_MAX - 1 }, (_, i) => ({ n: i })) }));
      expect(over).toMatchObject({ code: 'limit_exceeded', limit: 'STORE_MAX', value: STORE_MAX, hint: "skill_info('store')" });
      expect(todos(app.id)).toHaveLength(2);
      const unknown = errorOf(await c.call('create_records', { app_id: app.id, collection: 'notes', records: [{ n: 1 }] }));
      expect(unknown).toMatchObject({ code: 'not_found', available: ['todos'], hint: "skill_info('store')" });
    });
  });
});

describe('update_record and delete_record', () => {
  it('update merges by default, replace: true sets exactly the given fields; a refused change names the issues', async () => {
    const app = await newApp();
    STORE_DATA.set(app.id, { todos: [{ _id: 'r1', _owner: 'u1', title: 'Milk', done: false }] });
    await as('ed', async (c) => {
      const merged = ok(await c.call('update_record', { app_id: app.id, collection: 'todos', id: 'r1', fields: { done: true } }));
      expect(merged).toMatchObject({ app_id: app.id, collection: 'todos', id: 'r1', replaced: false });
      expect(typeof merged.updated_at).toBe('string');
      expect(todos(app.id)[0]).toMatchObject({ _id: 'r1', _owner: 'u1', title: 'Milk', done: true });

      ok(await c.call('update_record', { app_id: app.id, collection: 'todos', id: 'r1', fields: { title: 'Oat milk' }, replace: true }));
      expect(todos(app.id)[0]).not.toHaveProperty('done');
      expect(todos(app.id)[0]).toMatchObject({ _id: 'r1', _owner: 'u1', title: 'Oat milk' });

      const bad = errorOf(await c.call('update_record', { app_id: app.id, collection: 'todos', id: 'r1', fields: { bad: true } }));
      expect(bad).toMatchObject({ code: 'invalid_params', issues: [{ path: '/bad', message: 'is not allowed' }] });
      expect(bad).not.toHaveProperty('index');
      const notObject = await c.call('update_record', { app_id: app.id, collection: 'todos', id: 'r1', fields: [1] });
      expect(notObject.isError).toBe(true);
      expect(notObject.text).toContain('Input validation error');
      expect(errorOf(await c.call('update_record', { app_id: app.id, collection: 'todos', id: 'nope', fields: { done: true } })).code).toBe('not_found');
    });
    expect((await audits(app.slug)).map((a) => [a.action, a.actorKind, a.meta])).toEqual([
      ['data.record_update', 'agent', { module: 'store', collection: 'todos', id: 'r1' }],
      ['data.record_update', 'agent', { module: 'store', collection: 'todos', id: 'r1' }],
    ]);
  });

  it('delete removes the record once; a second call answers not_found', async () => {
    const app = await newApp();
    STORE_DATA.set(app.id, { todos: [{ _id: 'r1' }, { _id: 'r2' }] });
    await as('ed', async (c) => {
      expect(ok(await c.call('delete_record', { app_id: app.id, collection: 'todos', id: 'r1' }))).toEqual({ app_id: app.id, collection: 'todos', id: 'r1', deleted: true });
      expect(errorOf(await c.call('delete_record', { app_id: app.id, collection: 'todos', id: 'r1' })).code).toBe('not_found');
      expect(errorOf(await c.call('delete_record', { app_id: app.id, collection: 'todos', id: 'x'.repeat(65) })).code).toBe('invalid_params');
    });
    expect(todos(app.id).map((r) => r._id)).toEqual(['r2']);
    expect(await audits(app.slug)).toEqual([
      { action: 'data.record_delete', actorKind: 'agent', actorUserId: P.ed.userId, meta: { module: 'store', collection: 'todos', id: 'r1' } },
    ]);
  });
});

describe('delete_collection', () => {
  it('asks first with the record count, then drops the records and the declaration — audited as the agent', async () => {
    const app = await newApp(['todos', 'notes']);
    STORE_DATA.set(app.id, { todos: [{ _id: 'r1' }, { _id: 'r2' }] });
    await as('ed', async (c) => {
      const unknown = errorOf(await c.call('delete_collection', { app_id: app.id, collection: 'nope', user_confirmed: true }));
      expect(unknown).toMatchObject({ code: 'not_found', available: ['todos', 'notes'] });
      const ask = errorOf(await c.call('delete_collection', { app_id: app.id, collection: 'todos' }));
      expect(ask).toMatchObject({ code: 'user_confirmation_required', collection: 'todos', records: 2 });
      expect(String(ask.message)).toContain('Ask the user whether to delete "todos" with its 2 records');
      expect(todos(app.id)).toHaveLength(2);

      const out = ok(await c.call('delete_collection', { app_id: app.id, collection: 'todos', user_confirmed: true }));
      expect(out).toMatchObject({ app_id: app.id, collection: 'todos', deleted_records: 2 });
    });
    const [cfg] = await db.select().from(moduleConfigs).where(and(eq(moduleConfigs.appId, app.id), eq(moduleConfigs.module, 'store')));
    expect(cfg.config).toEqual({ collections: ['notes'] });
    expect(STORE_DATA.get(app.id)).not.toHaveProperty('todos');
    expect(await audits(app.slug)).toEqual([
      { action: 'data.collection_delete', actorKind: 'agent', actorUserId: P.ed.userId, meta: { module: 'store', collection: 'todos', records: 2 } },
    ]);
  });

  it("takes the single-writer lease: another user's lease answers app_locked and nothing is dropped", async () => {
    const app = await newApp();
    STORE_DATA.set(app.id, { todos: [{ _id: 'r1' }] });
    await deps.leases.acquire(app.id, { userId: P.alice.userId, sessionId: 'alice-session' }, 60_000);
    await as('ed', async (c) => {
      expect(errorOf(await c.call('delete_collection', { app_id: app.id, collection: 'todos', user_confirmed: true })).code).toBe('app_locked');
    });
    expect(todos(app.id)).toHaveLength(1);
  });
});

describe('purge_orphan_records', () => {
  it('nothing to purge answers at once; orphans are listed in the question, then purged — audited as the agent', async () => {
    const app = await newApp();
    await as('ed', async (c) => {
      expect(ok(await c.call('purge_orphan_records', { app_id: app.id }))).toMatchObject({ app_id: app.id, purged: [] });
    });
    STORE_DATA.set(app.id, { todos: [{ _id: 't' }], old: [{ _id: 'o1' }, { _id: 'o2' }], older: [{ _id: 'o3' }] });
    await as('ed', async (c) => {
      const declared = errorOf(await c.call('purge_orphan_records', { app_id: app.id, collection: 'todos', user_confirmed: true }));
      expect(declared).toMatchObject({ code: 'invalid_params', orphans: [{ name: 'old', records: 2 }, { name: 'older', records: 1 }] });
      expect(errorOf(await c.call('purge_orphan_records', { app_id: app.id, collection: 'nope', user_confirmed: true })).code).toBe('not_found');

      const ask = errorOf(await c.call('purge_orphan_records', { app_id: app.id }));
      expect(ask).toMatchObject({ code: 'user_confirmation_required', orphans: [{ name: 'old', records: 2 }, { name: 'older', records: 1 }] });
      expect(String(ask.message)).toContain('"old" (2 records), "older" (1 record)');
      const one = ok(await c.call('purge_orphan_records', { app_id: app.id, collection: 'older', user_confirmed: true }));
      expect(one).toMatchObject({ purged: [{ name: 'older', records: 1 }] });
      const rest = ok(await c.call('purge_orphan_records', { app_id: app.id, user_confirmed: true }));
      expect(rest).toMatchObject({ purged: [{ name: 'old', records: 2 }] });
    });
    expect(Object.keys(STORE_DATA.get(app.id) ?? {})).toEqual(['todos']);
    expect((await audits(app.slug)).map((a) => [a.action, a.actorKind, a.meta])).toEqual([
      ['data.collection.purge', 'agent', { module: 'store', collection: 'older', records: 1, orphan: true }],
      ['data.collection.purge', 'agent', { module: 'store', collection: 'old', records: 2, orphan: true }],
    ]);
  });
});

describe('access', () => {
  const CALLS: [string, Record<string, unknown>][] = [
    ['create_records', { collection: 'todos', records: [{ x: 1 }] }],
    ['update_record', { collection: 'todos', id: 'r1', fields: { x: 2 } }],
    ['delete_record', { collection: 'todos', id: 'r1' }],
    ['delete_collection', { collection: 'todos', user_confirmed: true }],
    ['purge_orphan_records', { user_confirmed: true }],
  ];

  it('a viewer is forbidden, a non-member gets not_found, a taken-down app answers app_locked_by_admin — nothing changes', async () => {
    const app = await newApp();
    const taken = await newApp();
    await takedownApp({ appId: taken.id, reason: 'spam', actorUserId: rootId });
    STORE_DATA.set(app.id, { todos: [{ _id: 'r1', x: 1 }], old: [{ _id: 'o1' }] });
    STORE_DATA.set(taken.id, { todos: [{ _id: 'r1', x: 1 }], old: [{ _id: 'o1' }] });
    for (const [tool, args] of CALLS) {
      await as('vera', async (c) => expect(errorOf(await c.call(tool, { app_id: app.id, ...args })).code, tool).toBe('forbidden'));
      await as('eve', async (c) => expect(errorOf(await c.call(tool, { app_id: app.id, ...args })).code, tool).toBe('not_found'));
      await as('alice', async (c) => expect(errorOf(await c.call(tool, { app_id: taken.id, ...args })).code, tool).toBe('app_locked_by_admin'));
    }
    for (const id of [app.id, taken.id]) expect(STORE_DATA.get(id)).toEqual({ todos: [{ _id: 'r1', x: 1 }], old: [{ _id: 'o1' }] });
    expect(await audits(app.slug)).toEqual([]);
  });

  it('without a records module → not_found pointing at skill_info(); a module that cannot add records → unavailable', async () => {
    const app = await newApp();
    await as('alice', async (c) => {
      expect(errorOf(await c.call('create_records', { app_id: app.id, collection: 'todos', records: [{ x: 1 }] }))).toMatchObject({
        code: 'not_found',
        hint: 'skill_info()',
      });
    }, testDeps());

    const readOnly = defineModule<{ collections: string[] }>({
      name: 'shelf',
      version: '1.0.0',
      skill: { useWhen: 'the app reads records', markdown: '# shelf\n' },
      configSchema: z.object({ collections: z.array(z.string()) }),
      configDefaults: { collections: ['todos'] },
      records: {
        collections: async () => [{ name: 'todos', rules: {}, schema: null, columns: [], records: 0 }],
        query: async () => ({ collection: { name: 'todos', rules: {}, schema: null, columns: [], records: 0 }, records: [], total: 0, next_cursor: null }),
        get: async () => null,
        remove: async () => false,
        async *csv() {},
      },
    });
    const shelf = await loadModuleRuntime({ env: RUNTIME_ENV, log: noopLogger, modules: [readOnly], deps: RUNTIME_DEPS });
    await as('alice', async (c) => {
      expect(errorOf(await c.call('create_records', { app_id: app.id, collection: 'todos', records: [{ x: 1 }] }))).toMatchObject({
        code: 'unavailable',
        hint: "skill_info('shelf')",
      });
      expect(errorOf(await c.call('delete_collection', { app_id: app.id, collection: 'todos', user_confirmed: true })).code).toBe('unavailable');
    }, { ...testDeps(), modules: async () => shelf });
  });
});
