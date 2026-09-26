/**
 * The hello module under createModuleTestContext(): real routes through the
 * production pipeline, a PGlite database with the core + hello migrations —
 * set up exactly like a create-drobek-module scaffold (no other drobek package).
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSdk, collectContributions, defineModule, isDefinedModule, loadModules, z, type DB } from '@drobek/modules';
import { coreMigrationsDir, createModuleTestContext, createTestApp } from '@drobek/modules/testing';
import hello from './index.js';

let pg: PGlite;
let db: DB;
let appId: string;

beforeAll(async () => {
  pg = new PGlite();
  const d = drizzle(pg);
  await migrate(d, { migrationsFolder: coreMigrationsDir(), migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  await migrate(d, { migrationsFolder: hello.migrations!.folder, migrationsTable: '__drizzle_migrations_mod_hello', migrationsSchema: 'drizzle' });
  appId = (await createTestApp(d, { slug: 'hello-app' })).id;
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

  it('declares contract ^1.1, the slot hello.greeter and its own error code', () => {
    expect(hello.contract).toBe('^1.1');
    expect(Object.keys(hello.slots ?? {})).toEqual(['hello.greeter']);
    expect(hello.errors?.map((e) => e.code)).toEqual(['unknown_greeter']);
  });

  it('another module contributes a greeter: validated by the slot schema, unique by id', async () => {
    const base = { version: '1.0.0', contract: '^1.1', skill: { useWhen: 'x', markdown: '# x' }, configSchema: z.object({}), configDefaults: {} };
    const pirate = defineModule({ ...base, name: 'pirate', contributes: { 'hello.greeter': { id: 'pirate', greet: (n: string) => `Ahoy, ${n}!` } } });
    const mods = await loadModules(
      { DROBEK_MODULES: 'hello,pirate' },
      { importer: async (pkg) => ({ 'drobek-module-hello': hello, 'drobek-module-pirate': pirate })[pkg] ?? null }
    );
    expect(collectContributions(mods).get('hello.greeter')!.map((c) => c.module)).toEqual(['pirate']);
    const broken = defineModule({ ...base, name: 'broken', contributes: { 'hello.greeter': { id: 'Broken!', greet: 'hi' } } });
    expect(() => collectContributions([hello, broken])).toThrow(/does not pass the slot's schema/);
  });

  it('GET /greet uses the config greeting, or a contributed greeter; an unknown one is unknown_greeter', async () => {
    const t = createModuleTestContext(hello, { contributions: { 'hello.greeter': [{ id: 'pirate', greet: (n: string) => `Ahoy, ${n}!` }] } });
    expect((await t.request('GET', '/greet', { query: { name: 'Ada' } })).body).toEqual({ text: 'Hello, Ada', greeter: null });
    expect((await t.request('GET', '/greet', { query: { name: 'Ada', greeter: 'pirate' } })).body).toEqual({ text: 'Ahoy, Ada!', greeter: 'pirate' });
    const unknown = await t.request('GET', '/greet', { query: { name: 'Ada', greeter: 'robot' } });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: 'unknown_greeter', details: { available: ['pirate'] }, hint: "skill_info('hello')" });
  });

  it('GET / greets with the config and counts waves', async () => {
    const t = createModuleTestContext(hello, { db, app: { id: appId }, config: { greeting: 'Ahoj', excited: true } });
    const res = await t.request('GET', '/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ greeting: 'Ahoj', message: 'Ahoj!', waves: 0, signed: false });
  });

  it('GET /whoami reports ctx.principal (anon, or the signed-in end user with the role)', async () => {
    const t = createModuleTestContext(hello, { db, app: { id: appId } });
    expect((await t.request('GET', '/whoami')).body).toEqual({ signed_in: false });
    t.setPrincipal({ kind: 'user', id: 'eu_1', email: 'ana@example.com', role: 'admin' });
    expect((await t.request('GET', '/whoami')).body).toEqual({ signed_in: true, id: 'eu_1', email: 'ana@example.com', role: 'admin' });
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

  it('a greeting change needs confirmation; excited does not', async () => {
    const t = createModuleTestContext(hello);
    expect(await t.confirm({}, { excited: true })).toEqual([]);
    expect(await t.confirm({}, { greeting: 'Ahoj' })).toEqual(['greeting: "Hello" → "Ahoj"']);
  });

  it('bundles into the SDK as drobek.hello with ping() + wave()', async () => {
    const sdk = await buildSdk([hello]);
    const js = sdk.js.toString('utf8');
    expect(js).toContain('"hello"');
    expect(js).toContain('/wave');
    expect(sdk.dts).toContain('readonly hello: hello.Api;');
    expect(sdk.dts).toContain('ping(): Promise<Hello>;');
    expect(sdk.dts).toContain('whoami(): Promise<Visitor>;');
    expect(js).toContain('/whoami');
    expect(js).toContain('/greet');
    expect(sdk.dts).toContain('greet(name: string, greeter?: string)');
  });
});
