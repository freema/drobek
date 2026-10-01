import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineModule } from './contract.js';
import { checkRequires, endUserAuthorityOf, loadModules, mailAuthorityOf, packageNameFor, parseModuleList, recordsAuthorityOf, resolveModule, syncAuthorityOf, upstreamsAuthorityOf, validateModule } from './registry.js';
import { ModuleLoadError } from './errors.js';
import { echo, quiet } from './test/fixtures.js';

const importer = (map: Record<string, unknown>) => async (pkg: string) => {
  if (!(pkg in map)) throw new Error(`Cannot find package '${pkg}'`);
  return map[pkg];
};

describe('registry', () => {
  it('parses DROBEK_MODULES', () => {
    expect(parseModuleList(' hello, ,echo,hello ')).toEqual(['hello', 'echo']);
    expect(parseModuleList(undefined)).toEqual([]);
  });

  it('maps a short name to drobek-module-<name>; full names verbatim', () => {
    expect(packageNameFor('hello')).toBe('drobek-module-hello');
    expect(packageNameFor('drobek-module-hello')).toBe('drobek-module-hello');
    expect(packageNameFor('@acme/drobek-crm')).toBe('@acme/drobek-crm');
  });

  it('loads modules in order from default or `module` exports', async () => {
    const mods = await loadModules(
      { DROBEK_MODULES: 'echo,@acme/quiet' },
      { importer: importer({ 'drobek-module-echo': { default: echo }, '@acme/quiet': { module: quiet } }) }
    );
    expect(mods.map((m) => m.name)).toEqual(['echo', 'quiet']);
    expect(await loadModules({}, { importer: importer({}) })).toEqual([]);
  });

  it('refuses to start on an unknown package, a non-module, a duplicate', async () => {
    await expect(resolveModule('nope', { importer: importer({}) })).rejects.toThrow(/drobek refuses to start: .*"drobek-module-nope" cannot be loaded/);
    await expect(resolveModule('x', { importer: importer({ 'drobek-module-x': { default: { name: 'x' } } }) })).rejects.toThrow(
      /does not export a drobek module/
    );
    await expect(
      loadModules({ DROBEK_MODULES: 'drobek-module-a,@acme/b' }, { importer: importer({ 'drobek-module-a': echo, '@acme/b': { default: echo } }) })
    ).rejects.toThrow(/two entries .* "echo"/);
  });

  it('validates the structure', () => {
    const base = { version: '1.0.0', skill: { useWhen: 'x', markdown: '# x' }, configSchema: z.object({ a: z.number() }), configDefaults: { a: 1 } };
    expect(() => validateModule(defineModule({ ...base, name: 'Bad' }))).toThrow(ModuleLoadError);
    expect(() => validateModule(defineModule({ ...base, name: 'sdk' }))).toThrow(/reserved/);
    expect(() => validateModule(defineModule({ ...base, name: 'ok', version: 'v1' }))).toThrow(/semver/);
    expect(() => validateModule(defineModule({ ...base, name: 'ok', configDefaults: { a: 'x' } as never }))).toThrow(/configDefaults/);
    expect(() => validateModule(defineModule({ ...base, name: 'ok', secrets: [{ name: 'lower', description: '' }] }))).toThrow(/UPPER_SNAKE/);
    expect(() => validateModule(defineModule({ ...base, name: 'ok', limits: [{ env: 'APPS_MAX_PER_WORKSPACE', default: 5, meaning: 'x' }] }))).toThrow(/core limit/);
    expect(() => validateModule(defineModule({ ...base, name: 'ok', sdk: { entry: '/nope.js', types: 'interface Api {}' } }))).toThrow(/sdk.entry/);
    expect(() => validateModule(defineModule({ ...base, name: 'ok', skill: { useWhen: '', markdown: 'x' } }))).toThrow(/useWhen/);
    const sdk = echo.sdk!;
    expect(() => validateModule(defineModule({ ...base, name: 'ok', sdk: { ...sdk, inline: { entry: '/nope.tsx', types: 'x' } } }))).toThrow(/sdk.inline.entry/);
    expect(() => validateModule(defineModule({ ...base, name: 'ok', sdk: { ...sdk, inline: { entry: sdk.inline!.entry, types: ' ' } } }))).toThrow(/sdk.inline.types/);
    expect(() => validateModule(echo)).not.toThrow();
  });

  it('refuses two modules declaring one limit', async () => {
    const twin = defineModule({ ...echo, name: 'twin' });
    await expect(
      loadModules({ DROBEK_MODULES: 'echo,twin' }, { importer: importer({ 'drobek-module-echo': echo, 'drobek-module-twin': twin }) })
    ).rejects.toThrow(/limit "ECHO_PER_MINUTE"/);
  });

  it('at most one module owns end-user sessions (endUsers.current must be a function)', async () => {
    const base = { version: '1.0.0', skill: { useWhen: 'x', markdown: '# x' }, configSchema: z.object({}), configDefaults: {} };
    const current = async () => null;
    const one = defineModule({ ...base, name: 'one', endUsers: { current } });
    const two = defineModule({ ...base, name: 'two', endUsers: { current } });
    expect(() => validateModule(defineModule({ ...base, name: 'bad', endUsers: {} as never }))).toThrow(/endUsers.current/);
    expect(endUserAuthorityOf([quiet, one])).toBe(one);
    expect(endUserAuthorityOf([quiet])).toBeNull();
    expect(() => endUserAuthorityOf([one, two])).toThrow(/only one module may own end-user sessions/);
    await expect(
      loadModules({ DROBEK_MODULES: 'one,two' }, { importer: importer({ 'drobek-module-one': one, 'drobek-module-two': two }) })
    ).rejects.toThrow(ModuleLoadError);
  });

  it('at most one module stores app records (records.* must be functions)', async () => {
    const base = { version: '1.0.0', skill: { useWhen: 'x', markdown: '# x' }, configSchema: z.object({}), configDefaults: {} };
    const records = {
      collections: async () => [],
      query: async () => ({ collection: { name: 'x', rules: {}, schema: null, columns: [], records: 0 }, records: [], total: 0, next_cursor: null }),
      get: async () => null,
      remove: async () => false,
      csv: async function* () {},
    };
    const one = defineModule({ ...base, name: 'one', records });
    const two = defineModule({ ...base, name: 'two', records });
    expect(() => validateModule(defineModule({ ...base, name: 'bad', records: { ...records, csv: undefined } as never }))).toThrow(/records.csv/);
    expect(recordsAuthorityOf([quiet, one])).toBe(one);
    expect(recordsAuthorityOf([quiet])).toBeNull();
    expect(() => recordsAuthorityOf([one, two])).toThrow(/only one module may store app records/);
    await expect(
      loadModules({ DROBEK_MODULES: 'one,two' }, { importer: importer({ 'drobek-module-one': one, 'drobek-module-two': two }) })
    ).rejects.toThrow(ModuleLoadError);
  });

  it('requires: a module that needs another refuses the start without it (and names the fix)', async () => {
    const base = { version: '1.0.0', skill: { useWhen: 'x', markdown: '# x' }, configSchema: z.object({}), configDefaults: {} };
    const mail = defineModule({ ...base, name: 'mail' });
    const form = defineModule({ ...base, name: 'form', requires: ['mail'] });
    expect(() => validateModule(defineModule({ ...base, name: 'selfish', requires: ['selfish'] }))).toThrow(/OTHER modules/);
    expect(() => validateModule(defineModule({ ...base, name: 'odd', requires: ['Bad Name'] }))).toThrow(/requires/);
    expect(() => checkRequires([form, mail])).not.toThrow();
    expect(() => checkRequires([form])).toThrow(/module "form" requires the module "mail": add it to DROBEK_MODULES \(e.g. DROBEK_MODULES=form,mail\)/);
    await expect(loadModules({ DROBEK_MODULES: 'form' }, { importer: importer({ 'drobek-module-form': form }) })).rejects.toThrow(ModuleLoadError);
    const both = await loadModules({ DROBEK_MODULES: 'form,mail' }, { importer: importer({ 'drobek-module-form': form, 'drobek-module-mail': mail }) });
    expect(both.map((m) => m.name)).toEqual(['form', 'mail']);
  });

  it('requires: a default module may not require an opt-in one; requires may not form a cycle', () => {
    const base = { version: '1.0.0', skill: { useWhen: 'x', markdown: '# x' }, configSchema: z.object({}), configDefaults: {} };
    const vault = defineModule({ ...base, name: 'vault', availability: 'opt-in' });
    const shelf = defineModule({ ...base, name: 'shelf', requires: ['vault'] });
    expect(() => checkRequires([shelf, vault])).toThrow(/module "shelf" is on in every workspace but requires the opt-in module "vault"/);
    expect(() => checkRequires([defineModule({ ...shelf, availability: 'opt-in' }), vault])).not.toThrow();
    const a = defineModule({ ...base, name: 'a', availability: 'opt-in', requires: ['b'] });
    const b = defineModule({ ...base, name: 'b', availability: 'opt-in', requires: ['c'] });
    const c = defineModule({ ...base, name: 'c', availability: 'opt-in', requires: ['a'] });
    expect(() => checkRequires([a, b, c])).toThrow(/requires form a cycle: a → b → c → a/);
    expect(() => checkRequires([a, b, defineModule({ ...base, name: 'c', availability: 'opt-in' })])).not.toThrow();
  });

  it('at most one module owns app e-mail (mail.prepare must be a function)', () => {
    const base = { version: '1.0.0', skill: { useWhen: 'x', markdown: '# x' }, configSchema: z.object({}), configDefaults: {} };
    const prepare = async () => ({});
    const one = defineModule({ ...base, name: 'one', mail: { prepare } });
    const two = defineModule({ ...base, name: 'two', mail: { prepare } });
    expect(() => validateModule(defineModule({ ...base, name: 'bad', mail: {} as never }))).toThrow(/mail.prepare/);
    expect(mailAuthorityOf([quiet, one])).toBe(one);
    expect(mailAuthorityOf([quiet])).toBeNull();
    expect(() => mailAuthorityOf([one, two])).toThrow(/only one module may own app e-mail/);
  });
});

describe('the upstreams and sync authorities', () => {
  const base = { version: '1.0.0', skill: { useWhen: 'x', markdown: '# x' }, configSchema: z.object({}), configDefaults: {} };
  const upstreams = { fetch: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }) };
  const sync = { sources: async () => [], runs: async () => [], runNow: async () => ({}) as never, resume: async () => false };

  it('at most one module owns upstream calls; fetch must be a function', () => {
    const one = defineModule({ ...base, name: 'one', upstreams });
    const two = defineModule({ ...base, name: 'two', upstreams });
    expect(() => validateModule(defineModule({ ...base, name: 'bad', upstreams: {} as never }))).toThrow(/upstreams.fetch/);
    expect(upstreamsAuthorityOf([one])).toBe(one);
    expect(upstreamsAuthorityOf([])).toBeNull();
    expect(() => upstreamsAuthorityOf([one, two])).toThrow(/only one module may own upstream calls/);
  });

  it('at most one module runs scheduled imports; every sync.* must be a function', () => {
    const one = defineModule({ ...base, name: 'one', sync });
    const two = defineModule({ ...base, name: 'two', sync });
    expect(() => validateModule(defineModule({ ...base, name: 'bad', sync: { ...sync, resume: undefined } as never }))).toThrow(/sync.resume/);
    expect(syncAuthorityOf([one])).toBe(one);
    expect(syncAuthorityOf([])).toBeNull();
    expect(() => syncAuthorityOf([one, two])).toThrow(/only one module may run scheduled imports/);
  });

  it('records.importRecords is optional, but a function when present', () => {
    const records = {
      collections: async () => [],
      query: async () => ({ collection: { name: 'x', rules: {}, schema: null, columns: [], records: 0 }, records: [], total: 0, next_cursor: null }),
      get: async () => null,
      remove: async () => false,
      csv: async function* () {},
    };
    expect(() => validateModule(defineModule({ ...base, name: 'plain', records }))).not.toThrow();
    expect(() => validateModule(defineModule({ ...base, name: 'bad', records: { ...records, importRecords: 'no' } as never }))).toThrow(/records.importRecords/);
  });
});
