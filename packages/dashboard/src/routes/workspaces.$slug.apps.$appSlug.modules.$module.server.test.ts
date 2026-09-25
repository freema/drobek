/**
 * The module page's loader + action (M2-02, NSO-291) against a real PGlite
 * database and a real ModuleRuntime (test modules; the workspace role gate is
 * stubbed — requireWorkspaceRole has its own tests in @drobek/tenancy):
 * form errors per field, pending via the configure path + confirm with audit,
 * write-only secrets (the value in no response, loader data or audit row),
 * the data collections editor, a viewer refused before anything changes.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { apps, auditLog, moduleConfigs, moduleSecrets, setDbForTests, users, workspaces } from '@drobek/db';
import { noopLogger } from '@drobek/core';
import {
  defineModule,
  loadModuleRuntime,
  memoryMailGuard,
  memoryRateLimiter,
  setModuleRuntimeForTests,
  z,
  type ModuleRuntime,
} from '@drobek/modules';
import { fieldName, ruleInputName } from '../module-config.js';

const role = vi.hoisted(() => ({ current: 'editor' as 'viewer' | 'editor' | 'workspace-admin', user: { id: '', email: 'owner@example.com' }, ws: { id: '', slug: 'acme', name: 'Acme' } }));

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

// Imported after the mock is registered (vi.mock is hoisted anyway).
const { loader, action } = await import('./workspaces.$slug.apps.$appSlug.modules.$module.server.js');

const SECRET_VALUE = 'sk-live-NEVER-RENDER-ME-0123456789abcdef';
const ENV = {
  APPS_DOMAIN: 'apps.example',
  PUBLIC_APP_URL: 'https://drobek.example',
  PUBLIC_ORIGIN: 'https://drobek.example',
  DROBEK_MASTER_KEY: '33'.repeat(32),
  DROBEK_MIGRATE_ON_START: '0',
};

const shop = defineModule<{ greeting: string; access: 'public' | 'user'; loud: boolean }>({
  name: 'shop',
  version: '1.0.0',
  skill: { useWhen: 'you sell things', markdown: '# shop' },
  configSchema: z.strictObject({ greeting: z.string().trim().min(1).max(20), access: z.enum(['public', 'user']), loud: z.boolean() }),
  configDefaults: { greeting: 'Hi', access: 'user', loud: false },
  confirmRequired: (b, a) => (a.access === 'public' && b.access !== 'public' ? ['access: "user" → "public" (anyone may buy)'] : []),
  secrets: [{ name: 'SHOP_KEY', description: 'The payment key', required: true }],
});

const rule = z.string().regex(/^(public|user|owner|admin|none)(\|(public|user|owner|admin|none))*$/);
const data = defineModule<{ collections: Record<string, { schema?: Record<string, unknown>; rules: Record<string, string> }> }>({
  name: 'data',
  version: '1.0.0',
  skill: { useWhen: 'you store records', markdown: '# data' },
  configSchema: z.strictObject({
    collections: z
      .record(
        z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
        z.strictObject({
          schema: z.record(z.string(), z.unknown()).refine((s) => s.type === 'object', 'schema.type must be "object"').optional(),
          rules: z
            .strictObject({ read: rule.default('owner|admin'), create: rule.default('user'), update: rule.default('owner|admin'), delete: rule.default('owner|admin') })
            .default({ read: 'owner|admin', create: 'user', update: 'owner|admin', delete: 'owner|admin' }),
        })
      )
      .default({}),
  }),
  configDefaults: { collections: {} },
  confirmRequired: (b, a) =>
    Object.entries(a.collections).flatMap(([n, c]) =>
      c.rules.create.includes('public') && !b.collections[n]?.rules.create.includes('public') ? [`data.collections.${n}.rules.create: → "public"`] : []
    ),
  rules: { ops: { read: 'List', create: 'Add', update: 'Change', delete: 'Delete' } },
});

const proxy = defineModule<{ upstreams: Record<string, { rules: { call: string }; rateLimit?: number }> }>({
  name: 'proxy',
  version: '1.0.0',
  skill: { useWhen: 'you call an API', markdown: '# proxy' },
  configSchema: z.strictObject({
    upstreams: z
      .record(
        z.string(),
        z.strictObject({
          rules: z.strictObject({ call: rule.default('user') }).default({ call: 'user' }),
          rateLimit: z.int().min(1).max(10_000).optional(),
        })
      )
      .default({}),
  }),
  configDefaults: { upstreams: {} },
  // Like the real proxy module: assignments need a workspace ADMIN (NSO-322 H3).
  confirmRequired: (b, a) =>
    Object.keys(a.upstreams)
      .filter((n) => !b.upstreams[n])
      .map((n) => ({ change: `proxy.upstreams.${n}: this app may call the workspace upstream "${n}" with its secret`, confirmRole: 'admin' as const })),
  rules: { ops: { call: 'Call an assigned upstream' } },
  appInfo: ({ config }) => ({
    upstreams: [
      { name: 'weather', registered: true, assigned: Boolean(config.upstreams.weather), hasSecret: true, allowedMethods: ['GET'], allowedPathPrefixes: ['/v1/'] },
    ],
  }),
});

let pg: PGlite;
let rt: ModuleRuntime;
let appId: string;
let savedKey: string | undefined;

function req(module: string, body?: Record<string, string>): Request {
  const url = `https://drobek.example/workspaces/acme/apps/shop-app/modules/${module}`;
  return body ? new Request(url, { method: 'POST', body: new URLSearchParams(body) }) : new Request(url);
}

const params = (module: string) => ({ slug: 'acme', appSlug: 'shop-app', module });

async function load(module = 'shop') {
  return loader({ request: req(module), params: params(module), context: {} } as never);
}

async function post(module: string, body: Record<string, string>) {
  return action({ request: req(module, body), params: params(module), context: {} } as never);
}

/** A redirect Response's `done` parameter. */
function doneOf(res: unknown): string | null {
  expect(res).toBeInstanceOf(Response);
  const r = res as Response;
  expect(r.status).toBe(302);
  return new URL(r.headers.get('location') ?? '', 'https://x').searchParams.get('done');
}

/** The body of a `data(…, { status })` result. */
function failed(res: unknown): { status: number; errors: { intent: string; fields: Record<string, string[]>; general: string[]; values?: Record<string, unknown> } } {
  const d = res as { data: { errors: never }; init: { status: number } };
  return { status: d.init?.status, errors: d.data.errors };
}

beforeAll(async () => {
  savedKey = process.env.DROBEK_MASTER_KEY;
  process.env.DROBEK_MASTER_KEY = ENV.DROBEK_MASTER_KEY;
  pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../../db/drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db);
  const [u] = await db.insert(users).values({ email: 'owner@example.com' }).returning();
  role.user = { id: u.id, email: u.email };
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
  role.ws = { id: w.id, slug: w.slug, name: w.name };
  const [a] = await db.insert(apps).values({ workspaceId: w.id, slug: 'shop-app', name: 'Shop' }).returning();
  appId = a.id;
  rt = await loadModuleRuntime({
    env: ENV,
    log: noopLogger,
    modules: [shop, data, proxy],
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
  const db = drizzleDb();
  await db.delete(moduleConfigs);
  await db.delete(moduleSecrets);
  await db.delete(auditLog);
});

function drizzleDb() {
  return drizzle(pg, { schema });
}

describe('the module page (M2-02)', () => {
  it('loader: the generated form, the secrets as status only, the banner; unknown module / app → 404', async () => {
    const d = await load();
    expect(d.module).toMatchObject({ name: 'shop', confirms: true });
    expect(d.fields.map((f) => [f.path, f.kind])).toEqual([
      ['greeting', 'string'],
      ['access', 'enum'],
      ['loud', 'boolean'],
    ]);
    expect(d.values).toEqual({ greeting: 'Hi', access: 'user', loud: false });
    expect(d.pending).toBeNull();
    expect(d.secrets).toEqual([{ name: 'SHOP_KEY', description: 'The payment key', required: true, hasSecret: false, updatedAt: null }]);
    expect(d.banner).toMatchObject({ count: 0 });
    expect(d.canEdit).toBe(true);
    await expect(load('nope')).rejects.toMatchObject({ init: { status: 404 } });
  });

  it('save-config: out-of-schema input → 400 with the error at the field (nothing stored); a safe change applies', async () => {
    const bad = failed(await post('shop', { intent: 'save-config', [fieldName('greeting')]: '', [fieldName('access')]: 'user' }));
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.errors.fields)).toEqual(['greeting']);
    expect(bad.errors.values).toMatchObject({ greeting: '', access: 'user', loud: false });
    expect(await drizzleDb().select().from(moduleConfigs)).toEqual([]);

    const tooLong = failed(await post('shop', { intent: 'save-config', [fieldName('greeting')]: 'x'.repeat(21), [fieldName('access')]: 'user' }));
    expect(tooLong.errors.fields.greeting?.[0]).toMatch(/20/);

    expect(doneOf(await post('shop', { intent: 'save-config', [fieldName('greeting')]: 'Ahoj', [fieldName('access')]: 'user', [fieldName('loud')]: 'on' }))).toBe('applied');
    expect((await load()).values).toEqual({ greeting: 'Ahoj', access: 'user', loud: true });
    const rows = await drizzleDb().select().from(auditLog);
    expect(rows.map((r) => [r.action, r.actorKind])).toEqual([['module.configure', 'user']]);
    expect(doneOf(await post('shop', { intent: 'save-config', [fieldName('greeting')]: 'Ahoj', [fieldName('access')]: 'user', [fieldName('loud')]: 'on' }))).toBe('unchanged');
  });

  it('a relaxation becomes pending (diff + risk note + banner); confirm applies it with the audit row', async () => {
    expect(doneOf(await post('shop', { intent: 'save-config', [fieldName('greeting')]: 'Hi', [fieldName('access')]: 'public' }))).toBe('pending');
    const d = await load();
    expect(d.values.access).toBe('user'); // still in force
    expect(d.pending).toMatchObject({
      changes: [{ text: 'access: "user" → "public" (anyone may buy)', risk: expect.stringMatching(/anyone on the internet/) }],
      diff: [{ path: 'access', before: '"user"', after: '"public"' }],
      invalid: [],
      proposedBy: 'owner@example.com',
    });
    expect(d.banner).toEqual({ count: 1, modules: ['shop'], href: '/workspaces/acme/apps/shop-app/modules/shop' });

    expect(doneOf(await post('shop', { intent: 'confirm' }))).toBe('confirmed');
    const after = await load();
    expect(after.pending).toBeNull();
    expect(after.values.access).toBe('public');
    const rows = await drizzleDb().select().from(auditLog);
    expect(rows.map((r) => [r.action, r.actorKind])).toEqual([
      ['module.pending', 'user'],
      ['module.confirm', 'user'],
    ]);
    const again = failed(await post('shop', { intent: 'confirm' }));
    expect(again.status).toBe(409);
  });

  it('reject drops the pending change', async () => {
    await post('shop', { intent: 'save-config', [fieldName('greeting')]: 'Hi', [fieldName('access')]: 'public' });
    expect(doneOf(await post('shop', { intent: 'reject' }))).toBe('rejected');
    expect((await load()).pending).toBeNull();
    expect((await load()).values.access).toBe('user');
  });

  it('secrets are write-only: set, rotate, remove — the value is in no response, loader data or audit row', async () => {
    const set = await post('shop', { intent: 'set-secret', secret: 'SHOP_KEY', value: SECRET_VALUE });
    expect(doneOf(set)).toBe('secret-set');
    const r = set as Response;
    expect(await r.clone().text()).not.toContain(SECRET_VALUE);
    expect(JSON.stringify([...r.headers])).not.toContain(SECRET_VALUE);
    const d = await load();
    expect(d.secrets[0]).toMatchObject({ name: 'SHOP_KEY', hasSecret: true, updatedAt: expect.any(String) });
    expect(JSON.stringify(d)).not.toContain(SECRET_VALUE);
    expect(await rt.moduleView({ id: appId, slug: 'shop-app', workspaceId: role.ws.id }, 'shop')).toMatchObject({ secrets: [{ hasSecret: true }] });

    expect(doneOf(await post('shop', { intent: 'set-secret', secret: 'SHOP_KEY', value: `${SECRET_VALUE}-2` }))).toBe('secret-rotated');
    const audit = await drizzleDb().select().from(auditLog);
    expect(audit.map((a) => [a.action, a.meta])).toEqual([
      ['module.secret_set', { module: 'shop', name: 'SHOP_KEY', rotated: false }],
      ['module.secret_set', { module: 'shop', name: 'SHOP_KEY', rotated: true }],
    ]);
    expect(JSON.stringify(audit)).not.toContain(SECRET_VALUE);

    const empty = failed(await post('shop', { intent: 'set-secret', secret: 'SHOP_KEY', value: '  ' }));
    expect(empty.status).toBe(400);
    const undeclared = failed(await post('shop', { intent: 'set-secret', secret: 'OTHER', value: SECRET_VALUE }));
    expect(undeclared.status).toBe(400);
    expect(JSON.stringify(undeclared)).not.toContain(SECRET_VALUE);

    expect(doneOf(await post('shop', { intent: 'remove-secret', secret: 'SHOP_KEY' }))).toBe('secret-removed');
    expect((await load()).secrets[0].hasSecret).toBe(false);
  });

  it('a viewer sees the page without controls and every POST is refused (403) before anything changes', async () => {
    role.current = 'viewer';
    expect((await load()).canEdit).toBe(false);
    for (const body of [
      { intent: 'save-config', [fieldName('greeting')]: 'Yo', [fieldName('access')]: 'public' },
      { intent: 'set-secret', secret: 'SHOP_KEY', value: SECRET_VALUE },
      { intent: 'confirm' },
    ]) {
      await expect(post('shop', body)).rejects.toMatchObject({ status: 403 });
    }
    expect(await drizzleDb().select().from(moduleConfigs)).toEqual([]);
    expect(await drizzleDb().select().from(moduleSecrets)).toEqual([]);
  });

  it('a taken-down app (NSO-293): the banner, every change → 423 app_locked_by_admin, reject still allowed', async () => {
    await drizzleDb().update(apps).set({ lockedReason: 'phishing' }).where(eq(apps.id, appId));
    try {
      expect((await load()).header.lockedByAdmin).toMatchObject({ reason: 'phishing' });
      for (const body of [
        { intent: 'save-config', [fieldName('greeting')]: 'Yo', [fieldName('access')]: 'user' },
        { intent: 'set-secret', secret: 'SHOP_KEY', value: SECRET_VALUE },
        { intent: 'confirm' },
      ]) {
        const r = failed(await post('shop', body));
        expect(r.status).toBe(423);
        expect(r.errors.general.join(' ')).toContain('taken down');
      }
      expect(await drizzleDb().select().from(moduleConfigs)).toEqual([]);
      expect(await drizzleDb().select().from(moduleSecrets)).toEqual([]);
      // reject only takes away: never refused as locked (nothing is pending here).
      const rj = await post('shop', { intent: 'reject' });
      if (!(rj instanceof Response)) expect(failed(rj).status).not.toBe(423);
    } finally {
      await drizzleDb().update(apps).set({ lockedReason: null }).where(eq(apps.id, appId));
    }
    expect((await load()).header.lockedByAdmin).toBeNull();
  });

  it('proxy: the workspace upstreams with assign (→ pending), call rule + rateLimit, unassign', async () => {
    let d = await load('proxy');
    expect(d.editor).toBe('upstreams');
    expect(d.upstreams).toEqual([
      { name: 'weather', registered: true, assigned: false, call: 'user', rateLimit: null, hasSecret: true, methods: ['GET'], prefixes: ['/v1/'] },
    ]);
    const bad = failed(await post('proxy', { intent: 'save-upstream', upstream: 'weather', [ruleInputName('call', 'user')]: 'on', rateLimit: 'lots' }));
    expect(bad.errors.fields['upstreams.weather.rateLimit']).toEqual(['Enter a whole number of calls per minute.']);
    expect(doneOf(await post('proxy', { intent: 'save-upstream', upstream: 'weather', [ruleInputName('call', 'user')]: 'on', rateLimit: '30' }))).toBe('pending');
    d = await load('proxy');
    expect(d.pending?.changes[0].risk).toMatch(/external service/);
    expect(d.pending?.diff).toEqual([
      { path: 'upstreams.weather.rateLimit', before: '(not set)', after: '30' },
      { path: 'upstreams.weather.rules.call', before: '(not set)', after: '"user"' },
    ]);
    // Only a workspace admin confirms it (NSO-322 H3): the editor sees why, and confirm is refused.
    expect(d.pending).toMatchObject({ confirmRole: 'admin', canConfirm: false });
    const refused = failed(await post('proxy', { intent: 'confirm' }));
    expect(refused.status).toBe(403);
    expect(refused.errors.general[0]).toMatch(/Only a workspace admin can confirm/);
    expect((await load('proxy')).upstreams[0]).toMatchObject({ assigned: false });
    role.current = 'workspace-admin';
    expect((await load('proxy')).pending).toMatchObject({ confirmRole: 'admin', canConfirm: true });
    expect(doneOf(await post('proxy', { intent: 'confirm' }))).toBe('confirmed');
    role.current = 'editor';
    d = await load('proxy');
    expect(d.upstreams[0]).toMatchObject({ assigned: true, call: 'user', rateLimit: 30 });
    // Changing the rule of an assigned upstream applies at once here (the fake module confirms assignments only).
    expect(doneOf(await post('proxy', { intent: 'save-upstream', upstream: 'weather', [ruleInputName('call', 'admin')]: 'on', rateLimit: '' }))).toBe('applied');
    expect((await load('proxy')).upstreams[0]).toMatchObject({ call: 'admin', rateLimit: null });
    expect(doneOf(await post('proxy', { intent: 'unassign-upstream', upstream: 'weather' }))).toBe('applied');
    expect((await load('proxy')).upstreams[0]).toMatchObject({ assigned: false });
  });

  it('data: add a collection, rules from the op × principal table (public → pending), schema JSON validated', async () => {
    expect(doneOf(await post('data', { intent: 'add-collection', collection: 'notes' }))).toBe('applied');
    let d = await load('data');
    expect(d.editor).toBe('collections');
    expect(d.fields).toEqual([]);
    expect(d.collections).toEqual([
      { name: 'notes', rules: { read: 'owner|admin', create: 'user', update: 'owner|admin', delete: 'owner|admin' }, schemaText: '' },
    ]);
    expect(failed(await post('data', { intent: 'add-collection', collection: 'notes' })).errors.general[0]).toMatch(/already exists/);

    const checks = {
      [ruleInputName('read', 'owner')]: 'on',
      [ruleInputName('read', 'admin')]: 'on',
      [ruleInputName('create', 'public')]: 'on',
      [ruleInputName('update', 'admin')]: 'on',
    };
    const broken = failed(await post('data', { intent: 'save-collection', collection: 'notes', schema: '{ nope', ...checks }));
    expect(broken.errors.fields['collections.notes.schema']?.[0]).toMatch(/Not a valid JSON Schema/);
    const wrong = failed(await post('data', { intent: 'save-collection', collection: 'notes', schema: '{"type":"array"}', ...checks }));
    expect(wrong.errors.fields['collections.notes.schema']).toEqual(['schema.type must be "object"']);

    expect(doneOf(await post('data', { intent: 'save-collection', collection: 'notes', schema: '{"type":"object"}', ...checks }))).toBe('pending');
    d = await load('data');
    expect(d.pending?.diff).toEqual([
      { path: 'collections.notes.rules.create', before: '"user"', after: '"public"' },
      { path: 'collections.notes.rules.delete', before: '"owner|admin"', after: '"none"' },
      { path: 'collections.notes.rules.update', before: '"owner|admin"', after: '"admin"' },
      { path: 'collections.notes.schema.type', before: '(not set)', after: '"object"' },
    ]);
    expect(doneOf(await post('data', { intent: 'confirm' }))).toBe('confirmed');
    d = await load('data');
    expect(d.collections[0]).toMatchObject({ rules: { create: 'public', delete: 'none' }, schemaText: '{\n  "type": "object"\n}' });

    expect(doneOf(await post('data', { intent: 'remove-collection', collection: 'notes' }))).toBe('applied');
    expect((await load('data')).collections).toEqual([]);
  });
});

