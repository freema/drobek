/**
 * The module under createModuleTestContext(): its routes run through the
 * SAME pipeline production uses (rule, CSRF, body validation, uniform
 * errors), over PGlite with the drobek core + module migrations.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DB, HookApp, Logger } from '@drobek/modules';
import { coreMigrationsDir, createModuleTestContext, createTestApp } from '@drobek/modules/testing';
import mod, { signInObserver } from './index.js';

let pg: PGlite;
let db: DB;
let app: HookApp;

const ANA = { kind: 'user', id: 'eu_1', email: 'ana@example.com', role: 'user' } as const;
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

beforeAll(async () => {
  pg = new PGlite();
  const d = drizzle(pg);
  await migrate(d, { migrationsFolder: coreMigrationsDir(), migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  await migrate(d, { migrationsFolder: mod.migrations!.folder, migrationsTable: '__drizzle_migrations_mod_acmecrm', migrationsSchema: 'drizzle' });
  app = await createTestApp(d);
  db = d as unknown as DB;
});

afterAll(async () => {
  await pg.close();
});

describe('drobek-module-acme-crm', () => {
  it('declares an opt-in module on the current contract with its slot contribution, error, limit and secret', () => {
    expect(mod).toMatchObject({ name: 'acmecrm', contract: '^1.2', availability: 'opt-in', requires: ['auth'] });
    expect(Object.keys(mod.contributes ?? {})).toEqual(['auth.signedIn']);
    expect(mod.errors?.map((e) => e.code)).toEqual(['crm_duplicate']);
    expect(mod.limits?.map((l) => l.env)).toEqual(['ACMECRM_CONTACTS_PER_APP']);
    expect(mod.secrets?.map((s) => s.name)).toEqual(['ACMECRM_API_KEY']);
  });

  it('only signed-in end users read or add contacts', async () => {
    const t = createModuleTestContext(mod, { db, app });
    expect((await t.request('GET', '/')).status).toBe(401);
    expect((await t.request('POST', '/', { body: { email: 'x@example.com' } })).status).toBe(401);
  });

  it('POST / adds a contact with the config tags, GET / lists the newest first', async () => {
    const t = createModuleTestContext(mod, { db, app, config: { tags: ['newsletter'] } });
    t.setPrincipal(ANA);
    const first = await t.request('POST', '/', { body: { email: 'Bob@Example.com', name: 'Bob' } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ email: 'bob@example.com', name: 'Bob', source: 'app', tags: ['newsletter'], fields: {} });
    await t.request('POST', '/', { body: { email: 'cyril@example.com' } });
    const list = (await t.request('GET', '/')).body as { contacts: { email: string }[]; upstream: boolean };
    expect(list.contacts.map((c) => c.email)).toEqual(['cyril@example.com', 'bob@example.com']);
    expect(list.upstream).toBe(false);
    expect(t.audits.map((a) => a.action)).toEqual(['acmecrm.add', 'acmecrm.add']);
  });

  it('an address the app has already is crm_duplicate (409, details.email)', async () => {
    const t = createModuleTestContext(mod, { db, app });
    t.setPrincipal(ANA);
    const dup = await t.request('POST', '/', { body: { email: 'BOB@example.com' } });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ error: 'crm_duplicate', details: { email: 'bob@example.com' }, hint: "skill_info('acmecrm')" });
  });

  it('checks the custom fields against the config and the address with a field path', async () => {
    const t = createModuleTestContext(mod, { db, app, config: { fields: { company: { label: 'Company', required: true } } } });
    t.setPrincipal(ANA);
    const missing = await t.request('POST', '/', { body: { email: 'dana@example.com', fields: { team: 'x' } } });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ error: 'invalid_request', details: [{ path: 'fields.team' }, { path: 'fields.company' }] });
    const bad = await t.request('POST', '/', { body: { email: 'not-an-address' } });
    expect(bad.body).toMatchObject({ error: 'invalid_request', details: [{ path: 'email' }] });
    const ok = await t.request('POST', '/', { body: { email: 'dana@example.com', fields: { company: 'Acme' } } });
    expect(ok.body).toMatchObject({ fields: { company: 'Acme' } });
  });

  it('enforces ACMECRM_CONTACTS_PER_APP (quota_exceeded)', async () => {
    const other = await createTestApp(db);
    const t = createModuleTestContext(mod, { db, app: other, limits: { ACMECRM_CONTACTS_PER_APP: 1 } });
    t.setPrincipal(ANA);
    expect((await t.request('POST', '/', { body: { email: 'a@example.com' } })).status).toBe(200);
    const over = await t.request('POST', '/', { body: { email: 'b@example.com' } });
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ error: 'quota_exceeded', details: { limit: 'ACMECRM_CONTACTS_PER_APP', max: 1 } });
  });

  it('reads its secret without returning it', async () => {
    const t = createModuleTestContext(mod, { db, app, secrets: { ACMECRM_API_KEY: 'k-123456' } });
    t.setPrincipal(ANA);
    const res = await t.request('GET', '/');
    expect(res.body).toMatchObject({ upstream: true });
    expect(JSON.stringify(res.body)).not.toContain('k-123456');
  });

  it('the auth.signedIn observer records every signed-in user once (source sign-in)', async () => {
    const other = await createTestApp(db);
    const event = { app: other, user: { id: 'eu_9', email: 'erin@example.com', role: 'user' as const, name: 'Erin' }, provider: 'oidc', isNew: true, db, log: silent };
    await signInObserver.onSignIn(event);
    await signInObserver.onSignIn({ ...event, isNew: false });
    const t = createModuleTestContext(mod, { db, app: other });
    t.setPrincipal(ANA);
    const list = (await t.request('GET', '/')).body as { contacts: { email: string; name: string; source: string }[] };
    expect(list.contacts).toEqual([expect.objectContaining({ email: 'erin@example.com', name: 'Erin', source: 'sign-in', tags: [] })]);
  });
});
