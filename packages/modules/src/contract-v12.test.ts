/**
 * Module contract 1.2: `jobs` — the load-time rules, a 1.1 module
 * loading unchanged, skill_info, the apps a per-app job runs for and the
 * contexts its runs get (PGlite), and the test kit's runJob.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { apps, moduleConfigs, workspaceModules, workspaces } from '@drobek/db';
import { noopLogger } from '@drobek/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  JOB_MAX_INTERVAL_MS,
  JOB_MIN_INTERVAL_MS,
  MODULE_CONTRACT_VERSION,
  defineModule,
  parseJobInterval,
  type AnyModule,
  type AppJobContext,
  type ServerJobContext,
} from './contract.js';
import { ModuleLoadError, loadModules, validateModule } from './registry.js';
import { loadModuleRuntime, memoryRateLimiter, type JobAppRow, type ModuleRuntime } from './runtime.js';
import { setModuleSecret } from './secrets.server.js';
import { createModuleTestContext } from './testing.js';
import { freshDb, type TestDb } from './test/db.js';

const ENV = {
  APPS_DOMAIN: 'apps.example',
  PUBLIC_APP_URL: 'https://drobek.example',
  PUBLIC_ORIGIN: 'https://drobek.example',
  DROBEK_MASTER_KEY: '11'.repeat(32),
  DROBEK_MIGRATE_ON_START: '0',
};

const base = { version: '1.0.0', contract: '^1.2', skill: { useWhen: 'x', markdown: '# x' }, configSchema: z.object({}), configDefaults: {} };

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const importer = (map: Record<string, unknown>) => async (pkg: string) => {
  if (!(pkg in map)) throw new Error(`Cannot find package '${pkg}'`);
  return map[pkg];
};

const syncConfig = z.object({ every: z.string(), source: z.string() });
type SyncConfig = z.infer<typeof syncConfig>;

// Typed without annotations: `every` and `run` get their parameter types from the job's scope.
const sync = defineModule<SyncConfig>({
  ...base,
  name: 'sync',
  configSchema: syncConfig,
  configDefaults: { every: '', source: '' },
  secrets: [{ name: 'SYNC_KEY', description: 'the upstream key' }],
  limits: [{ env: 'SYNC_ROWS', default: 100, meaning: 'rows per import' }],
  availability: 'opt-in',
  jobs: [
    {
      name: 'import',
      scope: 'app',
      description: 'imports the source into a collection',
      every: (config) => (config.every || null) as '5m' | null,
      async run(ctx) {
        const key = await ctx.secrets.get('SYNC_KEY');
        const limits = await ctx.limits();
        ctx.log.info('import', { source: ctx.config.source, key: key !== null, rows: limits.SYNC_ROWS });
      },
    },
    {
      name: 'cleanup',
      every: '1h',
      async run(ctx) {
        for await (const a of ctx.apps()) ctx.log.info('cleanup', { app: a.app.slug, source: a.config.source });
      },
    },
  ],
});

// ── the load-time rules ──────────────────────────────────────────────────────

describe('jobs: load-time rules', () => {
  it('the server implements contract 1.2.0; a 1.1 module (no jobs, ^1.1) validates and loads unchanged', async () => {
    expect(MODULE_CONTRACT_VERSION).toBe('1.2.0');
    const old = defineModule({ ...base, name: 'old', contract: '^1.1' });
    expect(() => validateModule(old)).not.toThrow();
    const log = logger();
    const mods = await loadModules({ DROBEK_MODULES: 'old' }, { importer: importer({ 'drobek-module-old': old }), log });
    expect(mods.map((m) => m.name)).toEqual(['old']);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('parseJobInterval: milliseconds or a whole count with s/m/h/d', () => {
    expect(parseJobInterval(60_000)).toBe(60_000);
    expect(parseJobInterval('30s')).toBe(30_000);
    expect(parseJobInterval('5m')).toBe(300_000);
    expect(parseJobInterval('2h')).toBe(7_200_000);
    expect(parseJobInterval('1d')).toBe(86_400_000);
    for (const bad of [0, -5, 1.5, Number.NaN, '5', '5 min', '1.5h', '', '5w', null, undefined, {}]) expect(parseJobInterval(bad)).toBeNull();
    expect(JOB_MIN_INTERVAL_MS).toBe(60_000);
    expect(JOB_MAX_INTERVAL_MS).toBe(30 * 86_400_000);
  });

  it('accepts a server job with a fixed interval and an app job with a fixed or config-driven one', () => {
    expect(() => validateModule(sync)).not.toThrow();
    const fixedApp = defineModule({ ...base, name: 'fixed', jobs: [{ name: 'tick', scope: 'app', every: 120_000, run: () => {} }] });
    expect(() => validateModule(fixedApp)).not.toThrow();
  });

  it('refuses a bad job at start, naming the module and the job', () => {
    const cases: [unknown, RegExp][] = [
      ['not an array', /jobs must be an array/],
      [[{ name: 'Bad-Name', every: '5m', run: () => {} }], /job name "Bad-Name" must match/],
      [[{ name: 'twice', every: '5m', run: () => {} }, { name: 'twice', every: '1h', run: () => {} }], /job "twice" is declared twice/],
      [[{ name: 'norun', every: '5m' }], /job "norun": run must be a function/],
      [[{ name: 'scope', scope: 'workspace', every: '5m', run: () => {} }], /scope must be 'server' or 'app'/],
      [[{ name: 'fast', every: '30s', run: () => {} }], /job "fast": every must be between 1 minute and 30 days/],
      [[{ name: 'slow', every: '31d', run: () => {} }], /every must be between 1 minute and 30 days/],
      [[{ name: 'garbage', every: 'soon', run: () => {} }], /every must be milliseconds or a count with a unit/],
      [[{ name: 'fromconfig', every: () => '5m', run: () => {} }], /only a scope: 'app' job may read its interval/],
      [[{ name: 'blank', every: '5m', description: ' ', run: () => {} }], /description must be a non-empty string/],
    ];
    for (const [jobs, message] of cases) {
      const m = defineModule({ ...base, name: 'broken', jobs: jobs as never });
      expect(() => validateModule(m)).toThrow(ModuleLoadError);
      expect(() => validateModule(m)).toThrow(new RegExp(`module "broken": .*${message.source}`));
    }
  });

  it('warns (never refuses) when a module with jobs declares a range that admits servers without them', async () => {
    const log = logger();
    const loose = defineModule({ ...base, name: 'loose', contract: '^1.1', jobs: [{ name: 'tick', every: '5m', run: () => {} }] });
    const mods = await loadModules({ DROBEK_MODULES: 'loose' }, { importer: importer({ 'drobek-module-loose': loose }), log });
    expect(mods.map((m) => m.name)).toEqual(['loose']);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(`module "loose" declares jobs, which need module contract 1.2`), expect.anything());
    const log2 = logger();
    await loadModules({ DROBEK_MODULES: 'sync' }, { importer: importer({ 'drobek-module-sync': sync }), log: log2 });
    expect(log2.warn).not.toHaveBeenCalled();
  });
});

// ── runtime (PGlite) ─────────────────────────────────────────────────────────

describe('jobs: runtime', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let rt: ModuleRuntime;
  const ids: Record<string, { id: string; slug: string; workspaceId: string }> = {};

  beforeAll(async () => {
    const fresh = await freshDb();
    db = fresh.db;
    close = () => fresh.pg.close();
    const [on] = await db.insert(workspaces).values({ kind: 'team', slug: 'on', name: 'On' }).returning();
    const [off] = await db.insert(workspaces).values({ kind: 'team', slug: 'off', name: 'Off' }).returning();
    await db.insert(workspaceModules).values({ workspaceId: on.id, module: 'sync' });
    for (const [slug, ws] of [
      ['alpha', on],
      ['bravo', on],
      ['gone', on],
      ['locked', on],
      ['elsewhere', off],
      ['unconfigured', on],
    ] as const) {
      const [a] = await db.insert(apps).values({ workspaceId: ws.id, slug }).returning();
      ids[slug] = { id: a.id, slug, workspaceId: ws.id };
    }
    await db.update(apps).set({ deletedAt: new Date() }).where(eq(apps.id, ids.gone.id));
    await db.update(apps).set({ lockedReason: 'spam' }).where(eq(apps.id, ids.locked.id));
    for (const slug of ['alpha', 'bravo', 'gone', 'locked', 'elsewhere']) {
      await db.insert(moduleConfigs).values({ appId: ids[slug].id, module: 'sync', config: { every: '5m', source: slug } });
    }
    await db
      .update(moduleConfigs)
      .set({ pending: { patch: { every: '10m' }, changes: ['every: 10m'], proposed_at: new Date().toISOString(), proposed_by: null } })
      .where(eq(moduleConfigs.appId, ids.bravo.id));
    await setModuleSecret({ appId: ids.alpha.id, module: 'sync', name: 'SYNC_KEY', value: 'sk-sync-SECRET', env: ENV });
    rt = await loadModuleRuntime({
      env: ENV,
      log: noopLogger,
      modules: [sync as AnyModule],
      skillsDir: null,
      deps: { rateLimit: memoryRateLimiter() },
    });
  });

  afterAll(async () => {
    await close();
  });

  async function collect(batch?: number): Promise<JobAppRow[]> {
    const out: JobAppRow[] = [];
    for await (const row of rt.jobApps(sync as AnyModule, batch)) out.push(row);
    return out;
  }

  it('jobApps: live apps with a stored config whose workspace has the module on — never deleted, taken down, unconfigured or switched-off ones', async () => {
    const rows = await collect();
    expect(rows.map((r) => r.app.slug).sort()).toEqual(['alpha', 'bravo']);
    const bravo = rows.find((r) => r.app.slug === 'bravo')!;
    expect(bravo.config).toEqual({ every: '5m', source: 'bravo' });
    expect(bravo.pendingConfig).toEqual({ every: '10m', source: 'bravo' });
    expect(rows.find((r) => r.app.slug === 'alpha')!.pendingConfig).toBeNull();
    expect((await collect(1)).map((r) => r.app.slug).sort()).toEqual(['alpha', 'bravo']);
  });

  it('appJobContext: the app, its config, declared secrets, workspace limits, a namespaced rate limiter', async () => {
    const [alpha] = (await collect()).filter((r) => r.app.slug === 'alpha');
    const signal = new AbortController().signal;
    const ctx = (await rt.appJobContext(sync as AnyModule, alpha, { job: 'import', signal, lastSuccessAt: null })) as AppJobContext<SyncConfig>;
    expect(ctx).toMatchObject({ module: 'sync', job: 'import', app: { slug: 'alpha' }, config: { source: 'alpha' }, lastSuccessAt: null });
    expect(ctx.signal).toBe(signal);
    expect(await ctx.secrets.get('SYNC_KEY')).toBe('sk-sync-SECRET');
    await expect(ctx.secrets.get('OTHER_KEY')).rejects.toThrow(/undeclared secret/);
    expect((await ctx.limits()).SYNC_ROWS).toBe(100);
    expect((await ctx.rateLimit('calls', 'x', 1, 60_000)).ok).toBe(true);
    expect((await ctx.rateLimit('calls', 'x', 1, 60_000)).ok).toBe(false);
    expect(Object.keys(ctx)).not.toContain('email');
    expect(Object.keys(ctx)).not.toContain('principal');
  });

  it('serverJobContext: the server limits and apps() over the same apps', async () => {
    const ctx = rt.serverJobContext(sync as AnyModule, { job: 'cleanup', signal: new AbortController().signal, lastSuccessAt: new Date(5) }) as ServerJobContext<SyncConfig>;
    expect(ctx).toMatchObject({ module: 'sync', job: 'cleanup', lastSuccessAt: new Date(5) });
    expect((await ctx.limits()).SYNC_ROWS).toBe(100);
    const seen: string[] = [];
    for await (const a of ctx.apps()) seen.push(a.config.source);
    expect(seen.sort()).toEqual(['alpha', 'bravo']);
  });

  it('skill_info lists the jobs of a module that declares them, and nothing for one that does not', async () => {
    expect(rt.skillInfo('sync')?.jobs).toEqual([
      { name: 'import', scope: 'app', every: 'config', description: 'imports the source into a collection' },
      { name: 'cleanup', scope: 'server', every: '1h', description: null },
    ]);
    const plain = await loadModuleRuntime({ env: ENV, log: noopLogger, modules: [defineModule({ ...base, name: 'plain' })], skillsDir: null });
    expect(plain.skillInfo('plain')).not.toHaveProperty('jobs');
  });
});

// ── the test kit ─────────────────────────────────────────────────────────────

describe('jobs: createModuleTestContext().runJob', () => {
  it('runs an app job with the test config and secrets; skips it when every(config) gives no interval', async () => {
    const log = logger();
    const t = createModuleTestContext(sync, { config: { every: '5m', source: 'feed' }, secrets: { SYNC_KEY: 'k' }, log });
    expect(await t.runJob('import')).toEqual({ ran: true, intervalMs: 300_000 });
    expect(log.info).toHaveBeenCalledWith('import', { source: 'feed', key: true, rows: 100 });
    const idle = createModuleTestContext(sync, { config: { every: '', source: 'feed' } });
    expect(await idle.runJob('import')).toEqual({ ran: false, intervalMs: null });
  });

  it('runs a server job with apps() yielding the test app, and rejects an unknown job or the job’s own error', async () => {
    const log = logger();
    const t = createModuleTestContext(sync, { config: { every: '', source: 'feed' }, log });
    expect(await t.runJob('cleanup')).toEqual({ ran: true, intervalMs: 3_600_000 });
    expect(log.info).toHaveBeenCalledWith('cleanup', { app: 'test', source: 'feed' });
    await expect(t.runJob('nope')).rejects.toThrow(/has no job "nope"/);
    const failing = defineModule({ ...base, name: 'failing', jobs: [{ name: 'boom', every: '5m', run: () => Promise.reject(new Error('upstream down')) }] });
    await expect(createModuleTestContext(failing).runJob('boom')).rejects.toThrow('upstream down');
  });
});
