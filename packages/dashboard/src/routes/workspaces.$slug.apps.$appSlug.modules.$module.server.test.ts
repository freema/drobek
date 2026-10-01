/**
 * The module page's loader + action against a real PGlite
 * database and a real ModuleRuntime (test modules; the workspace role gate is
 * stubbed — requireWorkspaceRole has its own tests in @drobek/tenancy):
 * form errors per field, pending via the configure path + confirm with audit,
 * write-only secrets (the value in no response, loader data or audit row),
 * the collections / upstreams editors — chosen by the module's declared
 * `dashboard.editor`, never by its name (the fixtures are NOT named
 * data / proxy, and a module named `proxy` without the declaration gets the
 * generic form) — "About this module" + error codes, a viewer refused before
 * anything changes, and the choices of fields annotated `x-drobek-choices`
 * (the workspace's upstreams, the app's collections, the intervals the
 * workspace's limit allows).
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { apps, auditLog, moduleConfigs, moduleSecrets, setDbForTests, upstreams, users, workspaceModules, workspaces } from '@drobek/db';
import { noopLogger } from '@drobek/core';
import {
  ERROR_REPORTER_SLOT,
  defineErrorReporter,
  defineModule,
  loadModuleRuntime,
  memoryMailGuard,
  memoryRateLimiter,
  setModuleRuntimeForTests,
  z,
  ModuleError,
  type ConfigFieldMeta,
  type ModuleRuntime,
  type SyncRun,
  type SyncSourceState,
} from '@drobek/modules';
import { entryInputs, fieldName, ruleInputName } from '../module-config.js';

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
// A records module under another name: the collections editor follows `dashboard.editor`.
const store = defineModule<{ collections: Record<string, { schema?: Record<string, unknown>; rules: Record<string, string> }> }>({
  name: 'store',
  version: '1.0.0',
  contract: '^1.1',
  dashboard: { editor: 'collections' },
  errors: [{ code: 'store_full', meaning: 'The store holds no more records.', fix: 'Delete records first.' }],
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

// An upstreams module under another name: the upstreams editor follows `dashboard.editor`.
const gateway = defineModule<{ upstreams: Record<string, { rules: { call: string }; rateLimit?: number }> }>({
  name: 'gateway',
  version: '1.0.0',
  dashboard: { editor: 'upstreams' },
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
  // Like the real proxy module: assignments need a workspace ADMIN.
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

// Named like the built-in, but WITHOUT `dashboard.editor`: the generic form, its `upstreams` a record of entries.
const proxy = defineModule<{ upstreams: Record<string, { url: string; retries?: number; verbs: string[] }>; slow: boolean }>({
  name: 'proxy',
  version: '2.0.0',
  skill: { useWhen: 'you pretend to be the proxy', markdown: '# proxy' },
  configSchema: z.strictObject({
    upstreams: z
      .record(z.string().regex(/^[a-z]+$/), z.strictObject({ url: z.url(), retries: z.int().min(0).max(3).optional(), verbs: z.array(z.enum(['GET', 'POST'])).default(['GET']) }))
      .default({}),
    slow: z.boolean().default(false),
  }),
  configDefaults: { upstreams: {}, slow: false },
});

/** An opt-in module — off for the workspace until a workspace_modules row enables it. */
const vault = defineModule<{ shelf: string }>({
  name: 'vault',
  version: '1.0.0',
  availability: 'opt-in',
  skill: { useWhen: 'the app needs the firm vault', markdown: '# vault' },
  configSchema: z.strictObject({ shelf: z.string().max(20) }),
  configDefaults: { shelf: 'main' },
});

/**
 * A scheduled-import module under another name — the sources panel
 * follows the declared `sync` authority. Its state lives in memory: `FAILED`
 * holds the sources paused after failed runs.
 */
const FAILED = new Set<string>();
const IMPORT_RUNS: SyncRun[] = [];
const importer = defineModule<{ sources: Record<string, { upstream: string; paused?: boolean }> }>({
  name: 'importer',
  version: '1.0.0',
  contract: '^1.2',
  skill: { useWhen: 'you import a feed on a schedule', markdown: '# importer' },
  configSchema: z.strictObject({ sources: z.record(z.string(), z.strictObject({ upstream: z.string(), paused: z.boolean().optional() })).default({}) }),
  configDefaults: { sources: {} },
  sync: {
    sources: async ({ config }) =>
      Object.keys(config.sources)
        .sort()
        .map(
          (name): SyncSourceState => ({
            name,
            upstream: config.sources[name].upstream,
            path: '/feed',
            collection: 'items',
            mode: 'replace',
            every: '15m',
            paused: config.sources[name].paused ? 'owner' : FAILED.has(name) ? 'failures' : null,
            failures: FAILED.has(name) ? 5 : 0,
            last_run_at: FAILED.has(name) ? '2026-09-29T10:00:00.000Z' : null,
            last_status: FAILED.has(name) ? 'failed' : null,
            last_records: null,
            last_error: FAILED.has(name) ? 'the upstream answered HTTP 401' : null,
            last_success_at: null,
            next_run_at: null,
          })
        ),
    runs: async () => IMPORT_RUNS,
    runNow: async (ctx, source) => {
      if (source === 'hot') throw new ModuleError('rate_limited', 'The source "hot" ran by hand 2 times this minute (SYNC_NOW_PER_MINUTE) — wait 30 s.');
      const run: SyncRun = {
        source,
        trigger: 'manual',
        started_at: new Date().toISOString(),
        duration_ms: 1,
        status: source === 'broken' ? 'failed' : 'ok',
        records: source === 'broken' ? null : 4,
        error: source === 'broken' ? 'the upstream answered HTTP 500' : null,
      };
      IMPORT_RUNS.unshift(run);
      await ctx.audit('run', { source, status: run.status });
      return run;
    },
    resume: async (_view, source) => FAILED.delete(source),
  },
});

/** A module whose fields take their choices from the workspace and the app (`x-drobek-choices`). */
const feeder = defineModule<{ sources: Record<string, { upstream: string; collection: string; every: string }> }>({
  name: 'feeder',
  version: '1.0.0',
  skill: { useWhen: 'you feed a collection from an API', markdown: '# feeder' },
  dashboard: { title: 'Feeds', description: 'Fills a collection from an upstream on a schedule.' },
  limits: [{ env: 'FEEDER_MIN_INTERVAL_MIN', default: 15, meaning: 'the shortest feed interval, in minutes' }],
  configSchema: z.strictObject({
    sources: z
      .record(
        z.string().meta({ title: 'Feed name' }),
        z.strictObject({
          upstream: z.string().min(1).meta({ title: 'Upstream', 'x-drobek-choices': 'upstreams' } satisfies ConfigFieldMeta),
          collection: z.string().min(1).meta({ title: 'Collection', 'x-drobek-choices': 'collections' } satisfies ConfigFieldMeta),
          every: z
            .string()
            .default('1h')
            .meta({ title: 'Schedule', 'x-drobek-choices': 'intervals', 'x-drobek-min-interval': 'FEEDER_MIN_INTERVAL_MIN' } satisfies ConfigFieldMeta),
        })
      )
      .default({}),
  }),
  configDefaults: { sources: {} },
});

/** An operator-only module: no skill, only the core-hosted errors.reporter slot. */
const sentinel = defineModule({
  name: 'sentinel',
  version: '1.0.0',
  contract: '^1.2',
  configSchema: z.object({}),
  configDefaults: {},
  contributes: { [ERROR_REPORTER_SLOT]: defineErrorReporter({ id: 'sentinel', label: 'Sentinel', report: () => {} }) },
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
    modules: [shop, store, gateway, proxy, vault, importer, feeder, sentinel],
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

describe('the module page', () => {
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

  it('an operator-only module (no skill) has no page: the loader and every POST answer 404', async () => {
    expect(rt.get('sentinel')).toBeDefined();
    await expect(load('sentinel')).rejects.toMatchObject({ init: { status: 404 } });
    await expect(post('sentinel', { intent: 'save-config' })).rejects.toMatchObject({ init: { status: 404 } });
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

  it('a taken-down app: the banner, every change → 423 app_locked_by_admin, reject still allowed', async () => {
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

  it('upstreams editor (a module declaring dashboard.editor upstreams): assign (→ pending), call rule + rateLimit, unassign', async () => {
    let d = await load('gateway');
    expect(d.editor).toBe('upstreams');
    expect(d.upstreams).toEqual([
      { name: 'weather', registered: true, assigned: false, call: 'user', rateLimit: null, hasSecret: true, methods: ['GET'], prefixes: ['/v1/'] },
    ]);
    const bad = failed(await post('gateway', { intent: 'save-upstream', upstream: 'weather', [ruleInputName('call', 'user')]: 'on', rateLimit: 'lots' }));
    expect(bad.errors.fields['upstreams.weather.rateLimit']).toEqual(['Enter a whole number of calls per minute.']);
    expect(doneOf(await post('gateway', { intent: 'save-upstream', upstream: 'weather', [ruleInputName('call', 'user')]: 'on', rateLimit: '30' }))).toBe('pending');
    d = await load('gateway');
    expect(d.pending?.changes[0].risk).toMatch(/external service/);
    expect(d.pending?.diff).toEqual([
      { path: 'upstreams.weather.rateLimit', before: '(not set)', after: '30' },
      { path: 'upstreams.weather.rules.call', before: '(not set)', after: '"user"' },
    ]);
    // Only a workspace admin confirms it: the editor sees why, and confirm is refused.
    expect(d.pending).toMatchObject({ confirmRole: 'admin', canConfirm: false });
    const refused = failed(await post('gateway', { intent: 'confirm' }));
    expect(refused.status).toBe(403);
    expect(refused.errors.general[0]).toMatch(/Only a workspace admin can confirm/);
    expect((await load('gateway')).upstreams[0]).toMatchObject({ assigned: false });
    role.current = 'workspace-admin';
    expect((await load('gateway')).pending).toMatchObject({ confirmRole: 'admin', canConfirm: true });
    expect(doneOf(await post('gateway', { intent: 'confirm' }))).toBe('confirmed');
    role.current = 'editor';
    d = await load('gateway');
    expect(d.upstreams[0]).toMatchObject({ assigned: true, call: 'user', rateLimit: 30 });
    // Changing the rule of an assigned upstream applies at once here (the fake module confirms assignments only).
    expect(doneOf(await post('gateway', { intent: 'save-upstream', upstream: 'weather', [ruleInputName('call', 'admin')]: 'on', rateLimit: '' }))).toBe('applied');
    expect((await load('gateway')).upstreams[0]).toMatchObject({ call: 'admin', rateLimit: null });
    expect(doneOf(await post('gateway', { intent: 'unassign-upstream', upstream: 'weather' }))).toBe('applied');
    expect((await load('gateway')).upstreams[0]).toMatchObject({ assigned: false });
  });

  it('collections editor (a module declaring dashboard.editor collections): add, rules from the op × principal table (public → pending), schema JSON validated', async () => {
    expect(doneOf(await post('store', { intent: 'add-collection', collection: 'notes' }))).toBe('applied');
    let d = await load('store');
    expect(d.editor).toBe('collections');
    expect(d.fields).toEqual([]);
    expect(d.collections).toEqual([
      { name: 'notes', rules: { read: 'owner|admin', create: 'user', update: 'owner|admin', delete: 'owner|admin' }, schemaText: '' },
    ]);
    expect(failed(await post('store', { intent: 'add-collection', collection: 'notes' })).errors.general[0]).toMatch(/already exists/);

    const checks = {
      [ruleInputName('read', 'owner')]: 'on',
      [ruleInputName('read', 'admin')]: 'on',
      [ruleInputName('create', 'public')]: 'on',
      [ruleInputName('update', 'admin')]: 'on',
    };
    const broken = failed(await post('store', { intent: 'save-collection', collection: 'notes', schema: '{ nope', ...checks }));
    expect(broken.errors.fields['collections.notes.schema']?.[0]).toMatch(/Not a valid JSON Schema/);
    const wrong = failed(await post('store', { intent: 'save-collection', collection: 'notes', schema: '{"type":"array"}', ...checks }));
    expect(wrong.errors.fields['collections.notes.schema']).toEqual(['schema.type must be "object"']);

    expect(doneOf(await post('store', { intent: 'save-collection', collection: 'notes', schema: '{"type":"object"}', ...checks }))).toBe('pending');
    d = await load('store');
    expect(d.pending?.diff).toEqual([
      { path: 'collections.notes.rules.create', before: '"user"', after: '"public"' },
      { path: 'collections.notes.rules.delete', before: '"owner|admin"', after: '"none"' },
      { path: 'collections.notes.rules.update', before: '"owner|admin"', after: '"admin"' },
      { path: 'collections.notes.schema.type', before: '(not set)', after: '"object"' },
    ]);
    expect(doneOf(await post('store', { intent: 'confirm' }))).toBe('confirmed');
    d = await load('store');
    expect(d.collections[0]).toMatchObject({ rules: { create: 'public', delete: 'none' }, schemaText: '{\n  "type": "object"\n}' });

    expect(doneOf(await post('store', { intent: 'remove-collection', collection: 'notes' }))).toBe('applied');
    expect((await load('store')).collections).toEqual([]);
  });

  it('the editor follows dashboard.editor, not the name: a module named proxy without it gets the generic form (record entries round-trip)', async () => {
    let d = await load('proxy');
    expect(d.editor).toBeNull();
    expect(d.upstreams).toEqual([]);
    expect(d.fields.map((f) => [f.path, f.kind])).toEqual([
      ['upstreams', 'record'],
      ['slow', 'boolean'],
    ]);
    // The browser posts the rendered record: no entries yet + the empty "add" entry (index 0).
    const add = {
      intent: 'save-config',
      [entryInputs.count('upstreams')]: '1',
      [entryInputs.isNew('upstreams', 0)]: '1',
      [entryInputs.key('upstreams', 0)]: 'erp',
      [fieldName('upstreams[0].url')]: 'https://erp.example/api',
      [fieldName('upstreams[0].retries')]: '2',
      [fieldName('upstreams[0].verbs[1]')]: 'on',
    };
    expect(doneOf(await post('proxy', add))).toBe('applied');
    d = await load('proxy');
    expect(d.values.upstreams).toEqual({
      entries: [{ key: 'erp', values: { url: 'https://erp.example/api', retries: '2', verbs: ['POST'] } }],
    });
    const stored = await rt.moduleView({ id: appId, slug: 'shop-app', workspaceId: role.ws.id }, 'proxy');
    expect(stored.config).toEqual({ upstreams: { erp: { url: 'https://erp.example/api', retries: 2, verbs: ['POST'] } }, slow: false });

    // The module's schema stays the one validator: a bad URL inside an entry comes back at the record.
    const bad = failed(
      await post('proxy', {
        intent: 'save-config',
        [entryInputs.count('upstreams')]: '2',
        [entryInputs.key('upstreams', 0)]: 'erp',
        [fieldName('upstreams[0].url')]: 'not a url',
        [fieldName('upstreams[0].verbs[0]')]: 'on',
        [entryInputs.isNew('upstreams', 1)]: '1',
        [entryInputs.key('upstreams', 1)]: '',
        [fieldName('upstreams[1].verbs[0]')]: 'on',
      })
    );
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.errors.fields)).toEqual(['upstreams']);
    expect(bad.errors.fields.upstreams[0]).toMatch(/^erp\.url: /);

    // Removing the entry (its checkbox) → the merge patch sets it to null.
    expect(
      doneOf(await post('proxy', { intent: 'save-config', [entryInputs.count('upstreams')]: '1', [entryInputs.key('upstreams', 0)]: 'erp', [entryInputs.remove('upstreams', 0)]: 'on' }))
    ).toBe('applied');
    expect((await rt.moduleView({ id: appId, slug: 'shop-app', workspaceId: role.ws.id }, 'proxy')).config).toEqual({ upstreams: {}, slow: false });
    // The collections / upstreams intents are refused for a module without the editor.
    expect(failed(await post('proxy', { intent: 'save-upstream', upstream: 'erp' })).status).toBe(400);
  });

  it('"About this module": version, source, contract, availability, the error codes; a link to the workspace Modules page', async () => {
    const d = await load('store');
    expect(d.about).toMatchObject({ version: '1.0.0', source: 'builtin', contract: '^1.1', availability: 'default', requires: [], slots: [], contributes: [], editor: 'collections' });
    expect(d.errors).toEqual([{ code: 'store_full', meaning: 'The store holds no more records.', fix: 'Delete records first.' }]);
    expect(d.modulesHref).toBe('/workspaces/acme/modules#module-store');
    expect((await load('shop')).about).toMatchObject({ contract: null, editor: null });
    expect((await load('shop')).errors).toEqual([]);
  });
});

describe('an opt-in module not enabled for the workspace', () => {
  it('the page says so instead of the form, and every change answers 404 until it is enabled', async () => {
    const db = drizzleDb();
    expect((await load('vault')).enabled).toBe(false);
    const refused = failed(await post('vault', { intent: 'save-config', [fieldName('shelf')]: 'side' }));
    expect(refused.status).toBe(404);
    expect(refused.errors.general[0]).toMatch(/not enabled for this app's workspace/);
    expect(await db.select().from(moduleConfigs).where(eq(moduleConfigs.module, 'vault'))).toEqual([]);

    await db.insert(workspaceModules).values({ workspaceId: role.ws.id, module: 'vault' });
    try {
      expect((await load('vault')).enabled).toBe(true);
      expect(doneOf(await post('vault', { intent: 'save-config', [fieldName('shelf')]: 'side' }))).toBe('applied');
      expect((await load('shop')).enabled).toBe(true);
    } finally {
      await db.delete(workspaceModules);
    }
  });
});

describe('the sources of a scheduled-import module', () => {
  const configureImporter = (sources: Record<string, unknown>) =>
    rt.configure({ app: { id: appId, slug: 'shop-app', workspaceId: role.ws.id, workspaceSlug: 'acme' }, module: 'importer', patch: { sources }, actorUserId: role.user.id, surface: 'web' });

  beforeEach(() => {
    FAILED.clear();
    IMPORT_RUNS.length = 0;
  });

  it('only the module that declares sync gets the panel: sources, the latest runs, an empty list apart from a loading error', async () => {
    expect((await load('shop')).sync).toBeNull();
    const empty = await load('importer');
    expect(empty.sync).toEqual({ sources: [], runs: [] });
    await configureImporter({ feed: { upstream: 'news' } });
    const d = await load('importer');
    expect(d.sync!.sources!.map((s) => [s.name, s.upstream, s.paused])).toEqual([['feed', 'news', null]]);
  });

  it('Run now: an ok run, a failed run (not an error), a refusal at the source; the audit names the person', async () => {
    await configureImporter({ feed: { upstream: 'news' }, broken: { upstream: 'news' }, hot: { upstream: 'news' } });
    expect(doneOf(await post('importer', { intent: 'sync-run', source: 'feed' }))).toBe('sync-ran');
    expect(doneOf(await post('importer', { intent: 'sync-run', source: 'broken' }))).toBe('sync-failed');
    const refused = failed(await post('importer', { intent: 'sync-run', source: 'hot' }));
    expect(refused.status).toBe(429);
    expect(refused.errors).toMatchObject({ intent: 'sync-run', target: 'hot', general: [expect.stringMatching(/SYNC_NOW_PER_MINUTE/)] });
    expect(failed(await post('importer', { intent: 'sync-run', source: 'ghost' })).status).toBe(404);
    expect((await load('importer')).sync!.runs.map((r) => [r.source, r.status])).toEqual([
      ['broken', 'failed'],
      ['feed', 'ok'],
    ]);
    const rows = await drizzleDb().select().from(auditLog).where(eq(auditLog.action, 'importer.run'));
    expect(rows.map((r) => [r.actorUserId, r.actorKind, (r.meta as { by: string }).by])).toEqual([
      [role.user.id, 'user', 'web'],
      [role.user.id, 'user', 'web'],
    ]);
  });

  it("Pause sets the source's paused key directly; Resume removes it", async () => {
    await configureImporter({ feed: { upstream: 'news' } });
    expect(doneOf(await post('importer', { intent: 'sync-pause', source: 'feed' }))).toBe('sync-paused');
    expect((await load('importer')).sync!.sources![0].paused).toBe('owner');
    expect(doneOf(await post('importer', { intent: 'sync-resume', source: 'feed' }))).toBe('sync-resumed');
    expect((await load('importer')).sync!.sources![0].paused).toBeNull();
    const [row] = await drizzleDb().select().from(moduleConfigs).where(eq(moduleConfigs.module, 'importer'));
    expect(row.config).toEqual({ sources: { feed: { upstream: 'news' } } });
  });

  it('a source paused after failed runs: the banner on every app page, Resume clears it (audited)', async () => {
    await configureImporter({ feed: { upstream: 'news' } });
    FAILED.add('feed');
    const shopPage = await load('shop');
    expect(shopPage.syncBanner).toEqual({
      paused: [{ name: 'feed', failures: 5, error: 'the upstream answered HTTP 401' }],
      href: '/workspaces/acme/apps/shop-app/modules/importer#sync',
    });
    expect((await load('importer')).sync!.sources![0].paused).toBe('failures');
    expect(doneOf(await post('importer', { intent: 'sync-resume', source: 'feed' }))).toBe('sync-resumed');
    expect((await load('shop')).syncBanner).toBeNull();
    const [audit] = await drizzleDb().select().from(auditLog).where(eq(auditLog.action, 'importer.resume'));
    expect(audit).toMatchObject({ actorUserId: role.user.id, actorKind: 'user', meta: { module: 'importer', source: 'feed' } });
  });

  it('another module has no sources to run; a viewer is refused before anything runs', async () => {
    expect(failed(await post('shop', { intent: 'sync-run', source: 'feed' })).status).toBe(400);
    await configureImporter({ feed: { upstream: 'news' } });
    role.current = 'viewer';
    await expect(post('importer', { intent: 'sync-run', source: 'feed' })).rejects.toMatchObject({ status: 403 });
    expect(IMPORT_RUNS).toEqual([]);
  });
});

describe('fields with choices (x-drobek-choices)', () => {
  const hookApp = () => ({ id: appId, slug: 'shop-app', workspaceId: role.ws.id, workspaceSlug: 'acme' });
  const values = (list: { groups: { options: { value: string }[] }[] }) => list.groups.flatMap((g) => g.options.map((o) => o.value));
  const register = (workspaceId: string, name: string) =>
    drizzleDb().insert(upstreams).values({ workspaceId, name, baseUrl: `https://${name}.example`, allowedMethods: ['GET'], allowedPathPrefixes: ['/'] });

  afterEach(async () => {
    await drizzleDb().delete(upstreams);
  });

  it('the module page names the module by its title; a module without annotated fields loads no choices', async () => {
    const d = await load('feeder');
    expect(d.module).toMatchObject({ name: 'feeder', title: 'Feeds', description: 'Fills a collection from an upstream on a schedule.' });
    expect((await load('shop')).choices).toEqual({});
    expect((await load('shop')).module).toMatchObject({ title: null, description: null });
  });

  it('nothing set up yet: each field says what to set up first and links there; the intervals start at the workspace minimum', async () => {
    const d = await load('feeder');
    expect(Object.keys(d.choices).sort()).toEqual(['collections', 'intervals:FEEDER_MIN_INTERVAL_MIN', 'upstreams']);
    expect(d.choices.upstreams.groups).toEqual([]);
    expect(d.choices.upstreams.empty).toEqual({
      text: 'This workspace has no upstream yet. A workspace admin registers one on the Upstreams page; then assign it to this app in the gateway module.',
      link: { href: '/workspaces/acme/upstreams', label: 'Open the Upstreams page' },
    });
    expect(values(d.choices.collections)).toEqual([]);
    expect(d.choices.collections.empty).toEqual({
      text: 'This app has no data collection yet. Create one in the store module first.',
      link: { href: '/workspaces/acme/apps/shop-app/modules/store#collections', label: 'Create a collection' },
    });
    expect(values(d.choices['intervals:FEEDER_MIN_INTERVAL_MIN'])).toEqual(['15m', '30m', '1h', '3h', '6h', '12h', '24h']);
  });

  it("the workspace's upstreams, those assigned to the app first (never another workspace's), and the app's collections", async () => {
    const [other] = await drizzleDb().insert(workspaces).values({ kind: 'team', slug: 'other-ws', name: 'Other' }).returning();
    await register(role.ws.id, 'weather');
    await register(role.ws.id, 'news');
    await register(other.id, 'secret-feed');
    await rt.configure({ app: hookApp(), module: 'store', patch: { collections: { players: {}, fixtures: {} } }, actorUserId: role.user.id, surface: 'web' });
    await rt.configure({ app: hookApp(), module: 'gateway', patch: { upstreams: { weather: {} } }, actorUserId: role.user.id, surface: 'web' });
    await rt.confirm({ app: hookApp(), module: 'gateway', userId: role.user.id, role: 'admin' });

    const d = await load('feeder');
    expect(d.choices.upstreams.groups).toEqual([
      { label: 'Assigned to this app', options: [{ value: 'weather', label: 'weather' }] },
      { label: 'Not assigned to this app yet', options: [{ value: 'news', label: 'news' }] },
    ]);
    expect(d.choices.upstreams.note?.link).toEqual({ href: '/workspaces/acme/apps/shop-app/modules/gateway#upstreams', label: 'Assign an upstream' });
    expect(JSON.stringify(d.choices)).not.toContain('secret-feed');
    expect(values(d.choices.collections)).toEqual(['fixtures', 'players']);
    await drizzleDb().delete(workspaces).where(eq(workspaces.id, other.id));
  });

  it('a value picked from the selects saves through the configure path; the schema still decides what is valid', async () => {
    await register(role.ws.id, 'weather');
    const prefix = entryInputs.prefix('sources', 0);
    const form = (upstream: string) => ({
      intent: 'save-config',
      [entryInputs.count('sources')]: '1',
      [entryInputs.isNew('sources', 0)]: '1',
      [entryInputs.key('sources', 0)]: 'scores',
      [fieldName(`${prefix}.upstream`)]: upstream,
      [fieldName(`${prefix}.collection`)]: 'players',
      [fieldName(`${prefix}.every`)]: '30m',
    });
    const bad = failed(await post('feeder', form('')));
    expect(bad.status).toBe(400);
    expect(bad.errors.fields.sources?.[0]).toMatch(/upstream/);
    expect(doneOf(await post('feeder', form('weather')))).toBe('applied');
    const [row] = await drizzleDb().select().from(moduleConfigs).where(eq(moduleConfigs.module, 'feeder'));
    expect(row.config).toEqual({ sources: { scores: { upstream: 'weather', collection: 'players', every: '30m' } } });
    expect((await load('feeder')).values.sources).toMatchObject({ entries: [{ key: 'scores', values: { upstream: 'weather', collection: 'players', every: '30m' } }] });
  });
});
