/**
 * Test helpers for DROBEK_MODULES_DIR (NSO-345): lay a module out the way
 * `npm install --prefix <dir>/<name> <package>` does and record it in
 * modules.lock.json with the real hash.
 */
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatModulesLock, hashModuleTree, readModulesLock, type ModulesLock } from '../lock.js';

/** The guestbook fixture package (plain ESM, no build step). */
export const GUESTBOOK_FIXTURE = fileURLToPath(new URL('../../test-fixtures/drobek-module-guestbook', import.meta.url));

export function tempModulesDir(): string {
  return mkdtempSync(join(tmpdir(), 'drobek-modules-'));
}

export interface InstallOptions {
  /** Directory under the modules dir (default: the module name derived from the package). */
  name: string;
  /** npm package name (default drobek-module-<name>). */
  pkg?: string;
  /** Copy this package directory … */
  from?: string;
  /** … or write these files (path relative to the package → content). */
  files?: Record<string, string>;
  /** Record the install in modules.lock.json (default true). */
  lock?: boolean;
}

/** Install a package into `<modulesDir>/<name>/node_modules/<pkg>`; returns the install prefix. */
export function installDirModule(modulesDir: string, opts: InstallOptions): string {
  const pkg = opts.pkg ?? `drobek-module-${opts.name}`;
  const prefix = join(modulesDir, opts.name);
  const packageDir = join(prefix, 'node_modules', ...pkg.split('/'));
  mkdirSync(packageDir, { recursive: true });
  if (opts.from) cpSync(opts.from, packageDir, { recursive: true });
  for (const [rel, text] of Object.entries(opts.files ?? {})) {
    mkdirSync(dirname(join(packageDir, rel)), { recursive: true });
    writeFileSync(join(packageDir, rel), text);
  }
  writeFileSync(join(prefix, 'package.json'), `${JSON.stringify({ dependencies: { [pkg]: '1.0.0' } }, null, 2)}\n`);
  if (opts.lock !== false) lockDirModule(modulesDir, opts.name, pkg);
  return prefix;
}

/** (Re)write the lock entry of `<modulesDir>/<name>` from what is on disk now. */
export function lockDirModule(modulesDir: string, name: string, pkg = `drobek-module-${name}`, version = '1.0.0'): ModulesLock {
  const lock: ModulesLock = readModulesLock(modulesDir) ?? { lockfileVersion: 1, modules: {} };
  lock.modules[name] = {
    package: pkg,
    version,
    resolved: `file:${pkg}-${version}.tgz`,
    integrity: hashModuleTree(join(modulesDir, name)),
    contract: '^1.1',
    installedAt: '2026-09-26T12:00:00.000Z',
  };
  writeFileSync(join(modulesDir, 'modules.lock.json'), formatModulesLock(lock));
  return lock;
}

/** A minimal module package (index.js + package.json) named `name`. */
export function tinyModuleFiles(name: string, extra: { version?: string; body?: string } = {}): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: `drobek-module-${name}`, version: extra.version ?? '1.0.0', type: 'module', exports: './index.js' }),
    'index.js': [
      `import { defineModule, z } from '@drobek/modules';`,
      `export default defineModule({`,
      `  name: ${JSON.stringify(name)}, version: ${JSON.stringify(extra.version ?? '1.0.0')}, contract: '^1.1',`,
      `  skill: { useWhen: 'a test needs it', markdown: '# ${name}\\n' },`,
      `  configSchema: z.object({}), configDefaults: {},`,
      extra.body ?? '',
      `});`,
      '',
    ].join('\n'),
  };
}
