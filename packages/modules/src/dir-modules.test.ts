/**
 * NSO-345: modules from DROBEK_MODULES_DIR — resolution order, the lockfile
 * + integrity check, DROBEK_MODULES_UNLOCKED, the migration lint and the
 * directory rules. Builtins come through the `importer` seam; dir modules
 * are real files imported by Node (with the host-peer hook).
 */
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Logger } from '@drobek/core';
import { defineModule, isDefinedModule } from './contract.js';
import { loadModuleSet } from './registry.js';
import { GUESTBOOK_FIXTURE, installDirModule, lockDirModule, tempModulesDir, tinyModuleFiles } from './test/modules-dir.js';

/** The `hello.greeter` slot host the guestbook fixture contributes to. */
const helloHost = defineModule({
  name: 'hello',
  version: '1.0.0',
  contract: '^1.1',
  skill: { useWhen: 'a test needs the greeter slot', markdown: '# hello\n' },
  configSchema: z.object({}),
  configDefaults: {},
  slots: {
    'hello.greeter': {
      schema: z.object({ id: z.string(), greet: z.custom<(n: string) => string>((v) => typeof v === 'function') }),
      unique: 'id',
      description: 'greeters',
    },
  },
});

const builtins = (map: Record<string, unknown>) => async (pkg: string) => {
  if (!(pkg in map)) throw new Error(`Cannot find package '${pkg}'`);
  return map[pkg];
};

function recordingLog(): Logger & { warns: string[]; infos: { msg: string; meta?: Record<string, unknown> }[] } {
  const warns: string[] = [];
  const infos: { msg: string; meta?: Record<string, unknown> }[] = [];
  return {
    warns,
    infos,
    debug() {},
    info(msg: string, meta?: Record<string, unknown>) {
      infos.push({ msg, meta });
    },
    warn(msg: string) {
      warns.push(msg);
    },
    error() {},
  } as never;
}

const dirs: string[] = [];
function modulesDir(): string {
  const d = tempModulesDir();
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DEV = { NODE_ENV: 'test' };

describe('DROBEK_MODULES_DIR', () => {
  it('loads a module from the directory (source dir) and the rest from the server (source builtin), in DROBEK_MODULES order', async () => {
    const dir = modulesDir();
    const prefix = installDirModule(dir, { name: 'guestbook', from: GUESTBOOK_FIXTURE });
    const log = recordingLog();
    const { modules, origins } = await loadModuleSet(
      { ...DEV, DROBEK_MODULES: 'hello,guestbook' },
      { modulesDir: dir, importer: builtins({ 'drobek-module-hello': { default: helloHost } }), log }
    );
    expect(modules.map((m) => m.name)).toEqual(['hello', 'guestbook']);
    expect(origins.hello).toEqual({ source: 'builtin', path: null });
    expect(origins.guestbook).toEqual({ source: 'dir', path: prefix });
    const guestbook = modules[1];
    expect(isDefinedModule(guestbook)).toBe(true);
    expect(guestbook.contract).toBe('^1.1');
    expect(Object.keys(guestbook.contributes ?? {})).toEqual(['hello.greeter']);
    expect(log.infos.find((i) => i.msg === 'module loaded from DROBEK_MODULES_DIR')?.meta).toMatchObject({ module: 'guestbook', path: prefix });
  });

  it('prefers the directory over a server dependency of the same package', async () => {
    const dir = modulesDir();
    installDirModule(dir, { name: 'probe', files: tinyModuleFiles('probe', { version: '2.0.0' }) });
    lockDirModule(dir, 'probe', 'drobek-module-probe', '2.0.0');
    const builtinProbe = defineModule({ ...helloHost, name: 'probe', slots: undefined });
    const { modules, origins } = await loadModuleSet(
      { ...DEV, DROBEK_MODULES: 'probe' },
      { modulesDir: dir, log: recordingLog(), importer: builtins({ 'drobek-module-probe': builtinProbe }) }
    );
    expect(modules[0].version).toBe('2.0.0');
    expect(origins.probe.source).toBe('dir');
  });

  it('finds a full package name through the lockfile or the drobek-module-<x> convention', async () => {
    const dir = modulesDir();
    installDirModule(dir, { name: 'erp', pkg: '@acme/erp-connector', files: { ...tinyModuleFiles('erp'), 'package.json': JSON.stringify({ name: '@acme/erp-connector', version: '1.0.0', type: 'module', main: 'index.js' }) } });
    installDirModule(dir, { name: 'crm', pkg: '@acme/drobek-module-crm', files: { ...tinyModuleFiles('crm'), 'package.json': JSON.stringify({ name: '@acme/drobek-module-crm', version: '1.0.0', type: 'module', exports: { '.': { import: './index.js' } } }) } });
    const { origins } = await loadModuleSet({ ...DEV, DROBEK_MODULES: '@acme/erp-connector,@acme/drobek-module-crm' }, { modulesDir: dir, log: recordingLog(), importer: builtins({}) });
    expect(origins.erp.source).toBe('dir');
    expect(origins.crm.source).toBe('dir');
  });

  it('falls back to the server when the directory does not exist or does not hold the entry', async () => {
    const { origins } = await loadModuleSet(
      { ...DEV, DROBEK_MODULES: 'hello' },
      { modulesDir: join(modulesDir(), 'nope'), log: recordingLog(), importer: builtins({ 'drobek-module-hello': helloHost }) }
    );
    expect(origins.hello.source).toBe('builtin');
  });

  it('refuses a dir module when modules.lock.json is missing, lacks it, or records another package or version', async () => {
    const dir = modulesDir();
    installDirModule(dir, { name: 'probe', files: tinyModuleFiles('probe'), lock: false });
    const load = () => loadModuleSet({ ...DEV, DROBEK_MODULES: 'probe' }, { modulesDir: dir, log: recordingLog(), importer: builtins({}) });
    await expect(load()).rejects.toThrow(/drobek refuses to start: DROBEK_MODULES names "probe" \(from DROBEK_MODULES_DIR\): .*modules\.lock\.json does not exist — install modules with `task selfhost:module:add -- drobek-module-probe`/);

    installDirModule(dir, { name: 'other', files: tinyModuleFiles('other') });
    await expect(load()).rejects.toThrow(/probe is not in .*modules\.lock\.json — reinstall it with `task selfhost:module:add -- drobek-module-probe`/);

    lockDirModule(dir, 'probe', '@acme/something-else');
    await expect(load()).rejects.toThrow(/records "@acme\/something-else" for "probe"/);

    lockDirModule(dir, 'probe', 'drobek-module-probe', '9.9.9');
    await expect(load()).rejects.toThrow(/holds drobek-module-probe@1\.0\.0, but .* records 9\.9\.9/);

    writeFileSync(join(dir, 'modules.lock.json'), '{"lockfileVersion":2,"modules":{}}');
    await expect(load()).rejects.toThrow(/lockfileVersion must be 1/);
  });

  it('refuses a dir module whose files changed after the install (integrity)', async () => {
    const dir = modulesDir();
    const prefix = installDirModule(dir, { name: 'guestbook', from: GUESTBOOK_FIXTURE });
    appendFileSync(join(prefix, 'node_modules/drobek-module-guestbook/index.js'), '\n// tampered\n');
    await expect(
      loadModuleSet({ ...DEV, DROBEK_MODULES: 'hello,guestbook' }, { modulesDir: dir, log: recordingLog(), importer: builtins({ 'drobek-module-hello': helloHost }) })
    ).rejects.toThrow(/guestbook does not match its integrity in .*modules\.lock\.json \(files changed after the install\) — reinstall it/);
    // A file added anywhere in the prefix (a dependency) counts too.
    lockDirModule(dir, 'guestbook');
    writeFileSync(join(prefix, 'node_modules/extra.js'), 'export {}');
    await expect(
      loadModuleSet({ ...DEV, DROBEK_MODULES: 'hello,guestbook' }, { modulesDir: dir, log: recordingLog(), importer: builtins({ 'drobek-module-hello': helloHost }) })
    ).rejects.toThrow(/does not match its integrity/);
  });

  it('DROBEK_MODULES_UNLOCKED=1 skips the lock check outside production — and is ignored in production', async () => {
    const dir = modulesDir();
    installDirModule(dir, { name: 'probe', files: tinyModuleFiles('probe'), lock: false });
    const dev = recordingLog();
    const { origins } = await loadModuleSet(
      { NODE_ENV: 'development', DROBEK_MODULES_UNLOCKED: '1', DROBEK_MODULES: 'probe' },
      { modulesDir: dir, importer: builtins({}), log: dev }
    );
    expect(origins.probe.source).toBe('dir');
    expect(dev.warns.some((w) => /without the modules\.lock\.json check/.test(w))).toBe(true);

    const prod = recordingLog();
    await expect(
      loadModuleSet({ NODE_ENV: 'production', DROBEK_MODULES_UNLOCKED: '1', DROBEK_MODULES: 'probe' }, { modulesDir: dir, importer: builtins({}), log: prod })
    ).rejects.toThrow(/modules\.lock\.json does not exist/);
    expect(prod.warns.some((w) => /DROBEK_MODULES_UNLOCKED is ignored in production/.test(w))).toBe(true);
  });

  it('refuses a dir module whose name is not its directory, or whose package.json names another package', async () => {
    const dir = modulesDir();
    installDirModule(dir, { name: 'crm', pkg: '@acme/drobek-module-crm', files: { ...tinyModuleFiles('erp'), 'package.json': JSON.stringify({ name: '@acme/drobek-module-crm', version: '1.0.0', type: 'module', exports: './index.js' }) } });
    await expect(loadModuleSet({ ...DEV, DROBEK_MODULES: '@acme/drobek-module-crm' }, { modulesDir: dir, log: recordingLog(), importer: builtins({}) })).rejects.toThrow(
      /installs the module "erp" — a module in DROBEK_MODULES_DIR lives in a directory named after it/
    );
    const dir2 = modulesDir();
    installDirModule(dir2, { name: 'probe', files: { ...tinyModuleFiles('probe'), 'package.json': JSON.stringify({ name: 'evil', version: '1.0.0' }) } });
    await expect(loadModuleSet({ ...DEV, DROBEK_MODULES: 'probe' }, { modulesDir: dir2, log: recordingLog(), importer: builtins({}) })).rejects.toThrow(/names the package "evil", not "drobek-module-probe"/);
  });

  it('lints the migrations of a dir module: refuses a foreign table with the file and line', async () => {
    const dir = modulesDir();
    installDirModule(dir, {
      name: 'probe',
      files: {
        ...tinyModuleFiles('probe', { body: `  migrations: { folder: new URL('./migrations', import.meta.url).href },` }),
        'migrations/0000_init.sql': 'CREATE TABLE "mod_probe_items" ("id" text PRIMARY KEY);\n--> statement-breakpoint\nDROP TABLE "users";\n',
        'migrations/meta/_journal.json': '{"version":"7","dialect":"postgresql","entries":[]}',
      },
    });
    await expect(loadModuleSet({ ...DEV, DROBEK_MODULES: 'probe' }, { modulesDir: dir, log: recordingLog(), importer: builtins({}) })).rejects.toThrow(
      /module "probe": its migrations leave the module's namespace — 0000_init\.sql:3: DROP TABLE: "users" is not a table of this module/
    );
  });

  it('does not lint a builtin module (a server dependency) — its migrations may touch core tables', async () => {
    const dir = modulesDir();
    installDirModule(dir, { name: 'probe', files: tinyModuleFiles('probe') });
    const migrating = defineModule({ ...helloHost, name: 'legacy', slots: undefined, migrations: { folder: join(dir, 'probe') } });
    writeFileSync(join(dir, 'probe', 'x.sql'), 'DROP TABLE data_documents;');
    const { origins } = await loadModuleSet({ ...DEV, DROBEK_MODULES: 'legacy' }, { modulesDir: dir, log: recordingLog(), importer: builtins({ 'drobek-module-legacy': migrating }) });
    expect(origins.legacy.source).toBe('builtin');
  });

  it('refuses a dir module whose migrations folder lies outside its directory', async () => {
    const dir = modulesDir();
    const outside = modulesDir();
    installDirModule(dir, { name: 'probe', files: tinyModuleFiles('probe', { body: `  migrations: { folder: ${JSON.stringify(outside)} },` }) });
    await expect(loadModuleSet({ ...DEV, DROBEK_MODULES: 'probe' }, { modulesDir: dir, log: recordingLog(), importer: builtins({}) })).rejects.toThrow(
      /migrations\.folder .* must be a file of the module's own directory/
    );
  });
});
