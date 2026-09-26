/**
 * Modules installed in `DROBEK_MODULES_DIR` (NSO-345): the second place the
 * registry looks for a DROBEK_MODULES entry, BEFORE the server's own
 * dependencies. Layout and lockfile: `./lock.ts`.
 *
 * An entry's directory is `<DROBEK_MODULES_DIR>/<name>` where `<name>` is
 *   - the key of a lockfile entry whose `package` is the entry's package, or
 *   - the entry itself for a short name (`erp` → `<dir>/erp`), or the `<x>`
 *     of a full name `drobek-module-<x>` / `@scope/drobek-module-<x>`,
 * and it counts when `<dir>/<name>/node_modules/<package>/package.json`
 * exists. The loaded module's `name` must equal `<name>`.
 *
 * Before such a module is imported: its package.json `name` must be the
 * package, and — unless DROBEK_MODULES_UNLOCKED=1 outside production — the
 * lockfile must list `<name>` with that package and version and
 * `hashModuleTree(<dir>/<name>)` must equal its `integrity`.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Logger } from '@drobek/core';
import { MODULE_NAME_RE, type AnyModule } from './contract.js';
import { MODULES_LOCK_FILE, hashModuleTree, isInside, readModulesLock, type ModulesLock } from './lock.js';
import { lintModuleMigrations } from './migration-lint.js';
import { toPath } from './sdk-build.js';

/** `DROBEK_MODULES_DIR` when unset (the `modules_data` volume in the image). */
export const DEFAULT_MODULES_DIR = '/data/modules';

const ADD_HINT = 'task selfhost:module:add';

export interface DirModuleLocation {
  /** The directory name = the module's name. */
  name: string;
  /** The npm package. */
  package: string;
  /** `<modulesDir>/<name>` — the install prefix the integrity covers. */
  prefix: string;
  /** `<prefix>/node_modules/<package>`. */
  packageDir: string;
}

/** What a load needs to know about DROBEK_MODULES_DIR (read once per load). */
export interface ModulesDirState {
  dir: string;
  exists: boolean;
  lock: ModulesLock | null;
  /** A lockfile that could not be read or parsed (reported when a dir module needs it). */
  lockError: string | null;
  /** Skip the lock + integrity check (DROBEK_MODULES_UNLOCKED=1 outside production). */
  unlocked: boolean;
}

export function modulesDirState(env: NodeJS.ProcessEnv, dirOverride: string | undefined, log: Logger): ModulesDirState {
  const dir = resolve(dirOverride ?? (env.DROBEK_MODULES_DIR?.trim() || DEFAULT_MODULES_DIR));
  const exists = existsSync(dir) && statSync(dir).isDirectory();
  let lock: ModulesLock | null = null;
  let lockError: string | null = null;
  if (exists) {
    try {
      lock = readModulesLock(dir);
    } catch (err) {
      lockError = (err as Error).message;
    }
  }
  let unlocked = false;
  if (env.DROBEK_MODULES_UNLOCKED === '1') {
    if (env.NODE_ENV === 'production') {
      log.warn('DROBEK_MODULES_UNLOCKED is ignored in production — modules from DROBEK_MODULES_DIR are checked against modules.lock.json', {
        env: 'DROBEK_MODULES_UNLOCKED',
      });
    } else {
      unlocked = true;
      log.warn('DROBEK_MODULES_UNLOCKED=1: modules from DROBEK_MODULES_DIR load without the modules.lock.json check (never in production)', {
        env: 'DROBEK_MODULES_UNLOCKED',
      });
    }
  }
  return { dir, exists, lock, lockError, unlocked };
}

function conventionalName(entry: string, pkg: string): string | null {
  if (pkg !== entry) return entry;
  return /^(?:@[^/]+\/)?drobek-module-([a-z][a-z0-9]{1,30})$/.exec(pkg)?.[1] ?? null;
}

/** The directory of a DROBEK_MODULES entry under DROBEK_MODULES_DIR, or null (→ the server's dependencies). */
export function findDirModule(entry: string, pkg: string, state: ModulesDirState): DirModuleLocation | null {
  if (!state.exists) return null;
  const names: string[] = [];
  for (const [name, e] of Object.entries(state.lock?.modules ?? {})) if (e.package === pkg) names.push(name);
  const conventional = conventionalName(entry, pkg);
  if (conventional !== null) names.push(conventional);
  for (const name of names) {
    // A lockfile key is a path segment: only module names, never `..` or `a/b`.
    if (!MODULE_NAME_RE.test(name)) continue;
    const prefix = join(state.dir, name);
    const packageDir = join(prefix, 'node_modules', ...pkg.split('/'));
    if (existsSync(join(packageDir, 'package.json'))) return { name, package: pkg, prefix, packageDir };
  }
  return null;
}

function readJson(file: string): Record<string, unknown> {
  const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${file} is not a JSON object`);
  return v as Record<string, unknown>;
}

/**
 * Check a located module against the lockfile (throws an Error with the
 * reason and the fix; the registry wraps it into ModuleLoadError).
 */
export function verifyDirModule(loc: DirModuleLocation, state: ModulesDirState): void {
  const manifest = join(loc.packageDir, 'package.json');
  const pkgJson = readJson(manifest);
  const reinstall = `reinstall it with \`${ADD_HINT} -- ${loc.package}\``;
  if (pkgJson.name !== loc.package) {
    throw new Error(`${manifest} names the package ${JSON.stringify(pkgJson.name)}, not "${loc.package}" — ${reinstall}`);
  }
  if (state.unlocked) return;
  const lockFile = join(state.dir, MODULES_LOCK_FILE);
  if (state.lockError !== null) throw new Error(`${state.lockError} — fix or rewrite it with \`${ADD_HINT}\``);
  if (state.lock === null) {
    throw new Error(`${loc.prefix} is not recorded: ${lockFile} does not exist — install modules with \`${ADD_HINT} -- ${loc.package}\`, which writes it`);
  }
  const e = state.lock.modules[loc.name];
  if (!e) throw new Error(`${loc.prefix} is not in ${lockFile} — ${reinstall}`);
  if (e.package !== loc.package) {
    throw new Error(`${lockFile} records "${e.package}" for "${loc.name}", but ${loc.prefix} installs "${loc.package}" — ${reinstall}`);
  }
  if (pkgJson.version !== e.version) {
    throw new Error(`${loc.prefix} holds ${loc.package}@${String(pkgJson.version)}, but ${lockFile} records ${e.version} — ${reinstall}`);
  }
  let actual: string;
  try {
    actual = hashModuleTree(loc.prefix);
  } catch (err) {
    throw new Error(`${loc.prefix} cannot be hashed (${(err as Error).message}) — ${reinstall}`);
  }
  if (actual !== e.integrity) {
    throw new Error(`${loc.prefix} does not match its integrity in ${lockFile} (files changed after the install) — ${reinstall}`);
  }
}

function pickTarget(target: unknown): string | null {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const t of target) {
      const r = pickTarget(t);
      if (r !== null) return r;
    }
    return null;
  }
  if (typeof target === 'object' && target !== null) {
    for (const [cond, v] of Object.entries(target)) {
      if (cond === 'node' || cond === 'import' || cond === 'default') {
        const r = pickTarget(v);
        if (r !== null) return r;
      }
    }
  }
  return null;
}

/** The file an `import '<package>'` loads: `exports['.']` (node/import/default) or `main` or index.js. */
export function packageEntryFile(packageDir: string): string {
  const pkgJson = readJson(join(packageDir, 'package.json'));
  const exp = pkgJson.exports;
  let candidates: string[];
  if (exp !== undefined && exp !== null) {
    const dotted = typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith('.'));
    const rel = pickTarget(dotted ? (exp as Record<string, unknown>)['.'] : exp);
    if (rel === null) throw new Error(`${join(packageDir, 'package.json')} has no "." export for import`);
    candidates = [rel];
  } else {
    const main = typeof pkgJson.main === 'string' && pkgJson.main ? pkgJson.main : 'index.js';
    candidates = [main, `${main}.js`, join(main, 'index.js')];
  }
  for (const rel of candidates) {
    const file = resolve(packageDir, rel);
    if (isInside(packageDir, file) && existsSync(file) && statSync(file).isFile()) return file;
  }
  throw new Error(`${packageDir}: the package's entry (${candidates[0]}) does not exist`);
}

/**
 * After import: the module's name is its directory's, its migrations and SDK
 * files lie inside the hashed install prefix, and its migrations pass the
 * lint (`./migration-lint.ts`). Throws an Error naming the problem.
 */
export function checkDirModule(m: AnyModule, loc: DirModuleLocation): void {
  if (m.name !== loc.name) {
    throw new Error(
      `${loc.prefix} installs the module "${m.name}" — a module in DROBEK_MODULES_DIR lives in a directory named after it (<dir>/${m.name})`
    );
  }
  const root = realpathSync(loc.prefix);
  const files: [string, string | undefined][] = [
    ['migrations.folder', m.migrations?.folder],
    ['sdk.entry', m.sdk?.entry],
    ['sdk.inline.entry', m.sdk?.inline?.entry],
  ];
  for (const [label, p] of files) {
    if (p === undefined) continue;
    const abs = toPath(p);
    if (!existsSync(abs) || !isInside(root, realpathSync(abs))) {
      throw new Error(`module "${m.name}": ${label} (${abs}) must be a file of the module's own directory ${loc.prefix}`);
    }
  }
  if (m.migrations) {
    const issues = lintModuleMigrations(m.name, toPath(m.migrations.folder));
    if (issues.length > 0) {
      const shown = issues.slice(0, 5).map((i) => `${i.file}:${i.line}: ${i.message}`);
      const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : '';
      throw new Error(
        `module "${m.name}": its migrations leave the module's namespace — ${shown.join('; ')}${more}. A module from DROBEK_MODULES_DIR may create and change only mod_${m.name} / mod_${m.name}_* and reference apps(id) or workspaces(id)`
      );
    }
  }
}
