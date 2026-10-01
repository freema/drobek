/**
 * Operator-only modules: a module without a skill loads only when nothing of
 * it reaches apps (appSurfaceOf, and contributions to `operatorOnly` slots
 * only), and the runtime keeps it away from agents and app owners —
 * skill_info, get_app, configure_module, the module page, the module routes —
 * while the summary (/api/version, /healthz) and the module facts (the
 * super-admin's workspace Modules page) mark it `operatorOnly`.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { noopLogger } from '@drobek/core';
import { apps, workspaces } from '@drobek/db';
import { defineModule, type AnyModule } from './contract.js';
import { ERROR_REPORTER_SLOT, defineErrorReporter } from './error-reporter-slot.js';
import { appSurfaceOf, checkModuleSet, isAppFacing, validateModule } from './registry.js';
import { loadModuleRuntime, memoryRateLimiter, type ModuleRuntime, type PlatformRequest } from './runtime.js';
import { checkSkill, moduleSkillSource } from './skill-check/index.js';
import { freshDb } from './test/db.js';
import { echo } from './test/fixtures.js';

const sink = defineModule({
  name: 'sink',
  version: '1.0.0',
  contract: '^1.2',
  configSchema: z.object({}),
  configDefaults: {},
  contributes: { [ERROR_REPORTER_SLOT]: defineErrorReporter({ id: 'sink', label: 'Sink', report: () => {} }) },
});

function operator(extra: Record<string, unknown>): AnyModule {
  return defineModule({ name: 'op', version: '1.0.0', configSchema: z.object({}), configDefaults: {}, ...extra } as AnyModule);
}

const host = defineModule({
  name: 'host',
  version: '1.0.0',
  skill: { useWhen: 'a test needs a slot host', markdown: '# host\n' },
  configSchema: z.object({}),
  configDefaults: {},
  slots: {
    'host.way': { schema: z.object({ id: z.string() }), unique: 'id', description: 'a way apps use' },
    'host.relay': { schema: z.object({ id: z.string() }), unique: 'id', description: 'where the server sends things', operatorOnly: true },
  },
});

describe('a module without a skill', () => {
  it('loads when nothing of it reaches apps: operator slots, limits, hooks, server jobs, a title', () => {
    expect(appSurfaceOf(sink)).toEqual([]);
    expect(isAppFacing(sink)).toBe(false);
    expect(() => validateModule(sink)).not.toThrow();
    expect(checkModuleSet([sink], {})).toHaveLength(1);
    const quietOps = operator({
      limits: [{ env: 'OP_SWEEP_BATCH', default: 50, meaning: 'rows one sweep removes' }],
      hooks: { onAppDelete: () => {} },
      jobs: [{ name: 'sweep', every: '1h', run: () => {} }],
      dashboard: { title: 'Server sweeper' },
      slots: { 'op.relay': { schema: z.object({ id: z.string() }), description: 'operator relays', operatorOnly: true } },
    });
    expect(appSurfaceOf(quietOps)).toEqual([]);
    expect(() => validateModule(quietOps)).not.toThrow();
  });

  it.each([
    ['routes', { routes: () => {} }, /routes/],
    ['an SDK', { sdk: echo.sdk }, /sdk/],
    ['a config field', { configSchema: z.object({ level: z.string().optional() }) }, /configSchema \(an app config\)/],
    ['a config that keeps any key', { configSchema: z.looseObject({}) }, /configSchema \(an app config\)/],
    ['confirmRequired', { confirmRequired: () => [] }, /confirmRequired/],
    ['per-app secrets', { secrets: [{ name: 'OP_KEY', description: 'the key' }] }, /secrets/],
    ['rules', { rules: { ops: { send: 'Send it' } } }, /rules/],
    ['its own error codes', { errors: [{ code: 'op_failed', meaning: 'It failed.', fix: 'Retry.' }] }, /errors/],
    ['an owner authority', { mail: { prepare: async () => ({}) } }, /mail/],
    ['appInfo', { appInfo: () => ({}) }, /appInfo/],
    ['opt-in availability', { availability: 'opt-in' }, /availability 'opt-in'/],
    ['a dashboard editor', { dashboard: { editor: 'collections' } }, /dashboard\.editor/],
    ['a per-app job', { jobs: [{ name: 'per_app', scope: 'app', every: '1h', run: () => {} }] }, /a scope: 'app' job/],
    ['a slot apps use', { slots: { 'op.way': { schema: z.object({}), description: 'a way' } } }, /the slot "op\.way"/],
  ])('is refused with %s — the start error names it', (_what, extra, part) => {
    const m = operator(extra);
    expect(() => validateModule(m)).toThrow(/module "op": skill is required: the module reaches apps through /);
    expect(() => validateModule(m)).toThrow(part);
  });

  it('may contribute to an operatorOnly slot of a host module, not to a slot apps use', () => {
    expect(() => checkModuleSet([host, operator({ contributes: { 'host.relay': { id: 'a' } } })], {})).not.toThrow();
    expect(() => checkModuleSet([host, operator({ contributes: { 'host.way': { id: 'a' } } })], {})).toThrow(
      /module "op" has no skill, but contributes to the slot "host\.way" \(module "host"\), which reaches apps — add skill: \{ useWhen, markdown \}/
    );
    const documented = operator({ skill: { useWhen: 'a test needs a way', markdown: '# op\n' }, contributes: { 'host.way': { id: 'a' } } });
    expect(() => checkModuleSet([host, documented], {})).not.toThrow();
  });

  it('operatorOnly is a boolean; a declared skill is still checked', () => {
    expect(() => validateModule(operator({ slots: { 'op.relay': { schema: z.object({}), description: 'x', operatorOnly: 'yes' } } }))).toThrow(
      /slot "op\.relay": operatorOnly must be true or false/
    );
    expect(() => validateModule(operator({ skill: { useWhen: '', markdown: '# op\n' } }))).toThrow(/skill\.useWhen is required/);
    expect(() => validateModule(operator({ skill: 'op' }))).toThrow(/skill\.useWhen is required/);
    expect(() => validateModule(operator({ skill: { useWhen: 'x', markdown: ' ' } }))).toThrow(/skill\.markdown is required/);
  });

  it('has no skill to check', async () => {
    expect(await checkSkill(sink)).toEqual([]);
    expect(() => moduleSkillSource(sink)).toThrow(/module "sink" has no skill \(an operator-only module\)/);
  });
});

describe('the runtime with an operator-only module', () => {
  let pg: PGlite;
  let rt: ModuleRuntime;
  let app: { id: string; slug: string; workspaceId: string; workspaceSlug: string };

  beforeAll(async () => {
    const fresh = await freshDb();
    pg = fresh.pg;
    const [w] = await fresh.db.insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
    const [a] = await fresh.db.insert(apps).values({ workspaceId: w.id, slug: 'shop' }).returning();
    app = { id: a.id, slug: a.slug, workspaceId: w.id, workspaceSlug: w.slug };
    rt = await loadModuleRuntime({
      env: { APPS_DOMAIN: 'apps.example', PUBLIC_APP_URL: 'https://drobek.example', DROBEK_MIGRATE_ON_START: '0', DROBEK_MASTER_KEY: '11'.repeat(32) },
      log: noopLogger,
      modules: [echo, sink],
      skillsDir: null,
      deps: { rateLimit: memoryRateLimiter(), principal: async () => ({ kind: 'anon' }), email: { send: async () => {} } },
    });
  });

  afterAll(async () => {
    await pg.close();
  });

  it('is active, but agents never see it: no skill in the list, skill_info(name) is unknown', () => {
    expect(rt.get('sink')).toBe(rt.modules[1]);
    expect(rt.appFacing.map((m) => m.name)).toEqual(['echo']);
    expect(rt.skillList().map((s) => s.name)).toEqual(['echo']);
    expect(rt.skillInfo('sink')).toBeNull();
    expect(rt.contributions(ERROR_REPORTER_SLOT)).toHaveLength(1);
  });

  it('operators see it: the summary and the facts mark it operatorOnly', () => {
    expect(rt.summary()).toEqual([
      { name: 'echo', version: '1.2.3', source: 'builtin', contract: null },
      { name: 'sink', version: '1.0.0', source: 'builtin', contract: '^1.2', operatorOnly: true },
    ]);
    expect(rt.moduleFacts('echo')).toMatchObject({ operatorOnly: false });
    expect(rt.moduleFacts('sink')).toMatchObject({ operatorOnly: true, contributes: [{ slot: 'errors.reporter', host: 'core', key: 'sink' }] });
    expect(rt.moduleFactsList().map((f) => f.name)).toEqual(['echo', 'sink']);
  });

  it("an app's modules, configure_module and the module page answer it like an unknown module", async () => {
    expect(Object.keys(await rt.appModules(app))).toEqual(['echo']);
    expect(await rt.pendingSummary(app.id)).toEqual([]);
    const configure = rt.configure({ app, module: 'sink', patch: {}, actorUserId: '00000000-0000-0000-0000-000000000000', surface: 'mcp' });
    await expect(configure).rejects.toMatchObject({ code: 'not_found', details: { available: ['echo'] } });
    await expect(rt.moduleView(app, 'sink')).rejects.toMatchObject({ code: 'not_found', details: { available: ['echo'] } });
  });

  it('has no routes on the app host: /__drobek/v1/sink/… is an unknown module', async () => {
    const request: PlatformRequest = {
      method: 'GET',
      path: '/__drobek/v1/sink/events',
      query: '',
      header: (n) => (n.toLowerCase() === 'host' ? 'shop--preview.apps.example' : null),
      clientIp: '203.0.113.7',
      readBody: async () => null,
    };
    const res = await rt.handle(request, app);
    expect(res.status).toBe(404);
    expect(JSON.parse(String(res.body))).toMatchObject({ error: 'not_found', details: { available: ['echo'] } });
  });
});
