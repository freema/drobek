/**
 * `modules.lock.json` and the module tree hash (`@drobek/modules/lock`,
 * NSO-345). Shared by the server (which verifies every module it loads from
 * `DROBEK_MODULES_DIR` at start) and the operator's installer (which writes
 * the lockfile after `npm install`), so both hash a module the same way.
 * Node built-ins only — importing this subpath pulls in nothing else.
 *
 * Layout of `DROBEK_MODULES_DIR` (default `/data/modules`):
 *
 *   modules.lock.json                   this file's format (below)
 *   <name>/                             one install prefix per module, named
 *     package.json                      after the module's `name`
 *     package-lock.json
 *     node_modules/<package>/…          the module package + its dependencies
 *
 * The lockfile:
 *
 *   {
 *     "lockfileVersion": 1,
 *     "modules": {
 *       "<name>": {
 *         "package": "@acme/drobek-module-erp",   // the npm package name
 *         "version": "1.2.0",                     // its package.json version
 *         "resolved": "https://registry.npmjs.org/…", // what was installed (npm spec / URL)
 *         "integrity": "sha512-…",                // hashModuleTree(<dir>/<name>)
 *         "contract": "^1.1",                     // the module's contract range (null: none)
 *         "installedAt": "2026-09-26T12:00:00.000Z" // optional
 *       }
 *     }
 *   }
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The lockfile's name in the root of `DROBEK_MODULES_DIR`. */
export const MODULES_LOCK_FILE = 'modules.lock.json';

/** The only `lockfileVersion` this server reads. */
export const MODULES_LOCKFILE_VERSION = 1;

export interface ModulesLockEntry {
  /** The npm package name (`drobek-module-x`, `@scope/pkg`). */
  package: string;
  /** The installed package.json `version`. */
  version: string;
  /** What was installed: the npm spec, tarball or git URL. */
  resolved: string;
  /** `hashModuleTree()` of the module's install prefix. */
  integrity: string;
  /** The module's `contract` range at install time (null: it declares none). */
  contract: string | null;
  /** ISO timestamp of the install (informational). */
  installedAt?: string;
}

export interface ModulesLock {
  lockfileVersion: typeof MODULES_LOCKFILE_VERSION;
  /** Module name (= the directory under DROBEK_MODULES_DIR) → entry. */
  modules: Record<string, ModulesLockEntry>;
}

const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** `target` is `root` or below it (both absolute). */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The integrity of a module's install prefix (`<DROBEK_MODULES_DIR>/<name>`):
 * `sha512-<base64>` over a manifest of EVERY file below `root` — the package,
 * its dependencies, package.json and package-lock.json:
 *
 *   1. walk `root` without following symlinks and collect every regular file
 *      and symlink by its path relative to `root`, `/`-separated;
 *   2. sort those paths by UTF-16 code units (plain JS `<`);
 *   3. per path append `F <path>\0<sha512 hex of the content>\n` for a file,
 *      `L <path>\0<link target as stored>\n` for a symlink;
 *   4. sha512 of that manifest, base64 → `sha512-…`.
 *
 * Directories count only through their contents (an empty one changes
 * nothing); modes and timestamps are ignored, so a backup/restore or a copy
 * keeps the hash. A symlink whose target leaves `root`, or any other kind of
 * entry (socket, device), throws.
 */
export function hashModuleTree(root: string): string {
  const base = resolve(root);
  const st = lstatSync(base);
  if (!st.isDirectory()) throw new Error(`${base} is not a directory`);
  const entries: { rel: string; line: (rel: string) => string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(base, abs).split(sep).join('/');
      const s = lstatSync(abs);
      if (s.isDirectory()) {
        walk(abs);
      } else if (s.isFile()) {
        entries.push({ rel, line: (r) => `F ${r}\0${createHash('sha512').update(readFileSync(abs)).digest('hex')}\n` });
      } else if (s.isSymbolicLink()) {
        const target = readlinkSync(abs);
        if (!isInside(base, resolve(dirname(abs), target))) {
          throw new Error(`${abs} is a symlink that leaves the module directory (→ ${target})`);
        }
        entries.push({ rel, line: (r) => `L ${r}\0${target}\n` });
      } else {
        throw new Error(`${abs} is neither a file, a directory nor a symlink`);
      }
    }
  };
  walk(base);
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const h = createHash('sha512');
  for (const e of entries) h.update(e.line(e.rel));
  return `sha512-${h.digest('base64')}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Check a parsed lockfile's shape (throws an Error naming the first problem).
 * Unknown top-level or entry keys are ignored.
 */
export function parseModulesLock(value: unknown): ModulesLock {
  if (!isPlainObject(value)) throw new Error('the lockfile must be a JSON object');
  if (value.lockfileVersion !== MODULES_LOCKFILE_VERSION) {
    throw new Error(`lockfileVersion must be ${MODULES_LOCKFILE_VERSION}, got ${JSON.stringify(value.lockfileVersion)}`);
  }
  if (!isPlainObject(value.modules)) throw new Error('"modules" must be an object: module name → entry');
  const modules: Record<string, ModulesLockEntry> = {};
  for (const [name, raw] of Object.entries(value.modules)) {
    const where = `modules["${name}"]`;
    if (!isPlainObject(raw)) throw new Error(`${where} must be an object`);
    for (const key of ['package', 'version', 'resolved', 'integrity'] as const) {
      if (typeof raw[key] !== 'string' || !(raw[key] as string).trim()) throw new Error(`${where}.${key} must be a non-empty string`);
    }
    if (!INTEGRITY_RE.test(raw.integrity as string)) throw new Error(`${where}.integrity must be sha512-<base64> (hashModuleTree)`);
    if (raw.contract != null && typeof raw.contract !== 'string') throw new Error(`${where}.contract must be a string or null`);
    if (raw.installedAt !== undefined && typeof raw.installedAt !== 'string') throw new Error(`${where}.installedAt must be a string`);
    modules[name] = {
      package: raw.package as string,
      version: raw.version as string,
      resolved: raw.resolved as string,
      integrity: raw.integrity as string,
      contract: (raw.contract as string | null | undefined) ?? null,
      ...(raw.installedAt !== undefined ? { installedAt: raw.installedAt as string } : {}),
    };
  }
  return { lockfileVersion: MODULES_LOCKFILE_VERSION, modules };
}

/**
 * `<modulesDir>/modules.lock.json`, parsed and checked — null when the file
 * does not exist. An unreadable or malformed file throws.
 */
export function readModulesLock(modulesDir: string): ModulesLock | null {
  const file = join(modulesDir, MODULES_LOCK_FILE);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message})`);
  }
  try {
    return parseModulesLock(parsed);
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message}`);
  }
}

/** The lockfile text the installer writes: module names sorted, 2-space JSON, trailing newline. */
export function formatModulesLock(lock: ModulesLock): string {
  const modules: Record<string, ModulesLockEntry> = {};
  for (const name of Object.keys(lock.modules).sort()) modules[name] = lock.modules[name];
  return `${JSON.stringify({ lockfileVersion: MODULES_LOCKFILE_VERSION, modules }, null, 2)}\n`;
}
