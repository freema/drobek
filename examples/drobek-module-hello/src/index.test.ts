/**
 * The hello module under createModuleTestContext(): real routes through the
 * production pipeline, a PGlite database with the core + hello migrations.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apps, workspaces, type DB } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import { buildSdk, isDefinedModule, loadModules } from '@drobek/modules';
import { createModuleTestContext } from '@drobek/modules/testing';
import hello from './index.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../../packages/db/drizzle/migrations', import.meta.url));

let pg: PGlite;
let db: DB;
let appId: string;

beforeAll(async () => {
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  await migrate(d, {
    migrationsFolder: hello.migrations!.folder,
    migrationsTable: '__drizzle_migrations_mod_hello',
    migrationsSchema: 'drizzle',
  });
  const [ws] = await d.insert(workspaces).values({ kind: 'team', slug: 'hello-ws', name: 'Hello' }).returning();
  const [app] = await d.insert(apps).values({ workspaceId: ws.id, slug: 'hello-app' }).returning();
  appId = app.id;
  db = d as unknown as DB;
});

afterAll(async () => {
  await pg.close();
});

describe('drobek-module-hello', () => {
  it('is a defined module the registry accepts by its short name', async () => {
    expect(isDefinedModule(hello)).toBe(true);
    const mods = await loadModules({ DROBEK_MODULES: 'hello' }, { importer: async (pkg) => (pkg === 'drobek-module-hello' ? { default: hello } : null) });
    expect(mods.map((m) => m.name)).toEqual(['hello']);
  });

  it('GET / greets with the config and counts waves', async () => {
    const t = createModuleTestContext(hello, { db, app: { id: appId }, config: { greeting: 'Ahoj', excited: true } });
    const res = await t.request('GET', '/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ greeting: 'Ahoj', message: 'Ahoj!', waves: 0, signed: false });
  });

  it('POST /wave stores a wave; the body is validated with a field path', async () => {
    const t = createModuleTestContext(hello, { db, app: { id: appId } });
    expect((await t.request('POST', '/wave', { body: { name: 'Ada' } })).body).toEqual({ waves: 1 });
    const bad = await t.request('POST', '/wave', { body: { name: '' } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'invalid_request', details: [{ path: 'name' }], hint: "skill_info('hello')" });
  });

  it('enforces HELLO_WAVES_PER_MINUTE (429 + Retry-After)', async () => {
    const t = createModuleTestContext(hello, { db, app: { id: appId }, limits: { HELLO_WAVES_PER_MINUTE: 1 } });
    expect((await t.request('POST', '/wave', { body: { name: 'A' } })).status).toBe(200);
    const res = await t.request('POST', '/wave', { body: { name: 'B' } });
    expect(res.status).toBe(429);
    expect(res.headers['Retry-After']).toBeDefined();
    expect(res.body).toMatchObject({ error: 'rate_limited' });
  });

  it('rejects a cross-origin wave and one without the SDK header', async () => {
    const t = createModuleTestContext(hello, { db, app: { id: appId } });
    const foreign = await t.request('POST', '/wave', { body: { name: 'A' }, headers: { origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
    expect(foreign.body).toMatchObject({ error: 'csrf_rejected' });
    const noSdk = await t.request('POST', '/wave', { body: { name: 'A' }, headers: { 'x-drobek-sdk': '' } });
    expect(noSdk.status).toBe(403);
  });

  it('signs the message when HELLO_SIGNATURE is set — never returning the secret', async () => {
    const t = createModuleTestContext(hello, { db, app: { id: appId }, secrets: { HELLO_SIGNATURE: 'top-secret-signing-key' } });
    const res = await t.request('GET', '/');
    expect(res.body).toMatchObject({ signed: true, signature: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(JSON.stringify(res.body)).not.toContain('top-secret-signing-key');
  });

  it('a greeting change needs confirmation; excited does not', () => {
    const base = hello.configDefaults;
    expect(hello.confirmRequired!(base, { ...base, excited: true })).toEqual([]);
    expect(hello.confirmRequired!(base, { ...base, greeting: 'Ahoj' })).toEqual(['greeting: "Hello" → "Ahoj"']);
  });

  it('bundles into the SDK as drobek.hello with ping() + wave()', async () => {
    const sdk = await buildSdk([hello]);
    const js = sdk.js.toString('utf8');
    expect(js).toContain('"hello"');
    expect(js).toContain('/wave');
    expect(sdk.dts).toContain('readonly hello: hello.Api;');
    expect(sdk.dts).toContain('ping(): Promise<Hello>;');
  });
});
