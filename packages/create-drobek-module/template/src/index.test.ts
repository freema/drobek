/**
 * The module under createModuleTestContext(): its routes run through the
 * SAME pipeline production uses (rule, CSRF, rate limit, body validation,
 * uniform errors), over PGlite with the drobek core + module migrations.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DB, HookApp } from '@drobek/modules';
import { coreMigrationsDir, createModuleTestContext, createTestApp } from '@drobek/modules/testing';
import mod from './index.js';

let pg: PGlite;
let db: DB;
let app: HookApp;

beforeAll(async () => {
  pg = new PGlite();
  const d = drizzle(pg);
  await migrate(d, { migrationsFolder: coreMigrationsDir(), migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  await migrate(d, { migrationsFolder: mod.migrations!.folder, migrationsTable: '__drizzle_migrations_mod_{{module}}', migrationsSchema: 'drizzle' });
  app = await createTestApp(d);
  db = d as unknown as DB;
});

afterAll(async () => {
  await pg.close();
});

describe('{{package}}', () => {
  it('declares the module contract it is written against', () => {
    expect(mod.name).toBe('{{module}}');
    expect(mod.contract).toBe('^1.1');
  });

  it('POST /items adds an item, GET /items lists the newest first', async () => {
    const t = createModuleTestContext(mod, { db, app });
    expect((await t.request('GET', '/items')).body).toEqual({ items: [], upstream: false });
    const first = await t.request('POST', '/items', { body: { title: 'First' } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ id: expect.any(Number), title: 'First' });
    await t.request('POST', '/items', { body: { title: 'Second' } });
    const list = (await t.request('GET', '/items')).body as { items: { title: string }[] };
    expect(list.items.map((i) => i.title)).toEqual(['Second', 'First']);
    expect(t.audits.map((a) => a.action)).toEqual(['{{module}}.add', '{{module}}.add']);
  });

  it('validates the body with a field path', async () => {
    const t = createModuleTestContext(mod, { db, app });
    const bad = await t.request('POST', '/items', { body: { title: '' } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'invalid_request', details: [{ path: 'title' }] });
  });

  it('write: "user" lets only signed-in end users add', async () => {
    const t = createModuleTestContext(mod, { db, app, config: { write: 'user' } });
    expect((await t.request('POST', '/items', { body: { title: 'x' } })).status).toBe(401);
    t.setPrincipal({ kind: 'user', id: 'eu_1', email: 'ana@example.com', role: 'user' });
    expect((await t.request('POST', '/items', { body: { title: 'x' } })).status).toBe(200);
  });

  it('answers its own error code {{module}}_full past maxItems', async () => {
    const other = await createTestApp(db);
    const t = createModuleTestContext(mod, { db, app: other, config: { maxItems: 1 } });
    expect((await t.request('POST', '/items', { body: { title: 'a' } })).status).toBe(200);
    const full = await t.request('POST', '/items', { body: { title: 'b' } });
    expect(full.status).toBe(409);
    expect(full.body).toMatchObject({ error: '{{module}}_full', details: { max: 1 } });
  });

  it('enforces {{MODULE}}_ADDS_PER_MINUTE (429)', async () => {
    const t = createModuleTestContext(mod, { db, app, limits: { {{MODULE}}_ADDS_PER_MINUTE: 1 } });
    expect((await t.request('POST', '/items', { body: { title: 'a' } })).status).toBe(200);
    expect((await t.request('POST', '/items', { body: { title: 'b' } })).body).toMatchObject({ error: 'rate_limited' });
  });

  it('reads its secret without returning it', async () => {
    const t = createModuleTestContext(mod, { db, app, secrets: { {{MODULE}}_API_KEY: 'k-123456' } });
    const res = await t.request('GET', '/items');
    expect(res.body).toMatchObject({ upstream: true });
    expect(JSON.stringify(res.body)).not.toContain('k-123456');
  });

  it('opening write to everyone needs the owner\'s confirmation', async () => {
    const t = createModuleTestContext(mod);
    expect(await t.confirm({ write: 'user' }, { write: 'public' })).toEqual(['write: anyone may add items']);
    expect(await t.confirm({}, { maxItems: 5 })).toEqual([]);
  });
});
