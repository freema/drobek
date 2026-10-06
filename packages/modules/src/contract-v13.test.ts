/**
 * Module contract 1.3: `secretsFor` (secrets that follow the app config),
 * a route's `ctx.records.create`, `passwordGate: 'skip'` and the single
 * `webhooks` owner — the load-time rules, the runtime's view of them (PGlite)
 * and the test kit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apps, workspaces } from '@drobek/db';
import { noopLogger } from '@drobek/core';
import { z } from 'zod';
import { MODULE_CONTRACT_VERSION, defineModule, type AnyModule } from './contract.js';
import { ModuleError } from './errors.js';
import { loadModules, validateModule } from './registry.js';
import { loadModuleRuntime, memoryRateLimiter, type ModuleRuntime } from './runtime.js';
import { setModuleSecret } from './secrets.server.js';
import { createModuleTestContext } from './testing.js';
import { freshDb } from './test/db.js';

const ENV = {
  APPS_DOMAIN: 'apps.example',
  PUBLIC_APP_URL: 'https://drobek.example',
  PUBLIC_ORIGIN: 'https://drobek.example',
  DROBEK_MASTER_KEY: '22'.repeat(32),
  DROBEK_MIGRATE_ON_START: '0',
};

const hooksConfig = z.object({ endpoints: z.record(z.string(), z.object({ secret: z.string() })) });
type HooksConfig = z.infer<typeof hooksConfig>;

const authority = { endpoints: async () => [], deliveries: async () => [] };

const hooks = defineModule<HooksConfig>({
  name: 'hooks',
  version: '1.0.0',
  contract: '^1.3',
  skill: { useWhen: 'x', markdown: '# x' },
  configSchema: hooksConfig,
  configDefaults: { endpoints: {} },
  secrets: [{ name: 'HOOKS_STATIC', description: 'always declared' }],
  secretsFor: (config) => Object.values(config.endpoints).map((e) => ({ name: e.secret, description: 'per endpoint', required: true })),
  webhooks: authority,
  routes(r) {
    r.post('/in/:name', { rule: 'public', bodyTypes: ['raw'], csrf: 'same-origin', passwordGate: 'skip' }, async (req, ctx) => {
      const [stored] = await ctx.records.create('inbox', [{ name: req.params.name }]);
      return { ok: true, stored, secret: (await ctx.secrets.get(ctx.config.endpoints[req.params.name]?.secret ?? 'HOOKS_STATIC')) !== null };
    });
    r.get('/in/:name', { rule: 'public', passwordGate: 'skip' }, async () => ({ ok: true }));
    r.post('/gated', { rule: 'public' }, async () => ({ ok: true }));
  },
});

const importer = (map: Record<string, unknown>) => async (pkg: string) => {
  if (!(pkg in map)) throw new Error(`Cannot find package '${pkg}'`);
  return map[pkg];
};

describe('contract 1.3: load-time rules', () => {
  it('the server implements 1.3.0; secretsFor must be a function; one module receives webhooks', async () => {
    expect(MODULE_CONTRACT_VERSION).toBe('1.3.0');
    expect(() => validateModule(hooks)).not.toThrow();
    expect(() => validateModule({ ...hooks, secretsFor: 'nope' } as unknown as AnyModule)).toThrow(/secretsFor must be a function/);
    const other = defineModule({ ...hooks, name: 'other' } as never);
    await expect(
      loadModules({ DROBEK_MODULES: 'hooks,other' }, { importer: importer({ 'drobek-module-hooks': hooks, 'drobek-module-other': other }), log: noopLogger })
    ).rejects.toThrow(/only one module may receive webhooks/);
  });
});

describe('contract 1.3: the runtime', () => {
  let rt: ModuleRuntime;
  let close: () => Promise<void>;
  let appId: string;

  beforeAll(async () => {
    const fresh = await freshDb();
    close = () => fresh.pg.close();
    const [ws] = await fresh.db.insert(workspaces).values({ kind: 'team', slug: 'v13', name: 'V13' }).returning();
    const [a] = await fresh.db.insert(apps).values({ workspaceId: ws.id, slug: 'v13app' }).returning();
    appId = a.id;
    await setModuleSecret({ appId, module: 'hooks', name: 'HOOKS_OLD', value: ['old', 'value'].join('-'), env: ENV });
    rt = await loadModuleRuntime({ env: ENV, log: noopLogger, modules: [hooks as AnyModule], skillsDir: null, deps: { rateLimit: memoryRateLimiter() } });
  });

  afterAll(async () => close());

  it('secretDocs: the declared secrets, then those of each config, each name once; bad names and a throwing secretsFor are skipped', () => {
    const cfg = (...names: string[]) => ({ endpoints: Object.fromEntries(names.map((n, i) => [`e${i}`, { secret: n }])) });
    expect(rt.secretDocs(hooks as AnyModule, cfg('HOOK_A'), cfg('HOOK_A', 'HOOK_B', 'bad name', 'HOOKS_STATIC')).map((s) => [s.name, s.required])).toEqual([
      ['HOOKS_STATIC', false],
      ['HOOK_A', true],
      ['HOOK_B', true],
    ]);
    const throwing = { ...hooks, secretsFor: () => { throw new Error('boom'); } } as unknown as AnyModule;
    expect(rt.secretDocs(throwing, cfg('HOOK_A')).map((s) => s.name)).toEqual(['HOOKS_STATIC']);
  });

  it('appSecretDocs: a stored secret the config no longer names stays listed, not required, so the owner can remove it', async () => {
    const docs = await rt.appSecretDocs(appId, hooks as AnyModule, { endpoints: { a: { secret: 'HOOK_A' } } });
    expect(docs.map((s) => [s.name, s.required])).toEqual([
      ['HOOKS_STATIC', false],
      ['HOOK_A', true],
      ['HOOKS_OLD', false],
    ]);
  });

  it('skipsPasswordGate: only a non-GET route that declares it', () => {
    expect(rt.skipsPasswordGate('POST', '/__drobek/v1/hooks/in/pay')).toBe(true);
    expect(rt.skipsPasswordGate('GET', '/__drobek/v1/hooks/in/pay')).toBe(false);
    expect(rt.skipsPasswordGate('HEAD', '/__drobek/v1/hooks/in/pay')).toBe(false);
    expect(rt.skipsPasswordGate('POST', '/__drobek/v1/hooks/gated')).toBe(false);
    expect(rt.skipsPasswordGate('POST', '/__drobek/v1/nope/in/pay')).toBe(false);
    expect(rt.skipsPasswordGate('POST', '/index.html')).toBe(false);
  });
});

describe('contract 1.3: the test kit', () => {
  it('reads a config-named secret and writes records through createRecords; without it records.create is unavailable', async () => {
    const config = { endpoints: { pay: { secret: 'HOOK_PAY' } } };
    const written: unknown[] = [];
    const t = await createModuleTestContext(hooks, {
      config,
      secrets: { HOOK_PAY: ['pay', 'value'].join('-') },
      createRecords: async (collection, records) => {
        written.push({ collection, records });
        return records.map((r) => ({ ...r, _id: 'r1' }));
      },
    });
    const res = await t.request('POST', '/in/pay', { rawBody: 'x', headers: { 'content-type': 'text/plain' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, stored: { name: 'pay', _id: 'r1' }, secret: true });
    expect(written).toEqual([{ collection: 'inbox', records: [{ name: 'pay' }] }]);

    const bare = await createModuleTestContext(hooks, { config });
    await expect(bare.ctx.records.create('inbox', [{}])).rejects.toBeInstanceOf(ModuleError);
  });
});
