/**
 * The Data tab's actions (NSO-324) against a real PGlite database and a real
 * ModuleRuntime whose records module is an in-memory fake (the workspace role
 * gate is stubbed — requireWorkspaceRole has its own tests in @drobek/tenancy):
 * deleting a record from the collection table is audited
 * `data.record_delete`; orphan collections are listed and purged by an
 * editor (audited `data.collection.purge`), a viewer is refused before
 * anything changes.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { apps, auditLog, moduleConfigs, setDbForTests, users, workspaces } from '@drobek/db';
import { noopLogger } from '@drobek/core';
import {
  ModuleError,
  defineModule,
  loadModuleRuntime,
  memoryMailGuard,
  memoryRateLimiter,
  setModuleRuntimeForTests,
  z,
  type RecordsCollection,
} from '@drobek/modules';

const role = vi.hoisted(() => ({ current: 'editor' as 'viewer' | 'editor', user: { id: '', email: 'owner@example.com' }, ws: { id: '', slug: 'acme', name: 'Acme' } }));

vi.mock('@drobek/tenancy', () => {
  const rank = { viewer: 1, editor: 2, 'workspace-admin': 3 } as const;
  return {
    requireWorkspaceRole: async (_request: Request, slug: string, min: keyof typeof rank) => {
      if (slug !== role.ws.slug) throw new Response('Not found', { status: 404 });
      if (rank[role.current] < rank[min]) throw new Response('Forbidden', { status: 403 });
      return { user: role.user, workspace: role.ws, membershipRole: role.current, superAdmin: false, effectiveRole: role.current };
    },
  };
});

const tab = await import('./workspaces.$slug.apps.$appSlug.data.server.js');
const table = await import('./workspaces.$slug.apps.$appSlug.data.$collection.server.js');

const ENV = {
  APPS_DOMAIN: 'apps.example',
  PUBLIC_APP_URL: 'https://drobek.example',
  PUBLIC_ORIGIN: 'https://drobek.example',
  DROBEK_MASTER_KEY: '33'.repeat(32),
  DROBEK_MIGRATE_ON_START: '0',
};

/** The fake store: collection → record id → fields (declared or not). */
const store = new Map<string, Map<string, Record<string, unknown>>>();

type Cfg = { collections: Record<string, Record<string, never>> };

const describeCollection = (name: string): RecordsCollection => ({ name, rules: {}, schema: null, columns: [], records: store.get(name)?.size ?? 0 });

const data = defineModule<Cfg>({
  name: 'data',
  version: '1.0.0',
  skill: { useWhen: 'you store records', markdown: '# data' },
  configSchema: z.strictObject({ collections: z.record(z.string(), z.strictObject({})).default({}) }),
  configDefaults: { collections: {} },
  records: {
    collections: async (v) => Object.keys(v.config.collections).map(describeCollection),
    query: async (_v, q) => ({ collection: describeCollection(q.collection), records: [...(store.get(q.collection)?.values() ?? [])], total: store.get(q.collection)?.size ?? 0, next_cursor: null }),
    get: async (_v, c, id) => store.get(c)?.get(id) ?? null,
    remove: async (_v, c, id) => store.get(c)?.delete(id) ?? false,
    csv: async function* () {},
    orphans: async (v) =>
      [...store.entries()].filter(([n, rows]) => rows.size > 0 && !(n in v.config.collections)).map(([name, rows]) => ({ name, records: rows.size })),
    purgeOrphan: async (v, c) => {
      if (c in v.config.collections) throw new ModuleError('conflict', `"${c}" is a declared collection.`);
      const n = store.get(c)?.size ?? 0;
      store.delete(c);
      return { records: n };
    },
  },
});

let pg: PGlite;
let appId: string;
let savedKey: string | undefined;
const db = () => drizzle(pg, { schema });

const base = 'https://drobek.example/workspaces/acme/apps/shop-app/data';

function post(url: string, body: Record<string, string>): Request {
  return new Request(url, { method: 'POST', body: new URLSearchParams(body) });
}

/** The body + status of a `data(…, { status })` result. */
function failed(res: unknown): { status: number; body: Record<string, unknown> } {
  const d = res as { data: Record<string, unknown>; init: { status: number } };
  return { status: d.init?.status, body: d.data };
}

const audits = async () => (await db().select().from(auditLog)).map((r) => ({ action: r.action, actor: r.actorUserId, target: r.target, meta: r.meta }));

beforeAll(async () => {
  savedKey = process.env.DROBEK_MASTER_KEY;
  process.env.DROBEK_MASTER_KEY = ENV.DROBEK_MASTER_KEY;
  pg = new PGlite();
  await migrate(db(), {
    migrationsFolder: fileURLToPath(new URL('../../../db/drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db());
  const [u] = await db().insert(users).values({ email: 'owner@example.com' }).returning();
  role.user = { id: u.id, email: u.email };
  const [w] = await db().insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
  role.ws = { id: w.id, slug: w.slug, name: w.name };
  const [a] = await db().insert(apps).values({ workspaceId: w.id, slug: 'shop-app', name: 'Shop' }).returning();
  appId = a.id;
  const rt = await loadModuleRuntime({
    env: ENV,
    log: noopLogger,
    modules: [data],
    skillsDir: null,
    deps: {
      rateLimit: memoryRateLimiter(),
      principal: async () => ({ kind: 'anon' }),
      email: { send: async () => {} },
      mailGuard: memoryMailGuard({ hourlyMax: 100, pauseMinutes: 1 }, noopLogger),
    },
  });
  setModuleRuntimeForTests(rt);
});

afterAll(async () => {
  setModuleRuntimeForTests(null);
  if (savedKey === undefined) delete process.env.DROBEK_MASTER_KEY;
  else process.env.DROBEK_MASTER_KEY = savedKey;
  await pg.close();
});

beforeEach(async () => {
  role.current = 'editor';
  store.clear();
  store.set('todos', new Map([['r1', { _id: 'r1', _owner: null, _created_at: '2026-09-24T00:00:00.000Z', _updated_at: '2026-09-24T00:00:00.000Z', title: 'one' }]]));
  store.set('ghost', new Map([['g1', { _id: 'g1' }], ['g2', { _id: 'g2' }]]));
  await db().delete(moduleConfigs);
  await db().delete(auditLog);
  await db().insert(moduleConfigs).values({ appId, module: 'data', config: { collections: { todos: {} } } });
});

describe('deleting a record from the collection table', () => {
  const url = `${base}/todos`;
  const params = { slug: 'acme', appSlug: 'shop-app', collection: 'todos' };

  it('is audited data.record_delete (subject app, meta: module, collection and the record id — never values)', async () => {
    const res = (await table.action({ request: post(url, { intent: 'delete', id: 'r1' }), params, context: {} } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/workspaces/acme/apps/shop-app/data/todos');
    expect(store.get('todos')?.has('r1')).toBe(false);
    expect(await audits()).toEqual([{ action: 'data.record_delete', actor: role.user.id, target: 'shop-app', meta: { module: 'data', collection: 'todos', id: 'r1' } }]);
  });

  it('a viewer is refused (403) before anything changes; a missing record → 404 without an audit row', async () => {
    role.current = 'viewer';
    const refused = await table.action({ request: post(url, { intent: 'delete', id: 'r1' }), params, context: {} } as never).catch((e: unknown) => e);
    expect((refused as Response).status).toBe(403);
    role.current = 'editor';
    const missing = await table.action({ request: post(url, { intent: 'delete', id: 'nope' }), params, context: {} } as never).catch((e: unknown) => e);
    expect((missing as { init?: { status: number } }).init?.status).toBe(404);
    expect(store.get('todos')?.has('r1')).toBe(true);
    expect(await audits()).toEqual([]);
  });
});

describe('orphan collections on the Data tab', () => {
  const params = { slug: 'acme', appSlug: 'shop-app' };

  it('the loader lists them with counts next to the declared collections', async () => {
    const d = await tab.loader({ request: new Request(base), params, context: {} } as never);
    expect(d.collections.map((c) => c.name)).toEqual(['todos']);
    expect(d.orphans).toEqual([{ name: 'ghost', records: 2 }]);
    expect(d.canPurge).toBe(true);
    role.current = 'viewer';
    expect((await tab.loader({ request: new Request(base), params, context: {} } as never)).canPurge).toBe(false);
  });

  it('an editor purges one after typing its name (audited data.collection.purge); a wrong name or a declared collection is refused', async () => {
    const wrong = failed(await tab.action({ request: post(base, { intent: 'purge-orphan', collection: 'ghost', confirm_name: 'ghos' }), params, context: {} } as never));
    expect(wrong).toMatchObject({ status: 400, body: { intent: 'purge-orphan', collection: 'ghost' } });
    expect(store.get('ghost')?.size).toBe(2);

    const declared = failed(await tab.action({ request: post(base, { intent: 'purge-orphan', collection: 'todos', confirm_name: 'todos' }), params, context: {} } as never));
    expect(declared.status).toBe(409);
    expect(store.get('todos')?.size).toBe(1);

    const res = (await tab.action({ request: post(base, { intent: 'purge-orphan', collection: 'ghost', confirm_name: 'ghost' }), params, context: {} } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/workspaces/acme/apps/shop-app/data?purged=ghost');
    expect(store.has('ghost')).toBe(false);
    expect(await audits()).toEqual([
      { action: 'data.collection.purge', actor: role.user.id, target: 'shop-app', meta: { module: 'data', collection: 'ghost', records: 2, orphan: true } },
    ]);
    const after = await tab.loader({ request: new Request(`${base}?purged=ghost`), params, context: {} } as never);
    expect(after).toMatchObject({ orphans: [], purged: 'ghost' });
  });

  it('a viewer is refused (403) before anything changes', async () => {
    role.current = 'viewer';
    const refused = await tab.action({ request: post(base, { intent: 'purge-orphan', collection: 'ghost', confirm_name: 'ghost' }), params, context: {} } as never).catch((e: unknown) => e);
    expect((refused as Response).status).toBe(403);
    expect(store.get('ghost')?.size).toBe(2);
    expect(await audits()).toEqual([]);
  });
});
