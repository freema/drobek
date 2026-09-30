/**
 * Opt-in modules per workspace against a real (PGlite) database —
 * default vs opt-in, the super-admin's `workspace_modules` row, the limits
 * provider's `MODULE_ENABLED_<NAME>` overriding the row in both directions,
 * the env default, `module_not_enabled` on the route / configure / confirm,
 * get_app's `enabled`, the skills filter, the compile hint and the hooks; a
 * module that is off contributes nothing to the slots of the
 * modules that are on (routes and create / publish hooks), onAppDelete still
 * sees every contribution; `requires` per workspace (the transitive closure,
 * enable refused before a dependency, disable turning dependents off, plan
 * grants without their dependency).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apps, auditLog, moduleConfigs, users, workspaceModules, workspaces } from '@drobek/db';
import { noopLogger } from '@drobek/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineModule, type AnyModule, type HookApp } from './contract.js';
import { ModuleError } from './errors.js';
import { createLimitsProvider, moduleEnabledLimitName } from './limits.js';
import { memoryMailGuard } from './mail-guard.js';
import { validateModule } from './registry.js';
import { limitsCatalogue, loadModuleRuntime, memoryRateLimiter, type ModuleRuntime, type PlatformRequest } from './runtime.js';
import { freshDb, type TestDb } from './test/db.js';
import { quiet } from './test/fixtures.js';

const ENV = {
  APPS_DOMAIN: 'apps.example',
  PUBLIC_APP_URL: 'https://drobek.example',
  PUBLIC_ORIGIN: 'https://drobek.example',
  DROBEK_MASTER_KEY: '11'.repeat(32),
  DROBEK_MIGRATE_ON_START: '0',
};

/** A firm module stand-in, opt-in. Named `files` so `cloudinary` imports point at it. */
const hooked: string[] = [];
const optIn: AnyModule = defineModule<{ open: boolean }>({
  name: 'files',
  version: '0.1.0',
  availability: 'opt-in',
  skill: { useWhen: 'the app needs the firm vault', markdown: '# files\n\nThe firm vault.\n' },
  configSchema: z.object({ open: z.boolean() }),
  configDefaults: { open: false },
  confirmRequired: (before, after) => (!before.open && after.open ? ['open: anyone can read'] : []),
  routes(r) {
    r.get('/ping', { rule: 'public' }, () => ({ pong: true }));
  },
  hooks: {
    onAppCreate: (a: HookApp) => void hooked.push(`create:${a.slug}`),
    onPublish: (a: HookApp) => void hooked.push(`publish:${a.slug}`),
    onAppDelete: (a: HookApp) => void hooked.push(`delete:${a.slug}`),
  },
});
const MODULES = [quiet, optIn];
const KEY = moduleEnabledLimitName('files');

let db: TestDb;
let close: () => Promise<void>;
let userId: string;
let wsA: { id: string; slug: string };
let wsB: { id: string; slug: string };
let appA: { id: string; slug: string; workspaceId: string; workspaceSlug: string };
let appB: { id: string; slug: string; workspaceId: string; workspaceSlug: string };
/** What the fake limits provider answers per workspace id (absent → `{}`). */
let plan: Record<string, Record<string, unknown>> = {};
let fetches = 0;

function runtime(env: Record<string, string> = {}, opts: { provider?: boolean; modules?: AnyModule[] } = {}): Promise<ModuleRuntime> {
  const modules = opts.modules ?? MODULES;
  const fullEnv = {
    ...ENV,
    ...env,
    ...(opts.provider === false ? {} : { LIMITS_PROVIDER_URL: 'https://plans.example', LIMITS_PROVIDER_SECRET: 'x'.repeat(40) }),
  };
  return loadModuleRuntime({
    env: fullEnv,
    log: noopLogger,
    modules,
    skillsDir: null,
    deps: {
      rateLimit: memoryRateLimiter(),
      principal: async () => ({ kind: 'anon' }),
      email: { send: async () => {} },
      mailGuard: memoryMailGuard({ hourlyMax: 1000, pauseMinutes: 1 }, noopLogger),
      limits: createLimitsProvider({
        catalogue: limitsCatalogue(modules),
        env: fullEnv,
        fetch: async (url) => {
          fetches += 1;
          const ws = decodeURIComponent(url.split('/limits/')[1] ?? '');
          return { ok: true, status: 200, json: async () => ({ limits: plan[ws] ?? {} }) };
        },
      }),
    },
  });
}

function req(path: string): PlatformRequest {
  return {
    method: 'GET',
    path,
    query: '',
    header: (n) => (n.toLowerCase() === 'host' ? 'shop--preview.apps.example' : null),
    clientIp: '203.0.113.7',
    readBody: async () => null,
  };
}

beforeAll(async () => {
  const fresh = await freshDb();
  db = fresh.db;
  close = () => fresh.pg.close();
  [{ id: userId }] = await db.insert(users).values({ email: 'root@example.com' }).returning();
  [wsA] = await db.insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
  [wsB] = await db.insert(workspaces).values({ kind: 'team', slug: 'other', name: 'Other' }).returning();
  const [a] = await db.insert(apps).values({ workspaceId: wsA.id, slug: 'shop' }).returning();
  const [b] = await db.insert(apps).values({ workspaceId: wsB.id, slug: 'blog' }).returning();
  appA = { id: a.id, slug: a.slug, workspaceId: wsA.id, workspaceSlug: wsA.slug };
  appB = { id: b.id, slug: b.slug, workspaceId: wsB.id, workspaceSlug: wsB.slug };
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  plan = {};
  fetches = 0;
  hooked.length = 0;
  await db.delete(workspaceModules);
  await db.delete(moduleConfigs);
  await db.delete(auditLog);
});

describe('availability (isEnabled / enabledModules)', () => {
  it('a default module is on everywhere; an opt-in one is off until something enables it', async () => {
    const rt = await runtime({}, { provider: false });
    expect(await rt.isEnabled(wsA.id, 'quiet')).toBe(true);
    expect(await rt.isEnabled(wsA.id, 'files')).toBe(false);
    expect(await rt.isEnabled(wsA.id, 'nope')).toBe(false);
    expect([...(await rt.enabledModules(wsA.id))]).toEqual(['quiet']);
  });

  it('the super-admin switch (a workspace_modules row) enables it for that workspace only; audited once', async () => {
    const rt = await runtime({}, { provider: false });
    expect(await rt.setWorkspaceModule({ workspaceId: wsA.id, module: 'files', enabled: true, actorUserId: userId })).toEqual({ changed: true, dependentsOff: [] });
    expect(await rt.setWorkspaceModule({ workspaceId: wsA.id, module: 'files', enabled: true, actorUserId: userId })).toEqual({ changed: false, dependentsOff: [] });
    expect(await rt.isEnabled(wsA.id, 'files')).toBe(true);
    expect(await rt.isEnabled(wsB.id, 'files')).toBe(false);
    const [state] = await rt.workspaceModules(wsA.id);
    expect(state).toMatchObject({
      name: 'files',
      version: '0.1.0',
      use_when: 'the app needs the firm vault',
      enabled: true,
      source: 'dashboard',
      dashboard: { enabled: true, enabled_by: 'root@example.com' },
    });
    expect(state.dashboard.enabled_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect((await rt.workspaceModules(wsB.id))[0]).toMatchObject({ enabled: false, source: null, dashboard: { enabled: false, enabled_by: null, enabled_at: null } });

    expect(await rt.setWorkspaceModule({ workspaceId: wsA.id, module: 'files', enabled: false, actorUserId: userId })).toEqual({ changed: true, dependentsOff: [] });
    expect(await rt.isEnabled(wsA.id, 'files')).toBe(false);
    const audits = await db.select().from(auditLog).where(eq(auditLog.workspaceId, wsA.id));
    expect(audits.map((a) => [a.action, a.subjectType, a.target, a.actorKind, a.meta])).toEqual([
      ['module.workspace_enable', 'module', 'files', 'user', { module: 'files' }],
      ['module.workspace_disable', 'module', 'files', 'user', { module: 'files' }],
    ]);
  });

  it('refuses the switch for a default or unknown module (not_found)', async () => {
    const rt = await runtime({}, { provider: false });
    await expect(rt.setWorkspaceModule({ workspaceId: wsA.id, module: 'quiet', enabled: true, actorUserId: userId })).rejects.toMatchObject({
      code: 'not_found',
      details: { available: ['files'] },
    });
    await expect(rt.setWorkspaceModule({ workspaceId: wsA.id, module: 'ghost', enabled: true, actorUserId: userId })).rejects.toBeInstanceOf(ModuleError);
  });

  it('the plan (MODULE_ENABLED_<NAME>) overrides the row in both directions', async () => {
    const rt = await runtime();
    await rt.setWorkspaceModule({ workspaceId: wsA.id, module: 'files', enabled: true, actorUserId: userId });
    plan[wsA.id] = { [KEY]: 0 };
    plan[wsB.id] = { [KEY]: 1 };
    expect(await rt.isEnabled(wsA.id, 'files')).toBe(false);
    expect(await rt.isEnabled(wsB.id, 'files')).toBe(true);
    expect((await rt.workspaceModules(wsA.id))[0]).toMatchObject({ enabled: false, source: 'plan', dashboard: { enabled: true } });
    expect((await rt.workspaceModules(wsB.id))[0]).toMatchObject({ enabled: true, source: 'plan', dashboard: { enabled: false } });
    // a value outside 0/1 is ignored → the row decides again
    plan[wsA.id] = { [KEY]: 2 };
    expect(await rt.isEnabled(wsA.id, 'files')).toBe(true);
  });

  it('the env default: MODULE_ENABLED_<NAME>=1 enables it on every workspace; a plan 0 still wins', async () => {
    const rt = await runtime({ [KEY]: '1' });
    expect(await rt.isEnabled(wsA.id, 'files')).toBe(true);
    expect((await rt.workspaceModules(wsB.id))[0]).toMatchObject({ enabled: true, source: 'env' });
    plan[wsB.id] = { [KEY]: 0 };
    expect(await rt.isEnabled(wsB.id, 'files')).toBe(false);
  });

  it('no I/O for a server without opt-in modules', async () => {
    const rt = await loadModuleRuntime({ env: ENV, log: noopLogger, modules: [quiet], skillsDir: null });
    const spy = vi.spyOn(rt.deps, 'db');
    expect([...(await rt.enabledModules(wsA.id))]).toEqual(['quiet']);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the limits catalogue', () => {
  it('has MODULE_ENABLED_<NAME> (0/1, default 0) only for opt-in modules', async () => {
    const cat = limitsCatalogue(MODULES);
    expect(cat.filter((l) => l.env.startsWith('MODULE_ENABLED_'))).toEqual([
      expect.objectContaining({ env: 'MODULE_ENABLED_FILES', default: 0, allowZero: true, max: 1 }),
    ]);
    const rt = await runtime({}, { provider: false });
    expect(rt.deps.limits.defaults()[KEY]).toBe(0);
    expect(limitsCatalogue([quiet]).some((l) => l.env.startsWith('MODULE_ENABLED_'))).toBe(false);
  });

  it('a module may not declare a MODULE_ENABLED_* limit', () => {
    const bad = defineModule({
      ...quiet,
      name: 'sneaky',
      limits: [{ env: 'MODULE_ENABLED_FILES', default: 1, meaning: 'x' }],
    } as never);
    expect(() => validateModule(bad)).toThrow(/reserved for the opt-in switch/);
  });
});

describe('module_not_enabled', () => {
  it('the route answers 404 module_not_enabled (hint + details.module) until enabled; not counted', async () => {
    const stats: string[] = [];
    const rt = await runtime({}, { provider: false });
    rt.deps.requestStats = (_a, m, s) => void stats.push(`${m}:${s}`);
    const off = await rt.handle(req('/__drobek/v1/files/ping'), appA);
    expect(off.status).toBe(404);
    expect(JSON.parse(String(off.body))).toEqual({
      error: 'module_not_enabled',
      message: expect.stringContaining('not enabled for this app'),
      details: { module: 'files' },
      hint: "skill_info('files')",
    });
    // a route that does not exist answers the same (no route probing)
    expect(JSON.parse(String((await rt.handle(req('/__drobek/v1/files/nope'), appA)).body)).error).toBe('module_not_enabled');
    expect(stats).toEqual([]);
    await rt.setWorkspaceModule({ workspaceId: wsA.id, module: 'files', enabled: true, actorUserId: userId });
    const on = await rt.handle(req('/__drobek/v1/files/ping'), appA);
    expect(on.status).toBe(200);
    expect(JSON.parse(String(on.body))).toEqual({ pong: true });
    expect((await rt.handle(req('/__drobek/v1/files/ping'), appB)).status).toBe(404);
  });

  it('configure refuses with module_not_enabled; confirm of a change pending from before refuses too', async () => {
    const rt = await runtime({}, { provider: false });
    const input = { app: appA, module: 'files', patch: { open: true }, actorUserId: userId };
    await expect(rt.configure(input)).rejects.toMatchObject({ code: 'module_not_enabled', status: 404, details: { module: 'files' }, hint: "skill_info('files')" });
    await rt.setWorkspaceModule({ workspaceId: wsA.id, module: 'files', enabled: true, actorUserId: userId });
    expect(await rt.configure(input)).toMatchObject({ applied: false, pending_confirmation: ['open: anyone can read'] });
    await rt.setWorkspaceModule({ workspaceId: wsA.id, module: 'files', enabled: false, actorUserId: userId });
    const decision = { app: appA, module: 'files', userId, role: 'admin' as const };
    await expect(rt.confirm(decision)).rejects.toMatchObject({ code: 'module_not_enabled' });
    // the owner may still drop it
    expect(await rt.reject(decision)).toMatchObject({ rejected: ['open: anyone can read'] });
    const [row] = await db
      .select()
      .from(moduleConfigs)
      .where(and(eq(moduleConfigs.appId, appA.id), eq(moduleConfigs.module, 'files')));
    expect(row.pending).toBeNull();
  });
});

describe('get_app, skills, compile hints, hooks', () => {
  it('appModules: enabled per module (default always true)', async () => {
    const rt = await runtime({}, { provider: false });
    const hook = { id: appA.id, slug: appA.slug, workspaceId: appA.workspaceId };
    let mods = await rt.appModules(hook);
    expect(mods.quiet.enabled).toBe(true);
    expect(mods.files).toMatchObject({ enabled: false, configured: false, config: { open: false } });
    await rt.setWorkspaceModule({ workspaceId: wsA.id, module: 'files', enabled: true, actorUserId: userId });
    mods = await rt.appModules(appA.id); // by id: the workspace is looked up
    expect(mods.files.enabled).toBe(true);
    expect((await rt.moduleView(hook, 'files')).enabled).toBe(true);
    expect((await rt.appModules({ id: appB.id, slug: appB.slug, workspaceId: appB.workspaceId })).files.enabled).toBe(false);
  });

  it('skillList(): every skill, the opt-in one marked; with the workspace set the inactive one is left out', async () => {
    const rt = await runtime({}, { provider: false });
    expect(rt.skillList()).toEqual([
      { name: 'quiet', use_when: 'you want nothing to happen' },
      { name: 'files', use_when: 'the app needs the firm vault', availability: 'opt-in' },
    ]);
    expect(rt.skillList(await rt.enabledModules(wsA.id)).map((s) => s.name)).toEqual(['quiet']);
    await rt.setWorkspaceModule({ workspaceId: wsA.id, module: 'files', enabled: true, actorUserId: userId });
    expect(rt.skillList(await rt.enabledModules(wsA.id)).map((s) => s.name)).toEqual(['quiet', 'files']);
    // skill_info(name) stays server-wide
    expect(rt.skillInfo('files')).toMatchObject({ availability: 'opt-in' });
  });

  it('compileHint points at the skill only where its module is active', async () => {
    const rt = await runtime({}, { provider: false });
    const msg = { code: 'unresolved_import', specifier: 'cloudinary' };
    expect(rt.compileHint(msg)).toBe("skill_info('files')");
    expect(rt.compileHint(msg, await rt.enabledModules(wsA.id))).toBe('skill_info()');
    await rt.setWorkspaceModule({ workspaceId: wsA.id, module: 'files', enabled: true, actorUserId: userId });
    expect(rt.compileHint(msg, await rt.enabledModules(wsA.id))).toBe("skill_info('files')");
  });

  it('onAppCreate / onPublish skip an inactive opt-in module; onAppDelete always runs', async () => {
    const rt = await runtime({}, { provider: false });
    const hook = { id: appA.id, slug: appA.slug, workspaceId: appA.workspaceId };
    await rt.runHook('onAppCreate', hook);
    await rt.runHook('onPublish', { ...hook, version: 1 });
    await rt.runHook('onAppDelete', hook);
    expect(hooked).toEqual(['delete:shop']);
    await rt.setWorkspaceModule({ workspaceId: wsA.id, module: 'files', enabled: true, actorUserId: userId });
    await rt.runHook('onAppCreate', hook);
    await rt.runHook('onPublish', { ...hook, version: 1 });
    expect(hooked).toEqual(['delete:shop', 'create:shop', 'publish:shop']);
  });

  it('the plan answer is fetched once per check (cached by the provider path, memoizable per request)', async () => {
    const rt = await runtime();
    const enabled = await rt.enabledModules(wsA.id);
    rt.skillList(enabled);
    rt.compileHint({ code: 'unresolved_import', specifier: 'cloudinary' }, enabled);
    await rt.appModules({ id: appA.id, slug: appA.slug, workspaceId: appA.workspaceId }, undefined, enabled);
    expect(fetches).toBe(1);
  });
});

// ── contributions follow the workspace switch ──

/** Who ran: `<contributor>@<where>`. */
const ran: string[] = [];
type Observe = { id: string; observe: (where: string) => string };
const hub = defineModule({
  name: 'hub',
  version: '1.0.0',
  skill: { useWhen: 'a slot host (fixture)', markdown: '# hub' },
  configSchema: z.object({}),
  configDefaults: {},
  slots: { 'hub.observe': { schema: z.object({ id: z.string(), observe: z.custom<Observe['observe']>((v) => typeof v === 'function') }), description: 'observers' } },
  routes(r) {
    r.get('/call', { rule: 'public' }, (_req, ctx) => ({ called: ctx.contributions<Observe>('hub.observe').map((c) => c.observe('route')) }));
  },
  hooks: {
    onAppCreate: (_a: HookApp, s) => void s.contributions<Observe>('hub.observe').map((c) => c.observe('create')),
    onPublish: (_a: HookApp, s) => void s.contributions<Observe>('hub.observe').map((c) => c.observe('publish')),
    onAppDelete: (_a: HookApp, s) => void s.contributions<Observe>('hub.observe').map((c) => c.observe('delete')),
  },
});
const contributor = (name: string, availability?: 'opt-in') =>
  defineModule({
    name,
    version: '1.0.0',
    ...(availability ? { availability } : {}),
    skill: { useWhen: `a contributor (${name})`, markdown: `# ${name}` },
    configSchema: z.object({}),
    configDefaults: {},
    contributes: { 'hub.observe': { id: name, observe: (where: string) => (ran.push(`${name}@${where}`), name) } },
    routes(r) {
      r.get('/ping', { rule: 'public' }, () => ({ ok: true }));
    },
  });
const HUB_MODULES = [hub, contributor('always'), contributor('plug', 'opt-in')];
const PLUG_KEY = moduleEnabledLimitName('plug');

describe('contributions follow the workspace switch', () => {
  beforeEach(() => {
    ran.length = 0;
  });

  it('a disabled contributor does not run through an enabled host: its route is 404 and the host never sees it', async () => {
    const rt = await runtime({}, { provider: false, modules: HUB_MODULES });
    expect(await rt.isEnabled(wsA.id, 'plug')).toBe(false);
    expect((await rt.handle(req('/__drobek/v1/plug/ping'), appA)).status).toBe(404);
    const off = await rt.handle(req('/__drobek/v1/hub/call'), appA);
    expect(off.status).toBe(200);
    expect(JSON.parse(String(off.body))).toEqual({ called: ['always'] });
    expect(ran).toEqual(['always@route']);

    await rt.setWorkspaceModule({ workspaceId: wsA.id, module: 'plug', enabled: true, actorUserId: userId });
    expect(JSON.parse(String((await rt.handle(req('/__drobek/v1/hub/call'), appA)).body))).toEqual({ called: ['always', 'plug'] });
    // workspace B is untouched
    expect(JSON.parse(String((await rt.handle(req('/__drobek/v1/hub/call'), appB)).body))).toEqual({ called: ['always'] });
    // switched off again: gone at once
    await rt.setWorkspaceModule({ workspaceId: wsA.id, module: 'plug', enabled: false, actorUserId: userId });
    expect(JSON.parse(String((await rt.handle(req('/__drobek/v1/hub/call'), appA)).body))).toEqual({ called: ['always'] });
  });

  it('plan, env and dashboard precedence decide the contributions too', async () => {
    const rt = await runtime({ [PLUG_KEY]: '1' }, { modules: HUB_MODULES });
    const called = async (app: typeof appA) => (JSON.parse(String((await rt.handle(req('/__drobek/v1/hub/call'), app)).body)) as { called: string[] }).called;
    // env 1 → every workspace; a plan 0 still wins
    expect(await called(appA)).toEqual(['always', 'plug']);
    plan[wsB.id] = { [PLUG_KEY]: 0 };
    expect(await called(appB)).toEqual(['always']);
    // a plan 1 beats a missing row; a plan 0 beats the dashboard row
    const noEnv = await runtime({}, { modules: HUB_MODULES });
    const calledNoEnv = async (app: typeof appA) => (JSON.parse(String((await noEnv.handle(req('/__drobek/v1/hub/call'), app)).body)) as { called: string[] }).called;
    plan = { [wsA.id]: { [PLUG_KEY]: 1 } };
    expect(await calledNoEnv(appA)).toEqual(['always', 'plug']);
    await noEnv.setWorkspaceModule({ workspaceId: wsB.id, module: 'plug', enabled: true, actorUserId: userId });
    plan[wsB.id] = { [PLUG_KEY]: 0 };
    expect(await calledNoEnv(appB)).toEqual(['always']);
  });

  it('create / publish hooks see only the enabled contributors; onAppDelete sees every one (cleanup)', async () => {
    const rt = await runtime({}, { provider: false, modules: HUB_MODULES });
    const hook = { id: appA.id, slug: appA.slug, workspaceId: appA.workspaceId };
    await rt.runHook('onAppCreate', hook);
    await rt.runHook('onPublish', { ...hook, version: 1 });
    await rt.runHook('onAppDelete', hook);
    expect(ran).toEqual(['always@create', 'always@publish', 'always@delete', 'plug@delete']);
    ran.length = 0;
    await rt.setWorkspaceModule({ workspaceId: wsA.id, module: 'plug', enabled: true, actorUserId: userId });
    await rt.runHook('onPublish', { ...hook, version: 2 });
    expect(ran).toEqual(['always@publish', 'plug@publish']);
  });

  it('services() without a workspace (startup, onAppDelete) lists every contribution; with enabledModules only those', async () => {
    const rt = await runtime({}, { provider: false, modules: HUB_MODULES });
    expect(rt.contributions<Observe>('hub.observe').map((c) => c.id)).toEqual(['always', 'plug']);
    expect(rt.contributions<Observe>('hub.observe', await rt.enabledModules(wsA.id)).map((c) => c.id)).toEqual(['always']);
    expect(rt.services(await rt.enabledModules(wsB.id)).contributions<Observe>('hub.observe').map((c) => c.id)).toEqual(['always']);
  });
});

// ── requires per workspace ──

const chained = (name: string, requires: string[] = []) =>
  defineModule({
    name,
    version: '1.0.0',
    availability: 'opt-in',
    ...(requires.length > 0 ? { requires } : {}),
    skill: { useWhen: `a chained module (${name})`, markdown: `# ${name}` },
    configSchema: z.object({}),
    configDefaults: {},
    routes(r) {
      r.get('/ping', { rule: 'public' }, () => ({ ok: true }));
    },
  });
const CHAIN = [quiet, chained('base'), chained('mid', ['base']), chained('top', ['mid']), chained('leaf', ['quiet'])];

describe('requires per workspace', () => {
  const on = (name: string, ws = wsA.id) => ({ workspaceId: ws, module: name, enabled: true, actorUserId: userId });
  const off = (name: string, ws = wsA.id) => ({ workspaceId: ws, module: name, enabled: false, actorUserId: userId });
  const optIn = async (rt: ModuleRuntime, ws = wsA.id) => [...(await rt.enabledModules(ws))].filter((n) => n !== 'quiet').sort();

  it('enabling refuses while a required module is off, naming what to enable first (transitively, in order)', async () => {
    const rt = await runtime({}, { provider: false, modules: CHAIN });
    const err = await rt.setWorkspaceModule(on('top')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModuleError);
    expect(err).toMatchObject({
      code: 'module_requires_not_enabled',
      status: 409,
      details: { module: 'top', missing: ['base', 'mid'] },
      hint: 'Enable "base", then "mid" for this workspace first, then enable "top".',
    });
    await expect(rt.setWorkspaceModule(on('mid'))).rejects.toMatchObject({ details: { missing: ['base'] } });
    expect(await db.select().from(workspaceModules)).toEqual([]);
    expect(await db.select().from(auditLog)).toEqual([]);

    expect(await rt.setWorkspaceModule(on('leaf'))).toEqual({ changed: true, dependentsOff: [] });
    expect(await rt.setWorkspaceModule(on('base'))).toEqual({ changed: true, dependentsOff: [] });
    expect(await rt.setWorkspaceModule(on('mid'))).toEqual({ changed: true, dependentsOff: [] });
    expect(await rt.setWorkspaceModule(on('top'))).toEqual({ changed: true, dependentsOff: [] });
    expect(await optIn(rt)).toEqual(['base', 'leaf', 'mid', 'top']);
    expect(await optIn(rt, wsB.id)).toEqual([]);
  });

  it('disabling a required module applies and turns its dependents off transitively; enabling it again brings them back', async () => {
    const rt = await runtime({}, { provider: false, modules: CHAIN });
    for (const n of ['base', 'mid', 'top']) await rt.setWorkspaceModule(on(n));
    expect((await rt.workspaceModules(wsA.id)).find((m) => m.name === 'base')).toMatchObject({ enabled: true, missing_requires: [], required_by: ['mid', 'top'] });

    expect(await rt.setWorkspaceModule(off('base'))).toEqual({ changed: true, dependentsOff: ['mid', 'top'] });
    expect(await optIn(rt)).toEqual([]);
    expect(await rt.isEnabled(wsA.id, 'top')).toBe(false);
    expect((await rt.handle(req('/__drobek/v1/top/ping'), appA)).status).toBe(404);
    const states = new Map((await rt.workspaceModules(wsA.id)).map((m) => [m.name, m]));
    expect(states.get('mid')).toMatchObject({ enabled: false, source: 'dashboard', dashboard: { enabled: true }, missing_requires: ['base'], required_by: [] });
    expect(states.get('top')).toMatchObject({ enabled: false, source: 'dashboard', dashboard: { enabled: true }, missing_requires: ['base'] });
    expect(states.get('base')).toMatchObject({ enabled: false, required_by: [] });

    expect(await rt.setWorkspaceModule(off('base'))).toEqual({ changed: false, dependentsOff: [] });
    await rt.setWorkspaceModule(on('base'));
    expect(await optIn(rt)).toEqual(['base', 'mid', 'top']);
    expect((await rt.handle(req('/__drobek/v1/top/ping'), appA)).status).toBe(200);
  });

  it('a plan grant without its dependency stays off; a plan grant of the dependency satisfies the switch', async () => {
    plan[wsA.id] = { [moduleEnabledLimitName('top')]: 1 };
    plan[wsB.id] = { [moduleEnabledLimitName('base')]: 1, [moduleEnabledLimitName('mid')]: 1 };
    const rt = await runtime({}, { modules: CHAIN });
    expect(await rt.isEnabled(wsA.id, 'top')).toBe(false);
    expect((await rt.workspaceModules(wsA.id)).find((m) => m.name === 'top')).toMatchObject({ enabled: false, source: 'plan', missing_requires: ['base', 'mid'] });

    expect(await optIn(rt, wsB.id)).toEqual(['base', 'mid']);
    expect(await rt.setWorkspaceModule(on('top', wsB.id))).toEqual({ changed: true, dependentsOff: [] });
    expect(await optIn(rt, wsB.id)).toEqual(['base', 'mid', 'top']);
    expect(await rt.setWorkspaceModule(off('base', wsB.id))).toEqual({ changed: false, dependentsOff: [] });
  });

  it('a plan 0 on a dependency keeps its dependents off whatever their switch says', async () => {
    plan[wsA.id] = { [moduleEnabledLimitName('base')]: 0 };
    const rt = await runtime({}, { modules: CHAIN });
    await db.insert(workspaceModules).values(['base', 'mid'].map((module) => ({ workspaceId: wsA.id, module, enabledBy: userId })));
    expect(await optIn(rt)).toEqual([]);
    await expect(rt.setWorkspaceModule(on('top'))).rejects.toMatchObject({ code: 'module_requires_not_enabled', details: { missing: ['base'] } });
  });
});
