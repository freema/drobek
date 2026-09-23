import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineModule } from './contract.js';
import { ModuleLoadError, checkRequires, endUserAuthorityOf, loadModules, mailAuthorityOf, packageNameFor, parseModuleList, resolveModule, validateModule } from './registry.js';
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
      loadModules({ DROBEK_MODULES: 'a,b' }, { importer: importer({ 'drobek-module-a': echo, 'drobek-module-b': { default: echo } }) })
    ).rejects.toThrow(/two entries .* "echo"/);
  });

  it('validates the structure', () => {
    const base = { version: '1.0.0', skill: { useWhen: 'x', markdown: '# x' }, configSchema: z.object({ a: z.number() }), configDefaults: { a: 1 } };
    expect(() => validateModule(defineModule({ ...base, name: 'Bad' }))).toThrow(ModuleLoadError);
    expect(() => validateModule(defineModule({ ...base, name: 'sdk' }))).toThrow(/reserved/);
    expect(() => validateModule(defineModule({ ...base, name: 'ok', version: 'v1' }))).toThrow(/semver/);
    expect(() => validateModule(defineModule({ ...base, name: 'ok', configDefaults: { a: 'x' } as never }))).toThrow(/configDefaults/);
    expect(() => validateModule(defineModule({ ...base, name: 'ok', secrets: [{ name: 'lower', description: '' }] }))).toThrow(/UPPER_SNAKE/);
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
