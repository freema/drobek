/**
 * The operator's module installer (NSO-350, `task selfhost:module:add|remove|list`):
 * everything after `npm install`, run by `cli/module-lock.ts` inside the
 * drobek image (or on the host for the dev stack) — so the lockfile is
 * written by the same code the server checks it with.
 *
 * `add`: npm has installed the operator's spec into a staging prefix
 * `<DROBEK_MODULES_DIR>/.staging-<id>` (a throwaway node container,
 * `--ignore-scripts`). `installModule()` then
 *
 *   1. finds the package (the staging package.json's one dependency) and
 *      refuses a linked directory;
 *   2. requires `peerDependencies['@drobek/modules']`, satisfied by the
 *      server's module contract version or its release version;
 *   3. deletes nested copies of the host-provided peers (`@drobek/*`, `zod`,
 *      `drizzle-orm` — the server hands a module its own instances);
 *   4. imports the module to learn its `name` and runs `validateModule`
 *      (name, reserved names, `contract` against MODULE_CONTRACT_VERSION, …);
 *   5. moves the prefix to `<dir>/<name>` (a previous install is kept aside),
 *      records it in modules.lock.json with `hashModuleTree()`, and loads it
 *      exactly as the server will (`findDirModule` → `verifyDirModule` →
 *      import → `validateModule` → `checkDirModule`, the migration lint
 *      included). Anything failing restores the previous install and lock.
 *
 * Nothing here touches the database: removing a module leaves its tables.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { noopLogger } from '@drobek/core';
import { MODULE_CONTRACT_VERSION, MODULE_NAME_RE, type AnyModule } from './contract.js';
import { checkDirModule, findDirModule, modulesDirState, packageEntryFile, verifyDirModule } from './dir-modules.js';
import { MODULES_LOCK_FILE, formatModulesLock, hashModuleTree, isInside, readModulesLock, type ModulesLock } from './lock.js';
import { registerHostPeers } from './peers.js';
import { exportedModule, packageNameFor, parseModuleList, validateModule } from './registry.js';

/** The package whose peer range a module must declare. */
const CONTRACT_PACKAGE = '@drobek/modules';

function readJson(file: string): Record<string, unknown> {
  const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${file} is not a JSON object`);
  return v as Record<string, unknown>;
}

const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split('\n')[0];

/** The DROBEK_MODULES entry that loads `<pkg>` as the module `<name>`: the short name for `drobek-module-<name>`, else the package. */
export function modulesEntryFor(name: string, pkg: string): string {
  return pkg === `drobek-module-${name}` ? name : pkg;
}

/** The entries of a DROBEK_MODULES value that load the package `pkg`. */
export function entriesFor(modules: string | undefined, pkg: string): string[] {
  return parseModuleList(modules).filter((e) => packageNameFor(e) === pkg);
}

/**
 * The DROBEK_MODULES line to put into the env file after installing `pkg`:
 * the current value with `entry` appended (`already`: it is listed).
 */
export function suggestModulesLine(current: string | undefined, entry: string, pkg: string): { line: string; already: boolean } {
  const entries = parseModuleList(current);
  const already = entries.some((e) => packageNameFor(e) === pkg);
  return { line: `DROBEK_MODULES=${(already ? entries : [...entries, entry]).join(',')}`, already };
}

/** The package npm installed into a staging prefix: the one dependency its package.json names. */
export function stagedPackageName(prefix: string): string {
  const file = join(prefix, 'package.json');
  if (!existsSync(file)) throw new Error(`${file} does not exist — npm installed nothing`);
  const deps = readJson(file).dependencies;
  const names = deps && typeof deps === 'object' ? Object.keys(deps) : [];
  if (names.length !== 1) throw new Error(`${file} must name exactly one dependency (the module), got ${names.length === 0 ? 'none' : names.join(', ')}`);
  return names[0];
}

/**
 * `peerDependencies['@drobek/modules']` must exist and accept this server:
 * its module contract version (`MODULE_CONTRACT_VERSION`) or its release
 * version (`imageVersion`, the image's `vX.Y.Z` — the npm package
 * `@drobek/modules@X.Y.Z` is that release's contract). Throws naming the fix.
 */
export function checkContractPeer(manifest: Record<string, unknown>, imageVersion?: string): string {
  const pkg = String(manifest.name);
  const peers = manifest.peerDependencies as Record<string, unknown> | undefined;
  const range = peers && typeof peers === 'object' ? peers[CONTRACT_PACKAGE] : undefined;
  if (typeof range !== 'string' || !range.trim()) {
    throw new Error(
      `${pkg} does not declare "${CONTRACT_PACKAGE}" in peerDependencies — a module gets the contract from the server; declare it as a peer (create-drobek-module does)`
    );
  }
  if (semver.validRange(range) === null) throw new Error(`${pkg}: peerDependencies["${CONTRACT_PACKAGE}"] is not a semver range (${JSON.stringify(range)})`);
  const release = semver.valid(imageVersion?.trim().replace(/^v/, '') ?? '');
  const accepted = [MODULE_CONTRACT_VERSION, release].filter((v): v is string => typeof v === 'string');
  if (!accepted.some((v) => semver.satisfies(v, range, { includePrerelease: true }))) {
    throw new Error(
      `${pkg} needs ${CONTRACT_PACKAGE} ${range}, but this server implements module contract ${MODULE_CONTRACT_VERSION}${release ? ` (release ${release})` : ''} — install a version of the module built for this drobek, or upgrade drobek`
    );
  }
  return range;
}

const HOST_PEERS = new Set(['zod', 'drizzle-orm']);

/**
 * Delete every copy of a host-provided peer (`@drobek/*`, `zod`,
 * `drizzle-orm`) from the `node_modules` trees below `prefix`, except the
 * module's own package. Returns the removed paths relative to `prefix`.
 */
export function stripHostPeers(prefix: string, ownPackage: string): string[] {
  const root = resolve(prefix);
  const own = resolve(root, 'node_modules', ...ownPackage.split('/'));
  const removed: string[] = [];
  const drop = (abs: string) => {
    rmSync(abs, { recursive: true, force: true });
    removed.push(abs.slice(root.length + 1).split('\\').join('/'));
  };
  const visitNodeModules = (nm: string) => {
    if (!existsSync(nm) || !lstatSync(nm).isDirectory()) return;
    for (const name of readdirSync(nm).sort()) {
      const abs = join(nm, name);
      if (name.startsWith('@')) {
        if (!lstatSync(abs).isDirectory()) continue;
        for (const sub of readdirSync(abs).sort()) {
          const pkgDir = join(abs, sub);
          if (name === '@drobek' && pkgDir !== own) drop(pkgDir);
          else visitPackage(pkgDir);
        }
        if (existsSync(abs) && readdirSync(abs).length === 0) rmSync(abs, { recursive: true, force: true });
      } else if (HOST_PEERS.has(name)) {
        drop(abs);
      } else if (!name.startsWith('.')) {
        visitPackage(abs);
      }
    }
  };
  const visitPackage = (pkgDir: string) => {
    if (lstatSync(pkgDir).isDirectory()) visitNodeModules(join(pkgDir, 'node_modules'));
  };
  visitNodeModules(join(root, 'node_modules'));
  return removed;
}

async function importModule(packageDir: string): Promise<AnyModule> {
  const file = packageEntryFile(packageDir);
  let ns: unknown;
  try {
    ns = await import(/* @vite-ignore */ pathToFileURL(file).href);
  } catch (err) {
    throw new Error(`${file} cannot be loaded (${firstLine(err)})`);
  }
  const mod = exportedModule(ns);
  if (!mod) throw new Error(`${packageDir} does not export a drobek module (default export from defineModule())`);
  return mod as AnyModule;
}

function writeLock(modulesDir: string, lock: ModulesLock): void {
  const file = join(modulesDir, MODULES_LOCK_FILE);
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, formatModulesLock(lock));
  renameSync(tmp, file);
}

function readLockOrThrow(modulesDir: string): ModulesLock | null {
  try {
    return readModulesLock(modulesDir);
  } catch (err) {
    throw new Error(`${(err as Error).message} — fix or delete it first (every module must then be added again)`);
  }
}

export interface InstallOptions {
  /** DROBEK_MODULES_DIR. */
  modulesDir: string;
  /** The staging prefix npm installed into: a directory directly below `modulesDir` (a name or a path). */
  staging: string;
  /** What the operator installed (the npm spec, tarball or git URL) — recorded as `resolved`. */
  spec: string;
  /** The directory whose package.json the server's dependencies belong to (host-provided peers). */
  serverRoot: string;
  /** The image's release version (`DROBEK_VERSION`, `vX.Y.Z`; anything else is ignored). */
  imageVersion?: string;
  now?: () => Date;
}

export interface InstallResult {
  name: string;
  package: string;
  version: string;
  contract: string | null;
  integrity: string;
  /** `<modulesDir>/<name>`. */
  prefix: string;
  /** The DROBEK_MODULES entry that loads it. */
  entry: string;
  /** The install this one replaced (the same name). */
  replaced: { package: string; version: string } | null;
  /** Host-provided peers deleted from the install (relative paths). */
  strippedPeers: string[];
}

/** Steps 1–5 of the file comment. Throws an Error naming the problem; the staging prefix is always removed. */
export async function installModule(opts: InstallOptions): Promise<InstallResult> {
  const dir = resolve(opts.modulesDir);
  const staging = resolve(dir, opts.staging);
  if (!isInside(dir, staging) || resolve(staging, '..') !== dir || !/^\.staging-[A-Za-z0-9-]+$/.test(staging.slice(dir.length + 1))) {
    throw new Error(`the staging prefix must be ${dir}/.staging-<id>, got ${staging}`);
  }
  try {
    if (!existsSync(staging)) throw new Error(`${staging} does not exist — npm installed nothing`);
    const pkg = stagedPackageName(staging);
    const packageDir = join(staging, 'node_modules', ...pkg.split('/'));
    if (!existsSync(packageDir)) throw new Error(`${packageDir} does not exist — npm did not install ${pkg}`);
    if (lstatSync(packageDir).isSymbolicLink()) {
      throw new Error(`npm linked ${pkg} from a directory instead of installing it — pack it first (npm pack) and install the tarball`);
    }
    const manifest = readJson(join(packageDir, 'package.json'));
    if (manifest.name !== pkg) throw new Error(`${packageDir}/package.json names ${JSON.stringify(manifest.name)}, not "${pkg}"`);
    const version = String(manifest.version ?? '');
    checkContractPeer(manifest, opts.imageVersion);
    const strippedPeers = stripHostPeers(staging, pkg);
    const lockBefore = readLockOrThrow(dir);

    // Import from the staging prefix to learn the module's name (the host
    // peers resolve to the server's instances, as at start).
    registerHostPeers(dir, opts.serverRoot);
    const staged = await importModule(packageDir);
    validateModule(staged);
    const name = staged.name;

    const prefix = join(dir, name);
    const previous = lockBefore?.modules[name] ?? null;
    const aside = existsSync(prefix) ? join(dir, `.previous-${name}-${randomBytes(4).toString('hex')}`) : null;
    if (aside) renameSync(prefix, aside);
    renameSync(staging, prefix);
    try {
      const integrity = hashModuleTree(prefix);
      const lock: ModulesLock = { lockfileVersion: 1, modules: { ...(lockBefore?.modules ?? {}) } };
      lock.modules[name] = {
        package: pkg,
        version,
        resolved: opts.spec,
        integrity,
        contract: staged.contract ?? null,
        installedAt: (opts.now ?? (() => new Date()))().toISOString(),
      };
      writeLock(dir, lock);

      // Load it the way the server will at its next start.
      const entry = modulesEntryFor(name, pkg);
      const state = modulesDirState({ NODE_ENV: 'production' }, dir, noopLogger);
      const loc = findDirModule(entry, packageNameFor(entry), state);
      if (!loc || loc.name !== name) throw new Error(`the DROBEK_MODULES entry "${entry}" does not find ${prefix}`);
      verifyDirModule(loc, state);
      const loaded = await importModule(loc.packageDir);
      validateModule(loaded);
      checkDirModule(loaded, loc);

      if (aside) rmSync(aside, { recursive: true, force: true });
      return {
        name,
        package: pkg,
        version,
        contract: staged.contract ?? null,
        integrity,
        prefix,
        entry,
        replaced: previous ? { package: previous.package, version: previous.version } : null,
        strippedPeers,
      };
    } catch (err) {
      rmSync(prefix, { recursive: true, force: true });
      if (aside) renameSync(aside, prefix);
      if (lockBefore) writeLock(dir, lockBefore);
      else rmSync(join(dir, MODULES_LOCK_FILE), { force: true });
      throw err;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export interface RemoveResult {
  name: string;
  /** From the lockfile, else from the prefix's package.json (null: neither). */
  package: string | null;
  version: string | null;
  /** The directory existed and was deleted. */
  removedDir: boolean;
  /** The lockfile listed it and no longer does. */
  removedLockEntry: boolean;
}

/** Delete `<modulesDir>/<name>` and its lockfile entry (never the module's tables). */
export function removeModule(modulesDir: string, name: string): RemoveResult {
  const dir = resolve(modulesDir);
  if (!MODULE_NAME_RE.test(name)) throw new Error(`"${name}" is not a module name (${MODULE_NAME_RE})`);
  const lock = readLockOrThrow(dir);
  const entry = lock?.modules[name];
  const prefix = join(dir, name);
  const hasDir = existsSync(prefix);
  if (!entry && !hasDir) throw new Error(`no module "${name}" is installed in ${dir}`);
  let pkg: string | null = entry?.package ?? null;
  if (!pkg && hasDir) {
    try {
      pkg = stagedPackageName(prefix);
    } catch {
      pkg = null;
    }
  }
  if (hasDir) rmSync(prefix, { recursive: true, force: true });
  if (entry && lock) {
    const modules = { ...lock.modules };
    delete modules[name];
    writeLock(dir, { lockfileVersion: 1, modules });
  }
  return { name, package: pkg, version: entry?.version ?? null, removedDir: hasDir, removedLockEntry: Boolean(entry) };
}

type InstalledStatus = 'ok' | 'changed' | 'missing' | 'unrecorded';

export interface InstalledModule {
  name: string;
  package: string | null;
  version: string | null;
  contract: string | null;
  integrity: string | null;
  /** ok: matches its lock entry · changed: files differ from the integrity · missing: lock entry without a directory · unrecorded: a directory the lockfile does not list. */
  status: InstalledStatus;
}

/** Every module of the lockfile plus every module-named directory, sorted by name. */
export function listModules(modulesDir: string): InstalledModule[] {
  const dir = resolve(modulesDir);
  if (!existsSync(dir)) return [];
  const lock = readModulesLock(dir);
  const names = new Set(Object.keys(lock?.modules ?? {}));
  for (const n of readdirSync(dir)) if (MODULE_NAME_RE.test(n) && lstatSync(join(dir, n)).isDirectory()) names.add(n);
  return [...names].sort().map((name): InstalledModule => {
    const e = lock?.modules[name];
    const prefix = join(dir, name);
    if (!e) {
      let pkg: string | null = null;
      try {
        pkg = stagedPackageName(prefix);
      } catch {
        pkg = null;
      }
      return { name, package: pkg, version: null, contract: null, integrity: null, status: 'unrecorded' };
    }
    let status: InstalledStatus = 'ok';
    if (!existsSync(prefix)) status = 'missing';
    else {
      try {
        if (hashModuleTree(prefix) !== e.integrity) status = 'changed';
      } catch {
        status = 'changed';
      }
    }
    return { name, package: e.package, version: e.version, contract: e.contract, integrity: e.integrity, status };
  });
}

/** `sha512-AbCdEfGhIj…` — enough to compare by eye. */
export function shortIntegrity(integrity: string | null): string {
  if (!integrity) return '-';
  return integrity.length > 17 ? `${integrity.slice(0, 17)}…` : integrity;
}

/** The `list` table: NAME PACKAGE VERSION CONTRACT INTEGRITY ENABLED STATUS (ENABLED = in DROBEK_MODULES). */
export function formatModuleTable(rows: InstalledModule[], modules: string | undefined): string {
  const header = ['NAME', 'PACKAGE', 'VERSION', 'CONTRACT', 'INTEGRITY', 'IN DROBEK_MODULES', 'STATUS'];
  const body = rows.map((r) => [
    r.name,
    r.package ?? '-',
    r.version ?? '-',
    r.contract ?? '-',
    shortIntegrity(r.integrity),
    r.package && entriesFor(modules, r.package).length > 0 ? 'yes' : 'no',
    r.status,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  return [header, ...body].map((cols) => cols.map((c, i) => (i === cols.length - 1 ? c : c.padEnd(widths[i]))).join('  ')).join('\n');
}
