/**
 * The data module under createModuleTestContext(): real routes through the
 * production pipeline (CSRF, rules, body limits), PGlite with the core + data
 * migrations (and a legacy Data API database imported by the data migration).
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apps, moduleConfigs, workspaces, type DB } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import { RECORDS_IMPORT_MAX_ROWS, buildSdk, isDefinedModule, loadModules, type Principal, type RecordsView } from '@drobek/modules';
import { createModuleTestContext, type ModuleTestContext } from '@drobek/modules/testing';
import auth from 'drobek-module-auth';
import data, { DATA_CONFIG_DEFAULTS, dataConfigSchema, dataConfirmRequired, dataRecords, recordsAuthority, type DataConfig } from './index.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../../packages/db/drizzle/migrations', import.meta.url));

let pg: PGlite;
let db: DB;
let workspaceId: string;
let appA: string;
let appB: string;
let legacyApp: string;

const ANON: Principal = { kind: 'anon' };
const A: Principal = { kind: 'user', id: 'eu_a', email: 'a@example.com', role: 'user' };
const B: Principal = { kind: 'user', id: 'eu_b', email: 'b@example.com', role: 'user' };
const ADMIN: Principal = { kind: 'user', id: 'eu_admin', email: 'boss@example.com', role: 'admin' };

const TODO_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: { title: { type: 'string', maxLength: 200 }, done: { type: 'boolean' }, priority: { type: 'number' }, tags: { type: 'array' } },
};

const CONFIG = {
  collections: {
    todos: { schema: TODO_SCHEMA },
    guestbook: { rules: { read: 'public', create: 'public', update: 'admin', delete: 'admin' } },
    members: { rules: { read: 'user', create: 'user', update: 'owner', delete: 'owner|admin' } },
    admins: { rules: { read: 'admin', create: 'admin', update: 'admin', delete: 'admin' } },
  },
};

beforeAll(async () => {
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  const [ws] = await d.insert(workspaces).values({ kind: 'team', slug: 'data-ws', name: 'Data' }).returning();
  workspaceId = ws.id;
  const [a] = await d.insert(apps).values({ workspaceId, slug: 'notes', name: 'Notes' }).returning();
  const [b] = await d.insert(apps).values({ workspaceId, slug: 'other', name: 'Other' }).returning();
  const [legacy] = await d.insert(apps).values({ workspaceId, slug: 'legacy', name: 'Legacy' }).returning();
  appA = a.id;
  appB = b.id;
  legacyApp = legacy.id;

  // A database of the pre-module Data API (core tables, still there before the data migration).
  const schemaJson = JSON.stringify({ type: 'object', required: ['title'], properties: { title: { type: 'string' } } });
  for (const [name, mode] of [
    ['board', 'public-read'],
    ['wall', 'public-write'],
    ['vault', 'locked'],
    ['mine', 'owner-only'],
    ['bad name!', 'public-read'],
  ]) {
    await pg.query(`INSERT INTO collections (id, app_id, name, json_schema, access_mode) VALUES ($1, $2, $3, $4::jsonb, $5)`, [
      `col_${name.replace(/\W/g, '')}`,
      legacyApp,
      name,
      schemaJson,
      mode,
    ]);
  }
  await pg.query(
    `INSERT INTO app_documents (id, app_id, collection, doc, created_at, updated_at, deleted_at) VALUES
      ('doc_live', $1, 'wall', '{"title":"hello","_id":"spoof"}', '2026-01-02 03:04:05', '2026-01-02 03:04:06', NULL),
      ('doc_gone', $1, 'wall', '{"title":"deleted"}', now(), now(), now()),
      ('doc_bad', $1, 'bad name!', '{"title":"orphan"}', now(), now(), NULL)`,
    [legacyApp]
  );

  await migrate(d, { migrationsFolder: data.migrations!.folder, migrationsTable: '__drizzle_migrations_mod_data', migrationsSchema: 'drizzle' });
  db = d as unknown as DB;
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await db.delete(dataRecords).where(sql`${dataRecords.appId} <> ${legacyApp}`);
});

function ctx(opts: { principal?: Principal; config?: Record<string, unknown>; limits?: Record<string, number>; app?: string } = {}): ModuleTestContext {
  const id = opts.app ?? appA;
  return createModuleTestContext(data, {
    db,
    app: { id, slug: id === appA ? 'notes' : 'other', workspaceId },
    config: opts.config ?? CONFIG,
    limits: opts.limits,
    principal: opts.principal ?? ANON,
    origin: `http://${id === appA ? 'notes' : 'other'}--preview.apps.localhost`,
  });
}

type Rec = Record<string, unknown> & { _id: string; _owner: string | null };

async function create(t: ModuleTestContext, collection: string, body: unknown): Promise<Rec> {
  const r = await t.request('POST', `/${collection}`, { body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as Rec;
}

/** The workspace limits the owner's view sees (tests lower them). */
let viewLimits: Record<string, number> = {};

function view(app = appA, config: DataConfig = dataConfigSchema.parse(CONFIG)): RecordsView<DataConfig> {
  return { app: { id: app, slug: 'notes', workspaceId }, config, db, log: { debug() {}, info() {}, warn() {}, error() {} } as never, limits: async () => viewLimits };
}

describe('the module', () => {
  it('is a valid module; loads with auth; the SDK exposes drobek.data', async () => {
    expect(isDefinedModule(data)).toBe(true);
    const importer = async (pkg: string) => ({ 'drobek-module-auth': { default: auth }, 'drobek-module-data': { default: data } })[pkg];
    expect((await loadModules({ DROBEK_MODULES: 'auth,data' }, { importer })).map((m) => m.name)).toEqual(['auth', 'data']);
    expect((await loadModules({ DROBEK_MODULES: 'data' }, { importer })).map((m) => m.name)).toEqual(['data']);
    const sdk = await buildSdk([auth, data]);
    expect(sdk.dts).toContain('readonly data: data.Api;');
    expect(sdk.dts).toContain('collection<T extends object = Record<string, unknown>>(name: string): Collection<T>;');
  });

  it("the skill's React example (a user's own records behind <LoginGate>) compiles", async () => {
    const { compile } = await import('@drobek/compile');
    const sdk = await buildSdk([auth, data]);
    const example = /```tsx\n([\s\S]*?)```/.exec(data.skill.markdown)![1];
    const r = await compile(
      new Map([
        [
          'drobek.json',
          JSON.stringify({
            imports: {
              react: 'https://esm.sh/react@19.1.0',
              'react/jsx-runtime': 'https://esm.sh/react@19.1.0/jsx-runtime',
              'react-dom': 'https://esm.sh/react-dom@19.1.0?deps=react@19.1.0',
              'react-dom/client': 'https://esm.sh/react-dom@19.1.0/client?deps=react@19.1.0',
            },
          }),
        ],
        ['src/main.tsx', example],
        ['src/styles.css', 'body { margin: 0; }'],
      ]),
      { sdkUrl: sdk.url, sdkSources: sdk.inline }
    );
    expect(r.errors).toEqual([]);
    const out = r.outputs.get('main.js')!.toString('utf8');
    expect(out).toContain('function LoginGate(');
    expect(out).toContain('"todos"');
    expect(data.skill.markdown.split('\n').length).toBeLessThanOrEqual(150);
  });
});

describe('config', () => {
  it('fills the default rules (the owner-only mapping) and accepts a schemaless collection', () => {
    expect(dataConfigSchema.parse({ collections: { notes: {} } })).toEqual({
      collections: { notes: { rules: { read: 'owner|admin', create: 'user', update: 'owner|admin', delete: 'owner|admin' } } },
    });
    expect(dataConfigSchema.parse(DATA_CONFIG_DEFAULTS)).toEqual({ collections: {} });
  });

  it('refuses bad names, rules, schemas and unknown keys', () => {
    for (const bad of [
      { collections: { 'bad name': {} } },
      { collections: { _x: {} } },
      { collections: { x: { rules: { read: 'everyone' } } } },
      { collections: { x: { rules: { list: 'public' } } } },
      { collections: { x: { schema: { type: 'nope' } } } },
      { collections: { x: { ownerField: 'by' } } },
      { tables: {} },
    ]) {
      expect(dataConfigSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`c${i}`, {}]));
    expect(dataConfigSchema.safeParse({ collections: many }).success).toBe(false);
  });

  it('the config schema has a JSON Schema (the dashboard form)', async () => {
    const { z } = await import('@drobek/modules');
    expect(() => z.toJSONSchema(dataConfigSchema, { io: 'input' })).not.toThrow();
  });
});

describe('confirmRequired', () => {
  const parse = (c: unknown) => dataConfigSchema.parse(c);
  const confirm = (before: unknown, after: unknown, app = appA) => dataConfirmRequired(parse(before), parse(after), { app: { id: app, slug: 'x', workspaceId }, db });

  it('create/update/delete opened to public, and read of an existing collection', async () => {
    const out = await confirm({ collections: { x: {} } }, { collections: { x: { rules: { read: 'public', create: 'public' } } } });
    expect(out).toEqual([
      'data.collections.x.rules.read: "owner|admin" → "public" (anyone, signed in or not, may read every record)',
      'data.collections.x.rules.create: "user" → "public" (anyone, signed in or not, may add records)',
    ]);
  });

  it('a NEW empty collection may be public-read without a confirmation; public create always needs one', async () => {
    expect(await confirm({}, { collections: { news: { rules: { read: 'public', create: 'admin' } } } })).toEqual([]);
    expect(await confirm({}, { collections: { x: { rules: { create: 'public' } } } })).toEqual([
      'data.collections.x.rules.create: (new collection) → "public" (anyone, signed in or not, may add records)',
    ]);
  });

  it('a new public-read collection that already holds records (a re-declared one) needs a confirmation', async () => {
    await create(ctx({ principal: A }), 'todos', { title: 'kept' });
    expect(await confirm({}, { collections: { todos: { rules: { read: 'public' } } } })).toHaveLength(1);
  });

  it('update/delete opened to every signed-in user', async () => {
    expect(await confirm({ collections: { x: {} } }, { collections: { x: { rules: { update: 'user', delete: 'user|admin' } } } })).toEqual([
      'data.collections.x.rules.update: "owner|admin" → "user" (every signed-in user may change every record, not only their own)',
      'data.collections.x.rules.delete: "owner|admin" → "user|admin" (every signed-in user may delete every record, not only their own)',
    ]);
    expect(await confirm({}, { collections: { x: { rules: { create: 'user', read: 'user' } } } })).toEqual([]);
  });

  it('removing the schema of a collection with records (not of an empty one)', async () => {
    expect(await confirm({ collections: { todos: { schema: TODO_SCHEMA } } }, { collections: { todos: {} } })).toEqual([]);
    await create(ctx({ principal: A }), 'todos', { title: 'one' });
    expect(await confirm({ collections: { todos: { schema: TODO_SCHEMA } } }, { collections: { todos: {} } })).toEqual([
      'data.collections.todos.schema: removed while the collection holds 1 record (any shape can be stored afterwards)',
    ]);
    // Records of ANOTHER app do not count.
    expect(await confirm({ collections: { todos: { schema: TODO_SCHEMA } } }, { collections: { todos: {} } }, appB)).toEqual([]);
  });

  it('tightening or an unchanged public rule needs nothing', async () => {
    const pub = { collections: { g: { rules: { read: 'public', create: 'public' } } } };
    expect(await confirm(pub, pub)).toEqual([]);
    expect(await confirm(pub, { collections: { g: { rules: { read: 'admin', create: 'admin' } } } })).toEqual([]);
    expect(await confirm(pub, {})).toEqual([]);
  });
});

describe('REST: rules', () => {
  it('anon read of a `read: user` collection → 401 (list and get); signed in → 200', async () => {
    const rec = await create(ctx({ principal: A }), 'members', { name: 'Ana' });
    const anon = ctx();
    const list = await anon.request('GET', '/members');
    expect(list.status).toBe(401);
    expect(list.body).toMatchObject({ error: 'unauthorized', hint: "skill_info('data')" });
    expect((await anon.request('GET', `/members/${rec._id}`)).status).toBe(401);
    expect((await anon.request('GET', '/members/no-such-id')).status).toBe(401);
    expect((await ctx({ principal: B }).request('GET', '/members')).status).toBe(200);
  });

  it("update: owner — another user's record → 403, one's own → 200 (shallow merge)", async () => {
    const rec = await create(ctx({ principal: A }), 'members', { name: 'Ana', city: 'Brno' });
    const other = await ctx({ principal: B }).request('PATCH', `/members/${rec._id}`, { body: { name: 'Hacked' } });
    expect(other.status).toBe(403);
    expect(other.body).toMatchObject({ error: 'forbidden' });
    const own = await ctx({ principal: A }).request('PATCH', `/members/${rec._id}`, { body: { city: 'Praha' } });
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ _id: rec._id, _owner: 'eu_a', name: 'Ana', city: 'Praha' });
    expect((await ctx().request('PATCH', `/members/${rec._id}`, { body: { city: 'x' } })).status).toBe(401);
    // An admin is not the owner: `update: owner` alone refuses them too.
    expect((await ctx({ principal: ADMIN }).request('PATCH', `/members/${rec._id}`, { body: { city: 'x' } })).status).toBe(403);
    // delete: owner|admin
    expect((await ctx({ principal: B }).request('DELETE', `/members/${rec._id}`)).status).toBe(403);
    const del = await ctx({ principal: ADMIN }).request('DELETE', `/members/${rec._id}`);
    expect(del).toMatchObject({ status: 200, body: { id: rec._id, deleted: true } });
    expect((await ctx({ principal: A }).request('GET', `/members/${rec._id}`)).status).toBe(404);
  });

  it('`read: owner|admin` lists only the caller\'s own records; an admin lists all; a visitor 401', async () => {
    await create(ctx({ principal: A }), 'todos', { title: 'a1' });
    await create(ctx({ principal: A }), 'todos', { title: 'a2' });
    await create(ctx({ principal: B }), 'todos', { title: 'b1' });
    const titles = async (p: Principal) => ((await ctx({ principal: p }).request('GET', '/todos')).body as { records: Rec[] }).records.map((r) => r.title).sort();
    expect(await titles(A)).toEqual(['a1', 'a2']);
    expect(await titles(B)).toEqual(['b1']);
    expect(await titles(ADMIN)).toEqual(['a1', 'a2', 'b1']);
    expect((await ctx().request('GET', '/todos')).status).toBe(401);
    // A filter cannot widen it (_owner is not filterable).
    const r = await ctx({ principal: A }).request('GET', '/todos', { query: { filter: JSON.stringify({ _owner: 'eu_b' }) } });
    expect(r.status).toBe(400);
  });

  it('the server fills _owner and the _… fields; a client cannot spoof them', async () => {
    const rec = await create(ctx({ principal: A }), 'members', {
      name: 'Ana',
      _owner: 'eu_b',
      _id: 'chosen',
      _created_at: '2000-01-01T00:00:00Z',
    });
    expect(rec._owner).toBe('eu_a');
    expect(rec._id).not.toBe('chosen');
    expect(rec._created_at).not.toBe('2000-01-01T00:00:00Z');
    expect(Object.keys(rec).sort()).toEqual(['_created_at', '_id', '_owner', '_updated_at', 'name']);
    const moved = await ctx({ principal: A }).request('PATCH', `/members/${rec._id}`, { body: { _owner: 'eu_b', name: 'Ana 2' } });
    expect(moved.body).toMatchObject({ _owner: 'eu_a', name: 'Ana 2' });
    const [row] = await db.select().from(dataRecords).where(sql`${dataRecords.id} = ${rec._id}`);
    expect(row.doc).toEqual({ name: 'Ana 2' });
    const proto = await ctx({ principal: A }).request('POST', '/members', { rawBody: '{"name":"x","__proto__":{"polluted":true},"constructor":{"prototype":{"p":1}}}', headers: { 'content-type': 'application/json' } });
    expect(proto.status).toBe(201);
    expect(Object.keys(proto.body as object).sort()).toEqual(['_created_at', '_id', '_owner', '_updated_at', 'constructor', 'name']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('create: public — a visitor adds a record without an owner; update/delete stay admin', async () => {
    const rec = await create(ctx(), 'guestbook', { text: 'hi' });
    expect(rec._owner).toBeNull();
    expect((await ctx().request('GET', '/guestbook')).status).toBe(200);
    expect((await ctx().request('PATCH', `/guestbook/${rec._id}`, { body: { text: 'x' } })).status).toBe(401);
    expect((await ctx({ principal: A }).request('DELETE', `/guestbook/${rec._id}`)).status).toBe(403);
    expect((await ctx({ principal: ADMIN }).request('DELETE', `/guestbook/${rec._id}`)).status).toBe(200);
  });

  it('admin-only collections refuse users (403) and visitors (401)', async () => {
    expect((await ctx({ principal: A }).request('POST', '/admins', { body: { x: 1 } })).status).toBe(403);
    expect((await ctx().request('POST', '/admins', { body: { x: 1 } })).status).toBe(401);
    expect((await ctx({ principal: ADMIN }).request('POST', '/admins', { body: { x: 1 } })).status).toBe(201);
  });

  it('an undeclared collection or a malformed name → 404; writes need the SDK header', async () => {
    const r = await ctx({ principal: ADMIN }).request('GET', '/secrets');
    expect(r).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect((r.body as { message: string }).message).toContain("configure_module('data'");
    expect((await ctx({ principal: ADMIN }).request('GET', '/..%2Fapps')).status).toBe(404);
    expect((await ctx({ principal: ADMIN }).request('GET', '/todos/bad%20id')).status).toBe(404);
    const csrf = await ctx().request('POST', '/guestbook', { body: { text: 'x' }, headers: { 'x-drobek-sdk': '' } });
    expect(csrf.status).toBe(403);
  });
});

describe('REST: schema, quota, rate limit', () => {
  it('a record that breaks the schema → 422 validation_failed with the fields', async () => {
    const r = await ctx({ principal: A }).request('POST', '/todos', { body: { done: 'yes' } });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: 'validation_failed' });
    expect(JSON.stringify((r.body as { details: unknown }).details)).toContain('title');
    const rec = await create(ctx({ principal: A }), 'todos', { title: 'ok' });
    const bad = await ctx({ principal: A }).request('PATCH', `/todos/${rec._id}`, { body: { title: 42 } });
    expect(bad.status).toBe(422);
    for (const body of [[1, 2], 'text', null]) {
      expect((await ctx({ principal: A }).request('POST', '/members', { body })).status).toBe(400);
    }
  });

  it('DATA_MAX_DOCS_PER_APP = 5: the 6th create → 409 quota_exceeded (all collections of the app count)', async () => {
    const t = ctx({ principal: A, limits: { DATA_MAX_DOCS_PER_APP: 5 } });
    for (let i = 0; i < 3; i++) await create(t, 'todos', { title: `t${i}` });
    for (let i = 0; i < 2; i++) await create(t, 'members', { name: `m${i}` });
    const sixth = await t.request('POST', '/todos', { body: { title: 'six' } });
    expect(sixth.status).toBe(409);
    expect(sixth.body).toMatchObject({ error: 'quota_exceeded', details: { limit: 'DATA_MAX_DOCS_PER_APP', value: 5 } });
    // Another app has its own quota.
    await create(ctx({ principal: A, limits: { DATA_MAX_DOCS_PER_APP: 5 }, app: appB }), 'todos', { title: 'b' });
  });

  it('concurrent creates never overshoot the record quota', async () => {
    const t = ctx({ principal: A, limits: { DATA_MAX_DOCS_PER_APP: 3 } });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => t.request('POST', '/todos', { body: { title: `c${i}` } })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
  });

  it('a record over DATA_MAX_DOC_BYTES → 413; the app byte cap → 409', async () => {
    const t = ctx({ principal: A, limits: { DATA_MAX_DOC_BYTES: 100, DATA_MAX_BYTES_PER_APP: 150 } });
    const big = await t.request('POST', '/members', { body: { text: 'x'.repeat(200) } });
    expect(big).toMatchObject({ status: 413, body: { error: 'payload_too_large' } });
    await create(t, 'members', { text: 'x'.repeat(60) });
    const over = await t.request('POST', '/members', { body: { text: 'x'.repeat(80) } });
    expect(over).toMatchObject({ status: 409, body: { error: 'quota_exceeded', details: { limit: 'DATA_MAX_BYTES_PER_APP' } } });
  });

  it('DATA_WRITE_RATE_LIMIT caps the writes of an app (429 + Retry-After); reads are not limited', async () => {
    const t = ctx({ principal: A, limits: { DATA_WRITE_RATE_LIMIT: 2 } });
    const rec = await create(t, 'members', { n: 1 });
    await create(t, 'members', { n: 2 });
    const third = await t.request('PATCH', `/members/${rec._id}`, { body: { n: 3 } });
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ error: 'rate_limited' });
    expect(third.headers['retry-after'] ?? third.headers['Retry-After']).toBeDefined();
    for (let i = 0; i < 5; i++) expect((await t.request('GET', '/members')).status).toBe(200);
  });
});

describe('REST: queries', () => {
  async function seed() {
    const t = ctx({ principal: ADMIN });
    const out: Rec[] = [];
    for (const [title, done, priority, tags] of [
      ['Milk', false, 1, ['shop']],
      ['Bread', true, 2, ['shop', 'bakery']],
      ['Tax return', false, 5, ['admin']],
      ['milkshake', false, 2, []],
    ] as const) {
      out.push(await create(t, 'todos', { title, done, priority, tags }));
    }
    return { t, out };
  }
  const titles = (r: { body: unknown }) => (r.body as { records: Rec[] }).records.map((x) => x.title);
  const q = (t: ModuleTestContext, query: Record<string, string>) => t.request('GET', '/todos', { query });

  it('filters: equality, operators, in, contains (substring, ignoring case; list element)', async () => {
    const { t } = await seed();
    const f = async (filter: unknown) => ({ body: { records: titles(await q(t, { filter: JSON.stringify(filter) })).sort().map((title) => ({ title })) } });
    expect(titles(await f({ done: true }))).toEqual(['Bread']);
    expect(titles(await f({ done: 'true' }))).toEqual(['Bread']);
    expect(titles(await f({ done: { ne: true } }))).toEqual(['Milk', 'Tax return', 'milkshake']);
    expect(titles(await f({ priority: { gte: 2, lt: 5 } }))).toEqual(['Bread', 'milkshake']);
    expect(titles(await f({ priority: { in: [1, 5] } }))).toEqual(['Milk', 'Tax return']);
    expect(titles(await f({ title: { contains: 'MILK' } }))).toEqual(['Milk', 'milkshake']);
    expect(titles(await f({ tags: { contains: 'shop' } }))).toEqual(['Bread', 'Milk']);
    expect(titles(await f({ priority: { gt: 'a' } }))).toEqual([]);
  });

  it('sort + keyset pagination walks every record exactly once (ties broken by id)', async () => {
    const { t } = await seed();
    for (const [sort, dir] of [['priority', 'asc'], ['priority', 'desc'], ['_created_at', 'asc'], ['title', 'desc'], ['_id', 'asc']] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const r = await q(t, { sort, dir, limit: '1', ...(cursor ? { cursor } : {}) });
        expect(r.status).toBe(200);
        const body = r.body as { records: Rec[]; next_cursor: string | null };
        seen.push(...body.records.map((x) => String(x.title)));
        cursor = body.next_cursor;
      } while (cursor);
      expect(seen.sort(), `${sort} ${dir}`).toEqual(['Bread', 'Milk', 'Tax return', 'milkshake']);
    }
    expect(titles(await q(t, { sort: 'priority', dir: 'desc', limit: '2' }))).toEqual(['Tax return', expect.any(String)]);
  });

  it('injection attempts are refused (400) and nothing is touched', async () => {
    const { t } = await seed();
    for (const query of <Record<string, string>[]>[
      { filter: JSON.stringify({ "title' OR '1'='1": 'x' }) },
      { filter: JSON.stringify({ title: { $ne: null } }) },
      { filter: JSON.stringify({ title: { eq: { $gt: '' } } }) },
      { filter: JSON.stringify({ secret: 1 }) },
      { filter: '{"title": "x"' },
      { sort: 'title; DROP TABLE mod_data_documents' },
      { sort: '_owner' },
      { dir: 'sideways' },
      { cursor: 'not-a-cursor' },
      { cursor: Buffer.from(JSON.stringify({ v: "1)) OR 1=1 --", i: 'x' })).toString('base64url') },
    ]) {
      const r = await q(t, query);
      expect(r.status, JSON.stringify(query)).toBe(400);
    }
    // A string value that looks like SQL is just a value.
    expect(titles(await q(t, { filter: JSON.stringify({ title: "x' OR '1'='1" }) }))).toEqual([]);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(dataRecords).where(sql`${dataRecords.appId} = ${appA}`);
    expect(n).toBe(4);
  });

  it('limit is bounded (≤ 200) and junk falls back to the default', async () => {
    const { t } = await seed();
    expect(titles(await q(t, { limit: '999' }))).toHaveLength(4);
    expect((await q(t, { limit: 'abc' })).status).toBe(200);
    expect((await q(t, { limit: '1234567' })).status).toBe(400);
  });
});

describe('cross-app isolation', () => {
  it("app B can never read, change or delete app A's records (same collection name, same id)", async () => {
    const rec = await create(ctx({ principal: ADMIN }), 'todos', { title: 'secret of A' });
    const b = ctx({ principal: ADMIN, app: appB });
    expect(((await b.request('GET', '/todos')).body as { records: Rec[] }).records).toEqual([]);
    expect((await b.request('GET', `/todos/${rec._id}`)).status).toBe(404);
    expect((await b.request('PATCH', `/todos/${rec._id}`, { body: { title: 'owned' } })).status).toBe(404);
    expect((await b.request('DELETE', `/todos/${rec._id}`)).status).toBe(404);
    const csv = await b.request('GET', '/todos/export.csv');
    expect(String(csv.body)).not.toContain('secret of A');
    // The owner's view of app B does not see it either.
    expect((await recordsAuthority.query(view(appB), { collection: 'todos' })).records).toEqual([]);
    expect(await recordsAuthority.get(view(appB), 'todos', rec._id)).toBeNull();
    expect(await recordsAuthority.remove(view(appB), 'todos', rec._id)).toBe(false);
    expect((await ctx({ principal: ADMIN }).request('GET', `/todos/${rec._id}`)).body).toMatchObject({ title: 'secret of A' });
  });
});

describe('CSV export', () => {
  it('admin only; the server fields + schema columns; formulas neutralized', async () => {
    await create(ctx({ principal: A }), 'todos', { title: '=1+1', done: false });
    expect((await ctx().request('GET', '/todos/export.csv')).status).toBe(401);
    expect((await ctx({ principal: A }).request('GET', '/todos/export.csv')).status).toBe(403);
    const t = ctx({ principal: ADMIN });
    const r = await t.request('GET', '/todos/export.csv');
    expect(r.status).toBe(200);
    expect(r.headers['content-type'] ?? r.headers['Content-Type']).toContain('text/csv');
    const lines = String(r.body).trimEnd().split('\r\n');
    expect(lines[0]).toBe('_id,_owner,_created_at,_updated_at,title,done,priority,tags');
    expect(lines[1]).toContain(",'=1+1,false,,");
    expect(lines[1]).not.toMatch(/,=1\+1/);
    expect(t.audits).toEqual([{ action: 'data.export', meta: { collection: 'todos', rows: 1 } }]);
  });

  it('a schemaless collection exports every key (sorted); the filter applies', async () => {
    const t = ctx({ principal: ADMIN });
    await create(t, 'guestbook', { text: 'a', mood: '@home' });
    await create(t, 'guestbook', { text: 'b', stars: 5 });
    const all = String((await t.request('GET', '/guestbook/export.csv')).body).trimEnd().split('\r\n');
    expect(all[0]).toBe('_id,_owner,_created_at,_updated_at,mood,stars,text');
    expect(all).toHaveLength(3);
    expect(all.some((l) => l.endsWith(",'@home,,a"))).toBe(true);
    const some = String((await t.request('GET', '/guestbook/export.csv', { query: { filter: JSON.stringify({ stars: 5 }) } })).body).trimEnd().split('\r\n');
    expect(some).toHaveLength(2);
  });
});

describe("the owner's view (records authority)", () => {
  it('collections with rules, columns and counts; query with a total; get; remove; csv', async () => {
    await create(ctx({ principal: A }), 'todos', { title: 'one', priority: 1 });
    const two = await create(ctx({ principal: B }), 'todos', { title: 'two', priority: 2 });
    const v = view();
    const cols = await recordsAuthority.collections(v);
    expect(cols.map((c) => c.name)).toEqual(['admins', 'guestbook', 'members', 'todos']);
    expect(cols.find((c) => c.name === 'todos')).toMatchObject({
      records: 2,
      rules: { read: 'owner|admin', create: 'user', update: 'owner|admin', delete: 'owner|admin' },
      columns: [{ key: 'title', required: true }, { key: 'done', required: false }, { key: 'priority', required: false }, { key: 'tags', required: false }],
    });
    expect(cols.find((c) => c.name === 'guestbook')).toMatchObject({ schema: null, columns: [], records: 0 });

    const page = await recordsAuthority.query(v, { collection: 'todos', filter: { priority: { gte: 2 } }, limit: 1 });
    expect(page.total).toBe(1);
    expect(page.records).toMatchObject([{ title: 'two', _owner: 'eu_b' }]);
    const all = await recordsAuthority.query(v, { collection: 'todos', sort: 'priority', dir: 'asc', limit: 1 });
    expect(all.total).toBe(2);
    expect(all.next_cursor).not.toBeNull();
    expect((await recordsAuthority.query(v, { collection: 'todos', sort: 'priority', dir: 'asc', limit: 1, cursor: all.next_cursor })).records[0].title).toBe('two');

    await expect(recordsAuthority.query(v, { collection: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(recordsAuthority.query(v, { collection: 'todos', filter: { secret: 1 } })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await recordsAuthority.get(v, 'todos', two._id)).toMatchObject({ title: 'two' });
    const lines: string[] = [];
    for await (const l of recordsAuthority.csv(v, { collection: 'todos' })) lines.push(l);
    expect(lines).toHaveLength(3);
    expect(await recordsAuthority.remove(v, 'todos', two._id)).toBe(true);
    expect(await recordsAuthority.get(v, 'todos', two._id)).toBeNull();
  });
});

describe("the owner's edits (records authority, M2-03)", () => {
  beforeEach(() => {
    viewLimits = {};
  });

  it('update replaces the own fields (validated, _owner kept); a missing record → null; a bad one → validation_failed', async () => {
    const rec = await create(ctx({ principal: A }), 'todos', { title: 'one', priority: 1, tags: ['x'] });
    const v = view();
    const updated = await recordsAuthority.update!(v, 'todos', rec._id, { title: 'uno', done: true, _owner: 'spoof', _id: 'x' });
    expect(updated).toMatchObject({ _id: rec._id, _owner: 'eu_a', title: 'uno', done: true });
    expect(updated).not.toHaveProperty('priority');
    expect(await recordsAuthority.update!(v, 'todos', 'missing', { title: 'x' })).toBeNull();
    await expect(recordsAuthority.update!(v, 'todos', rec._id, { done: 'yes' })).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await recordsAuthority.get(v, 'todos', rec._id)).toMatchObject({ title: 'uno' });
    await expect(recordsAuthority.update!(v, 'nope', rec._id, {})).rejects.toMatchObject({ code: 'not_found' });
  });

  it('importCsv: typed cells from the schema, _… columns ignored, formula guards undone, file order = creation order', async () => {
    const v = view();
    const csv = ['_id,title,done,priority,tags', "x1,first,true,'-2,\"[\"\"a\"\"]\"", 'x2,\"second, with comma\",FALSE,,', ''].join('\r\n');
    expect(await recordsAuthority.importCsv!(v, 'todos', csv)).toEqual({ imported: 2 });
    const page = await recordsAuthority.query(v, { collection: 'todos', dir: 'asc' });
    expect(page.records).toMatchObject([
      { title: 'first', done: true, priority: -2, tags: ['a'], _owner: null },
      { title: 'second, with comma', done: false },
    ]);
    expect(page.records[0]._id).not.toBe('x1');
    expect(page.records[1]).not.toHaveProperty('priority');
  });

  it('importCsv: one invalid row → its line reported, nothing stored (all or nothing)', async () => {
    const v = view();
    const csv = ['title,priority', 'ok,1', 'fine,2', ',3', 'never,4'].join('\n');
    await expect(recordsAuthority.importCsv!(v, 'todos', csv)).rejects.toMatchObject({
      code: 'validation_failed',
      message: expect.stringMatching(/^Line 4: /),
      details: { line: 4 },
    });
    const wrongWidth = ['title,priority', 'ok,1', 'too,many,cells'].join('\n');
    await expect(recordsAuthority.importCsv!(v, 'todos', wrongWidth)).rejects.toMatchObject({ code: 'validation_failed', details: { line: 3 } });
    const badQuote = ['title', '"open'].join('\n');
    await expect(recordsAuthority.importCsv!(v, 'todos', badQuote)).rejects.toMatchObject({ code: 'invalid_request', details: { line: 2 } });
    expect((await recordsAuthority.query(v, { collection: 'todos' })).total).toBe(0);
  });

  it(`importCsv: ${RECORDS_IMPORT_MAX_ROWS} rows import; ${RECORDS_IMPORT_MAX_ROWS + 1} are refused before any write`, async () => {
    const v = view(appA, dataConfigSchema.parse(CONFIG));
    viewLimits = { DATA_MAX_DOCS_PER_APP: 20_000 };
    const rows = (n: number) => ['title', ...Array.from({ length: n }, (_, i) => `t${i}`)].join('\n');
    await expect(recordsAuthority.importCsv!(v, 'guestbook', rows(RECORDS_IMPORT_MAX_ROWS + 1))).rejects.toMatchObject({
      code: 'payload_too_large',
      details: { limit: 'RECORDS_IMPORT_MAX_ROWS', value: RECORDS_IMPORT_MAX_ROWS },
    });
    expect((await recordsAuthority.query(v, { collection: 'guestbook' })).total).toBe(0);
    expect(await recordsAuthority.importCsv!(v, 'guestbook', rows(RECORDS_IMPORT_MAX_ROWS))).toEqual({ imported: RECORDS_IMPORT_MAX_ROWS });
    expect((await recordsAuthority.query(v, { collection: 'guestbook' })).total).toBe(RECORDS_IMPORT_MAX_ROWS);
  });

  it('importCsv respects the quota as a whole batch (nothing stored past it); a record over DATA_MAX_DOC_BYTES names its line', async () => {
    await create(ctx({ principal: A }), 'todos', { title: 'already' });
    viewLimits = { DATA_MAX_DOCS_PER_APP: 3, DATA_MAX_DOC_BYTES: 40 };
    const v = view();
    await expect(recordsAuthority.importCsv!(v, 'todos', 'title\na\nb\nc')).rejects.toMatchObject({ code: 'quota_exceeded' });
    await expect(recordsAuthority.importCsv!(v, 'todos', `title\nshort\n${'x'.repeat(60)}`)).rejects.toMatchObject({
      code: 'validation_failed',
      details: { line: 3 },
    });
    expect((await recordsAuthority.query(v, { collection: 'todos' })).total).toBe(1);
    expect(await recordsAuthority.importCsv!(v, 'todos', 'title\na\nb')).toEqual({ imported: 2 });
  });

  it('dropCollection deletes the records of that collection only and returns the config patch', async () => {
    await create(ctx({ principal: A }), 'todos', { title: 'gone' });
    await create(ctx({ principal: A }), 'guestbook', { text: 'stays' });
    const other = await create(ctx({ principal: A, app: appB }), 'todos', { title: 'other app' });
    const out = await recordsAuthority.dropCollection!(view(), 'todos');
    expect(out).toEqual({ records: 1, configPatch: { collections: { todos: null } } });
    expect((await recordsAuthority.query(view(), { collection: 'guestbook' })).total).toBe(1);
    expect(await recordsAuthority.get(view(appB), 'todos', other._id)).toMatchObject({ title: 'other app' });
    await expect(recordsAuthority.dropCollection!(view(), 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('the legacy Data API import (module migration 0000)', () => {
  it('collections → the data config with mapped rules; live documents → records; old tables dropped', async () => {
    const [row] = await db.select().from(moduleConfigs).where(sql`${moduleConfigs.appId} = ${legacyApp} AND ${moduleConfigs.module} = 'data'`);
    const config = dataConfigSchema.parse(row.config);
    expect(Object.keys(config.collections).sort()).toEqual(['board', 'mine', 'vault', 'wall']);
    expect(config.collections.board.rules).toEqual({ read: 'public', create: 'admin', update: 'admin', delete: 'admin' });
    expect(config.collections.wall.rules).toEqual({ read: 'public', create: 'public', update: 'admin', delete: 'admin' });
    expect(config.collections.vault.rules).toEqual({ read: 'admin', create: 'admin', update: 'admin', delete: 'admin' });
    expect(config.collections.mine.rules).toEqual({ read: 'owner|admin', create: 'user', update: 'owner|admin', delete: 'owner|admin' });
    expect(config.collections.wall.schema).toMatchObject({ required: ['title'] });

    const records = await db.select().from(dataRecords).where(sql`${dataRecords.appId} = ${legacyApp}`);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: 'doc_live', collection: 'wall', ownerId: null, doc: { title: 'hello' } });
    expect(records[0].createdAt.toISOString()).toBe('2026-01-02T03:04:05.000Z');

    const left = await pg.query<{ t: string | null }>(`SELECT to_regclass('public.collections')::text AS t UNION ALL SELECT to_regclass('public.app_documents')::text`);
    expect(left.rows.map((r) => r.t)).toEqual([null, null]);
    const type = await pg.query(`SELECT 1 FROM pg_type WHERE typname = 'collection_access_mode'`);
    expect(type.rows).toHaveLength(0);

    // Re-running the migration file is a no-op (every statement is guarded).
    const { readFileSync } = await import('node:fs');
    const file = readFileSync(fileURLToPath(new URL('../migrations/0000_data_documents.sql', import.meta.url)), 'utf8');
    for (const statement of file.split('--> statement-breakpoint')) await pg.exec(statement);
    const [again] = await db.select().from(moduleConfigs).where(sql`${moduleConfigs.appId} = ${legacyApp} AND ${moduleConfigs.module} = 'data'`);
    expect(again.config).toEqual(row.config);
    expect(await db.select().from(dataRecords).where(sql`${dataRecords.appId} = ${legacyApp}`)).toHaveLength(1);

    // Served through the module like any record.
    const t = createModuleTestContext(data, { db, app: { id: legacyApp, slug: 'legacy', workspaceId }, config: row.config as Record<string, unknown> });
    const r = await t.request('GET', '/wall');
    expect(r.status).toBe(200);
    expect((r.body as { records: Rec[] }).records).toMatchObject([{ _id: 'doc_live', title: 'hello', _owner: null }]);
  });
});
