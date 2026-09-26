/**
 * Module contract 1.1 (NSO-344): the `contract` range, the short-name check,
 * typed slots (`slots` / `contributes` / `contributions()`), module error
 * codes (`errors`, the runtime's undeclared-code guard), `availability`,
 * `dashboard.editor`, `hooks.onAppDelete` and `DROBEK_MODULE_<NAME>_DEFAULTS`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { apps, workspaces } from '@drobek/db';
import { noopLogger } from '@drobek/core';
import { z } from 'zod';
import { MODULE_CONTRACT_VERSION, defineModule, type AnyModule, type HookApp, type ModuleServices } from './contract.js';
import { CORE_ERROR_CODES, ModuleError } from './errors.js';
import {
  ModuleLoadError,
  checkErrorCodes,
  checkModuleSet,
  collectContributions,
  effectiveConfigDefaults,
  loadModules,
  moduleDefaultsEnvName,
  validateModule,
} from './registry.js';
import { loadModuleRuntime, memoryRateLimiter, type ModuleRuntime, type PlatformRequest } from './runtime.js';
import { createModuleTestContext } from './testing.js';
import { freshDb } from './test/db.js';

const ENV = {
  APPS_DOMAIN: 'apps.example',
  PUBLIC_APP_URL: 'https://drobek.example',
  PUBLIC_ORIGIN: 'https://drobek.example',
  DROBEK_MASTER_KEY: '11'.repeat(32),
  DROBEK_MIGRATE_ON_START: '0',
};

const base = { version: '1.0.0', contract: '^1.1', skill: { useWhen: 'x', markdown: '# x' }, configSchema: z.object({}), configDefaults: {} };

const importer = (map: Record<string, unknown>) => async (pkg: string) => {
  if (!(pkg in map)) throw new Error(`Cannot find package '${pkg}'`);
  return map[pkg];
};

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ── a host with a slot, and contributors ─────────────────────────────────────

interface Greeter {
  id: string;
  greet(name: string): string;
}
const greeterSchema = z.object({
  id: z.string().regex(/^[a-z]+$/),
  greet: z.custom<(name: string) => string>((v) => typeof v === 'function', 'greet must be a function'),
});

const host = defineModule({
  ...base,
  name: 'host',
  slots: { 'host.greeter': { schema: greeterSchema, unique: 'id', description: 'a way to greet someone' } },
  errors: [{ code: 'unknown_greeter', meaning: 'No greeter has that id.', fix: 'Use an id GET /greeters lists.' }],
  routes(r) {
    r.get('/greeters', { rule: 'public' }, (_req, ctx) => ctx.contributions<Greeter>('host.greeter').map((g) => g.id));
    r.get('/greet/:id', { rule: 'public' }, (req, ctx) => {
      const g = ctx.contributions<Greeter>('host.greeter').find((x) => x.id === req.params.id);
      if (!g) throw new ModuleError('unknown_greeter', `No greeter "${req.params.id}".`, { status: 404 });
      return { text: g.greet('Ada') };
    });
    r.get('/undeclared', { rule: 'public' }, () => {
      throw new ModuleError('made_up_code', 'not declared anywhere');
    });
    r.get('/core-code', { rule: 'public' }, () => {
      throw new ModuleError('conflict', 'a core code is always fine');
    });
  },
});
const pirate = defineModule({ ...base, name: 'pirate', contributes: { 'host.greeter': { id: 'pirate', greet: (n: string) => `Ahoy ${n}` } } });
const formal = defineModule({ ...base, name: 'formal', contributes: { 'host.greeter': { id: 'formal', greet: (n: string) => `Good day, ${n}` } } });

// ── contract range ───────────────────────────────────────────────────────────

describe('contract range', () => {
  it(`is satisfied by this server (${MODULE_CONTRACT_VERSION}) for ^1.1, ^1.0, 1.x, >=1.1.0`, () => {
    expect(MODULE_CONTRACT_VERSION).toBe('1.1.0');
    for (const contract of ['^1.1', '^1.0', '1.x', '>=1.1.0']) {
      expect(() => validateModule(defineModule({ ...base, name: 'ok', contract }))).not.toThrow();
    }
  });

  it('refuses the start when the range is not satisfied — naming the module, the range and the server version', () => {
    for (const contract of ['^2.0', '~1.0', '<1.1.0', '^1.2']) {
      expect(() => validateModule(defineModule({ ...base, name: 'future', contract }))).toThrow(ModuleLoadError);
    }
    expect(() => validateModule(defineModule({ ...base, name: 'future', contract: '^2.0' }))).toThrow(
      /module "future": it needs module contract \^2\.0, but this server implements 1\.1\.0/
    );
    expect(() => validateModule(defineModule({ ...base, name: 'odd', contract: 'not a range' }))).toThrow(/contract must be a semver range/);
  });

  it('a module without `contract` still loads, with a warning that names the range to add', async () => {
    const log = logger();
    const legacy = defineModule({ ...base, name: 'legacy', contract: undefined });
    const mods = await loadModules({ DROBEK_MODULES: 'legacy' }, { importer: importer({ 'drobek-module-legacy': legacy }), log });
    expect(mods.map((m) => m.name)).toEqual(['legacy']);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(`module "legacy" declares no contract range — add contract: '^1.1'`), expect.anything());
    const log2 = logger();
    await loadModules({ DROBEK_MODULES: 'host' }, { importer: importer({ 'drobek-module-host': host }), log: log2 });
    expect(log2.warn).not.toHaveBeenCalled();
  });
});

// ── the short name ───────────────────────────────────────────────────────────

describe('DROBEK_MODULES short names', () => {
  it('a short name must load a module of that name', async () => {
    await expect(loadModules({ DROBEK_MODULES: 'auth' }, { importer: importer({ 'drobek-module-auth': host }), log: noopLogger })).rejects.toThrow(
      /DROBEK_MODULES names "auth", but the package "drobek-module-auth" exports the module "host"/
    );
  });

  it('a full package name may export any name (how a built-in is replaced)', async () => {
    const mods = await loadModules(
      { DROBEK_MODULES: '@acme/drobek-module-auth,drobek-module-other' },
      { importer: importer({ '@acme/drobek-module-auth': host, 'drobek-module-other': pirate }), log: noopLogger }
    );
    expect(mods.map((m) => m.name)).toEqual(['host', 'pirate']);
  });
});

// ── slots ────────────────────────────────────────────────────────────────────

describe('slots and contributions', () => {
  it('validates the slot declarations', () => {
    const slot = { schema: greeterSchema, description: 'x' };
    expect(() => validateModule(defineModule({ ...base, name: 'host', slots: { greeter: slot } }))).toThrow(/slot "greeter" must be named <module>\.<name>/);
    expect(() => validateModule(defineModule({ ...base, name: 'host', slots: { 'other.greeter': slot } }))).toThrow(/must start with the module's own name \("host\."\)/);
    expect(() => validateModule(defineModule({ ...base, name: 'host', slots: { 'host.Greeter': slot } }))).toThrow(/<module>\.<name>/);
    expect(() => validateModule(defineModule({ ...base, name: 'host', slots: { 'host.greeter': { ...slot, schema: {} as never } } }))).toThrow(/schema must be a zod schema/);
    expect(() => validateModule(defineModule({ ...base, name: 'host', slots: { 'host.greeter': { ...slot, description: ' ' } } }))).toThrow(/needs a description/);
    expect(() => validateModule(defineModule({ ...base, name: 'host', slots: { 'host.greeter': { ...slot, unique: '' } } }))).toThrow(/unique must name a key/);
    expect(() => validateModule(defineModule({ ...base, name: 'host', slots: { 'host.fooBar2': slot } }))).not.toThrow();
    expect(() => validateModule(defineModule({ ...base, name: 'cc', contributes: { nope: 1 } }))).toThrow(/not a slot name/);
    expect(() => validateModule(host)).not.toThrow();
  });

  it('collects the contributions in DROBEK_MODULES order, as the schema parsed them; a slot nobody contributes to is []', async () => {
    const mods = await loadModules(
      { DROBEK_MODULES: 'formal,host,pirate' },
      { importer: importer({ 'drobek-module-formal': formal, 'drobek-module-host': host, 'drobek-module-pirate': pirate }), log: noopLogger }
    );
    const slots = collectContributions(mods);
    expect(slots.get('host.greeter')!.map((c) => c.module)).toEqual(['formal', 'pirate']);
    expect(collectContributions([host]).get('host.greeter')).toEqual([]);
  });

  it('refuses a contribution to a slot no active module declares (naming the module and the slot)', () => {
    expect(() => collectContributions([pirate])).toThrow(/module "pirate" contributes to the slot "host\.greeter", but the module "host" is not in DROBEK_MODULES/);
    const bare = defineModule({ ...base, name: 'host' });
    expect(() => collectContributions([bare, pirate])).toThrow(/module "pirate" contributes to the slot "host\.greeter", but the module "host" declares no such slot/);
  });

  it('refuses a contribution that fails the slot schema, and a duplicate unique key', () => {
    const bad = defineModule({ ...base, name: 'bad', contributes: { 'host.greeter': { id: 'Nope!', greet: 'not a function' } } });
    expect(() => collectContributions([host, bad])).toThrow(/module "bad": its contribution to the slot "host\.greeter" \(module "host"\) does not pass the slot's schema — id: .*greet: greet must be a function/);
    const twin = defineModule({ ...base, name: 'twin', contributes: { 'host.greeter': { id: 'pirate', greet: () => 'arr' } } });
    expect(() => collectContributions([host, pirate, twin])).toThrow(/modules "pirate" and "twin" both contribute id "pirate" to the slot "host\.greeter"/);
  });

  it('checkModuleSet runs the slot checks (loadModules and the runtime refuse the start)', async () => {
    expect(() => checkModuleSet([pirate], {})).toThrow(ModuleLoadError);
    await expect(
      loadModuleRuntime({ env: ENV, log: noopLogger, modules: [pirate], skillsDir: null, deps: { rateLimit: memoryRateLimiter() } })
    ).rejects.toThrow(/contributes to the slot "host\.greeter"/);
  });
});

// ── errors ───────────────────────────────────────────────────────────────────

describe('module error codes', () => {
  it('validates the declarations: the code pattern, meaning + fix, no core code, no duplicate', () => {
    const e = (code: string) => ({ code, meaning: 'm', fix: 'f' });
    expect(() => validateModule(defineModule({ ...base, name: 'mm', errors: [e('ok_code')] }))).not.toThrow();
    for (const code of ['Bad', 'ab', '1abc', 'with-dash', `a${'b'.repeat(41)}`]) {
      expect(() => validateModule(defineModule({ ...base, name: 'mm', errors: [e(code)] })), code).toThrow(/must match/);
    }
    expect(() => validateModule(defineModule({ ...base, name: 'mm', errors: [{ code: 'no_fix', meaning: 'm', fix: '' }] }))).toThrow(/needs a fix/);
    expect(() => validateModule(defineModule({ ...base, name: 'mm', errors: [{ code: 'no_meaning', meaning: '', fix: 'f' }] }))).toThrow(/needs a meaning/);
    for (const core of ['not_found', 'invalid_params', 'quota_exceeded', 'busy']) {
      expect(CORE_ERROR_CODES).toContain(core);
      expect(() => validateModule(defineModule({ ...base, name: 'mm', errors: [e(core)] })), core).toThrow(/is a core code/);
    }
    expect(() => validateModule(defineModule({ ...base, name: 'mm', errors: [e('twice'), e('twice')] }))).toThrow(/declared twice/);
  });

  it('two active modules may not declare one code', async () => {
    const a = defineModule({ ...base, name: 'aaa', errors: [{ code: 'shared_code', meaning: 'm', fix: 'f' }] });
    const b = defineModule({ ...base, name: 'bbb', errors: [{ code: 'shared_code', meaning: 'm', fix: 'f' }] });
    expect(() => checkErrorCodes([a, b])).toThrow(/error code "shared_code" is declared by both "aaa" and "bbb"/);
    await expect(
      loadModules({ DROBEK_MODULES: 'aaa,bbb' }, { importer: importer({ 'drobek-module-aaa': a, 'drobek-module-bbb': b }), log: noopLogger })
    ).rejects.toThrow(ModuleLoadError);
  });

  it('the test kit answers a declared code, a core code — and rejects an undeclared one (production: 500)', async () => {
    const t = createModuleTestContext(host, { contributions: { 'host.greeter': [{ id: 'pirate', greet: (n: string) => `Ahoy ${n}` }] } });
    expect((await t.request('GET', '/greet/pirate')).body).toEqual({ text: 'Ahoy Ada' });
    const unknown = await t.request('GET', '/greet/nope');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: 'unknown_greeter', hint: "skill_info('host')" });
    expect((await t.request('GET', '/core-code')).status).toBe(409);
    await expect(t.request('GET', '/undeclared')).rejects.toThrow(/module "host" answered the error code "made_up_code", which is neither a core code nor declared in its errors/);
  });
});

// ── env defaults ─────────────────────────────────────────────────────────────

describe('DROBEK_MODULE_<NAME>_DEFAULTS', () => {
  const tuned = defineModule({
    ...base,
    name: 'tuned',
    configSchema: z.object({ greeting: z.string().min(1).max(10), allow: z.object({ domains: z.array(z.string()) }) }),
    configDefaults: { greeting: 'hi', allow: { domains: [] as string[] } },
  });

  it('is named after the module', () => {
    expect(moduleDefaultsEnvName('auth')).toBe('DROBEK_MODULE_AUTH_DEFAULTS');
  });

  it('merges a valid patch over configDefaults; unset / empty = the module defaults', () => {
    expect(effectiveConfigDefaults(tuned, { DROBEK_MODULE_TUNED_DEFAULTS: '{"allow":{"domains":["acme.com"]}}' })).toEqual({
      greeting: 'hi',
      allow: { domains: ['acme.com'] },
    });
    expect(effectiveConfigDefaults(tuned, {})).toBe(tuned.configDefaults);
    expect(effectiveConfigDefaults(tuned, { DROBEK_MODULE_TUNED_DEFAULTS: '  ' })).toBe(tuned.configDefaults);
  });

  it('refuses an invalid override at start, with the issue path', () => {
    expect(() => effectiveConfigDefaults(tuned, { DROBEK_MODULE_TUNED_DEFAULTS: '{"greeting":"far too long a greeting"}' })).toThrow(
      /DROBEK_MODULE_TUNED_DEFAULTS: the defaults of the module "tuned" do not pass its configSchema — greeting: /
    );
    expect(() => effectiveConfigDefaults(tuned, { DROBEK_MODULE_TUNED_DEFAULTS: '{"allow":{"domains":"x"}}' })).toThrow(/allow\.domains: /);
    expect(() => effectiveConfigDefaults(tuned, { DROBEK_MODULE_TUNED_DEFAULTS: '{nope' })).toThrow(/DROBEK_MODULE_TUNED_DEFAULTS is not valid JSON/);
    expect(() => effectiveConfigDefaults(tuned, { DROBEK_MODULE_TUNED_DEFAULTS: '[1]' })).toThrow(/must be a JSON object/);
  });

  it('checkModuleSet returns the module with the effective defaults (others untouched) and warns about an unused override', () => {
    const log = logger();
    const [t, h] = checkModuleSet([tuned, host], { DROBEK_MODULE_TUNED_DEFAULTS: '{"greeting":"ahoj"}', DROBEK_MODULE_GHOST_DEFAULTS: '{}' }, log);
    expect(t.configDefaults).toEqual({ greeting: 'ahoj', allow: { domains: [] } });
    expect(tuned.configDefaults).toEqual({ greeting: 'hi', allow: { domains: [] } });
    expect(h).toBe(host);
    expect(Object.isFrozen(t)).toBe(true);
    expect(() => validateModule(t)).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('DROBEK_MODULE_GHOST_DEFAULTS is set, but no active module is named "ghost"'), expect.anything());
  });

  it('the runtime serves the effective defaults: effectiveConfig, skill_info config.defaults', async () => {
    const r = await loadModuleRuntime({
      env: { ...ENV, DROBEK_MODULE_TUNED_DEFAULTS: '{"allow":{"domains":["acme.com"]}}' },
      log: noopLogger,
      modules: [tuned],
      skillsDir: null,
      deps: { rateLimit: memoryRateLimiter() },
    });
    expect(r.effectiveConfig(r.get('tuned')!, {})).toEqual({ greeting: 'hi', allow: { domains: ['acme.com'] } });
    expect(r.effectiveConfig(r.get('tuned')!, { greeting: 'yo' })).toEqual({ greeting: 'yo', allow: { domains: ['acme.com'] } });
    expect(r.skillInfo('tuned')!.config!.defaults).toEqual({ greeting: 'hi', allow: { domains: ['acme.com'] } });
    await expect(
      loadModuleRuntime({ env: { ...ENV, DROBEK_MODULE_TUNED_DEFAULTS: '{"greeting":""}' }, log: noopLogger, modules: [tuned], skillsDir: null })
    ).rejects.toThrow(ModuleLoadError);
  });
});

// ── availability, dashboard.editor, hooks ────────────────────────────────────

describe('availability, dashboard.editor, hooks.onAppDelete', () => {
  it('validates availability and dashboard.editor', () => {
    expect(() => validateModule(defineModule({ ...base, name: 'mm', availability: 'opt-in' }))).not.toThrow();
    expect(() => validateModule(defineModule({ ...base, name: 'mm', availability: 'maybe' as never }))).toThrow(/availability must be/);
    expect(() => validateModule(defineModule({ ...base, name: 'mm', dashboard: { editor: 'upstreams' } }))).not.toThrow();
    expect(() => validateModule(defineModule({ ...base, name: 'mm', dashboard: { editor: 'grid' as never } }))).toThrow(/dashboard\.editor must be one of collections, upstreams/);
    expect(() => validateModule(defineModule({ ...base, name: 'mm', hooks: { onAppDelete: 'x' as never } }))).toThrow(/hooks\.onAppDelete must be a function/);
  });
});

// ── the runtime ──────────────────────────────────────────────────────────────

describe('the runtime (contributions, hooks, errors, skill_info, the dashboard view)', () => {
  let close: () => Promise<void>;
  let app: HookApp;
  let rt: ModuleRuntime;
  const log = logger();
  const seen: { hook: string; app: HookApp; greeters: string[] }[] = [];
  const watcher: AnyModule = defineModule({
    ...base,
    name: 'watcher',
    availability: 'opt-in',
    dashboard: { editor: 'collections' },
    hooks: {
      onAppCreate: (a: HookApp, s: ModuleServices) => void seen.push({ hook: 'create', app: a, greeters: s.contributions<Greeter>('host.greeter').map((g) => g.id) }),
      onAppDelete: (a: HookApp, s: ModuleServices) => void seen.push({ hook: 'delete', app: a, greeters: s.contributions<Greeter>('host.greeter').map((g) => g.id) }),
    },
  });
  const failing = defineModule({
    ...base,
    name: 'failing',
    hooks: {
      onAppDelete: () => {
        throw new Error('clean-up failed');
      },
    },
  });

  beforeAll(async () => {
    const fresh = await freshDb();
    close = () => fresh.pg.close();
    const [w] = await fresh.db.insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
    const [a] = await fresh.db.insert(apps).values({ workspaceId: w.id, slug: 'shop' }).returning();
    app = { id: a.id, slug: a.slug, workspaceId: w.id };
    rt = await loadModuleRuntime({
      env: ENV,
      log,
      modules: [formal, failing, host, watcher, pirate],
      skillsDir: null,
      deps: { log, rateLimit: memoryRateLimiter(), principal: async () => ({ kind: 'anon' }), email: { send: async () => {} } },
    });
  });

  afterAll(async () => {
    await close();
  });

  const req = (path: string): PlatformRequest => ({
    method: 'GET',
    path,
    query: '',
    header: (n) => (n.toLowerCase() === 'host' ? 'shop--preview.apps.example' : null),
    clientIp: '203.0.113.7',
    readBody: async () => null,
  });

  it('contributions() in module order; [] for a slot without contributions or an unknown slot', () => {
    expect(rt.contributions<Greeter>('host.greeter').map((g) => g.id)).toEqual(['formal', 'pirate']);
    expect(rt.contributions<Greeter>('host.greeter')[1].greet('Ada')).toBe('Ahoy Ada');
    expect(rt.contributions('host.nothing')).toEqual([]);
    expect(rt.contributions('nobody.slot')).toEqual([]);
  });

  it('a route reads the contributions through ctx.contributions', async () => {
    const res = await rt.handle(req('/__drobek/v1/host/greeters'), app);
    expect(JSON.parse(String(res.body))).toEqual(['formal', 'pirate']);
    expect(JSON.parse(String((await rt.handle(req('/__drobek/v1/host/greet/formal'), app)).body))).toEqual({ text: 'Good day, Ada' });
  });

  it('answers a declared or core code; an undeclared code becomes 500 internal_error and is logged', async () => {
    const declared = await rt.handle(req('/__drobek/v1/host/greet/nope'), app);
    expect(declared.status).toBe(404);
    expect(JSON.parse(String(declared.body))).toMatchObject({ error: 'unknown_greeter' });
    expect((await rt.handle(req('/__drobek/v1/host/core-code'), app)).status).toBe(409);
    log.error.mockClear();
    const undeclared = await rt.handle(req('/__drobek/v1/host/undeclared'), app);
    expect(undeclared.status).toBe(500);
    expect(JSON.parse(String(undeclared.body))).toMatchObject({ error: 'internal_error', message: 'drobek hit an internal error.' });
    expect(log.error).toHaveBeenCalledWith('module request failed', expect.objectContaining({ error: expect.stringContaining('"made_up_code"') }));
  });

  it('hooks get the services with contributions; onAppDelete runs for every module, a failure is logged', async () => {
    seen.length = 0;
    log.error.mockClear();
    await rt.runHook('onAppCreate', app);
    await rt.runHook('onAppDelete', app);
    expect(seen).toEqual([
      { hook: 'create', app, greeters: ['formal', 'pirate'] },
      { hook: 'delete', app, greeters: ['formal', 'pirate'] },
    ]);
    expect(log.error).toHaveBeenCalledWith('module hook failed', expect.objectContaining({ module: 'failing', hook: 'onAppDelete' }));
  });

  it('skill_info returns errors + availability; errorCatalogue() one section per module with errors', () => {
    expect(rt.skillInfo('host')).toMatchObject({ errors: host.errors, availability: 'default' });
    expect(rt.skillInfo('watcher')).toMatchObject({ errors: [], availability: 'opt-in' });
    expect(rt.errorCatalogue()).toEqual([{ module: 'host', errors: host.errors }]);
  });

  it('the dashboard view carries availability and the declared editor', async () => {
    expect(await rt.moduleView(app, 'watcher')).toMatchObject({ availability: 'opt-in', editor: 'collections' });
    expect(await rt.moduleView(app, 'host')).toMatchObject({ availability: 'default', editor: null });
  });

  it('moduleFacts (NSO-347): version, source, contract, requires, slots with their contributors, contributions, limits, errors', () => {
    expect(rt.moduleFacts('host')).toEqual({
      name: 'host',
      version: '1.0.0',
      source: 'builtin',
      contract: '^1.1',
      availability: 'default',
      requires: [],
      slots: [
        {
          name: 'host.greeter',
          description: 'a way to greet someone',
          unique: 'id',
          contributions: [
            { module: 'formal', key: 'formal' },
            { module: 'pirate', key: 'pirate' },
          ],
        },
      ],
      contributes: [],
      limits: [],
      errors: host.errors,
      editor: null,
    });
    expect(rt.moduleFacts('pirate')).toMatchObject({ slots: [], contributes: [{ slot: 'host.greeter', host: 'host', key: 'pirate' }] });
    expect(rt.moduleFacts('watcher')).toMatchObject({ availability: 'opt-in', editor: 'collections', contributes: [] });
    expect(rt.moduleFacts('nope')).toBeNull();
    expect(rt.moduleFactsList().map((f) => f.name)).toEqual(['formal', 'failing', 'host', 'watcher', 'pirate']);
    // Never a path on disk: the facts are plain names and versions.
    expect(JSON.stringify(rt.moduleFactsList())).not.toMatch(/node_modules|\/(?:data|app|home|Users)\//);
  });

  it('skill_info and the dashboard view carry the same facts (the MCP twin of the dashboard page)', async () => {
    const facts = rt.moduleFacts('pirate')!;
    expect(rt.skillInfo('pirate')).toMatchObject({
      version: facts.version,
      source: facts.source,
      contract: facts.contract,
      availability: facts.availability,
      requires: facts.requires,
      slots: facts.slots,
      contributes: facts.contributes,
      errors: facts.errors,
    });
    expect(rt.skillInfo('host')?.slots).toEqual(rt.moduleFacts('host')!.slots);
    expect(await rt.moduleView(app, 'host')).toMatchObject({
      source: 'builtin',
      contract: '^1.1',
      requires: [],
      slots: rt.moduleFacts('host')!.slots,
      contributes: [],
      errors: host.errors,
    });
  });
});
