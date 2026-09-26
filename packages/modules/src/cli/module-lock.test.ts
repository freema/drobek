/**
 * NSO-350: the installer half of `task selfhost:module:add|remove|list`
 * (`cli/module-lock.ts` → `install.ts`) — the tree hash it records, the
 * lockfile it writes, and add / upgrade / rollback / remove / list over a
 * real DROBEK_MODULES_DIR laid out the way `npm install --prefix
 * <dir>/.staging-<id>` leaves it.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MODULE_CONTRACT_VERSION } from '../contract.js';
import {
  checkContractPeer,
  entriesFor,
  formatModuleTable,
  installModule,
  listModules,
  modulesEntryFor,
  removeModule,
  shortIntegrity,
  stagedPackageName,
  stripHostPeers,
  suggestModulesLine,
} from '../install.js';
import { formatModulesLock, hashModuleTree, readModulesLock } from '../lock.js';
import { GUESTBOOK_FIXTURE, tempModulesDir, tinyModuleFiles } from '../test/modules-dir.js';

const SERVER_ROOT = process.cwd();
const PEERS = { '@drobek/modules': '>=1.0.0', 'drizzle-orm': '>=0.45.0' };

const dirs: string[] = [];
function modulesDir(): string {
  const d = tempModulesDir();
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

let seq = 0;
/** What `npm install --prefix <dir>/.staging-<id> <spec>` leaves: package.json + node_modules/<pkg>. Returns the staging name. */
function stage(dir: string, pkg: string, opts: { from?: string; files?: Record<string, string>; extra?: Record<string, string> }): string {
  const staging = `.staging-t${++seq}`;
  const prefix = join(dir, staging);
  const packageDir = join(prefix, 'node_modules', ...pkg.split('/'));
  mkdirSync(packageDir, { recursive: true });
  if (opts.from) cpSync(opts.from, packageDir, { recursive: true });
  writeFiles(packageDir, opts.files ?? {});
  writeFiles(prefix, opts.extra ?? {});
  writeFileSync(join(prefix, 'package.json'), `${JSON.stringify({ dependencies: { [pkg]: '^1.0.0' } }, null, 2)}\n`);
  writeFileSync(join(prefix, 'package-lock.json'), `${JSON.stringify({ name: staging, lockfileVersion: 3 }, null, 2)}\n`);
  return staging;
}

/** A tiny module package with the contract peer declared. */
function tiny(name: string, opts: { pkg?: string; version?: string; body?: string; peers?: Record<string, string> | null } = {}): Record<string, string> {
  const files = tinyModuleFiles(name, { version: opts.version, body: opts.body });
  const manifest = JSON.parse(files['package.json']) as Record<string, unknown>;
  manifest.name = opts.pkg ?? `drobek-module-${name}`;
  if (opts.peers !== null) manifest.peerDependencies = opts.peers ?? PEERS;
  return { ...files, 'package.json': JSON.stringify(manifest) };
}

const add = (dir: string, staging: string, spec = 'drobek-module-x@1.0.0', imageVersion?: string) =>
  installModule({ modulesDir: dir, staging, spec, serverRoot: SERVER_ROOT, imageVersion, now: () => new Date('2026-09-26T12:00:00.000Z') });

const lockText = (dir: string) => readFileSync(join(dir, 'modules.lock.json'), 'utf8');
const stagingLeft = (dir: string) => readdirSync(dir).filter((n) => n.startsWith('.staging-') || n.startsWith('.previous-'));

describe('hashModuleTree (what the lockfile records)', () => {
  function tree(dir: string, name: string): string {
    const prefix = join(dir, name);
    writeFiles(join(prefix, 'node_modules', `drobek-module-${name}`), {
      ...tiny(name),
      'SKILL.md': '# skill\n',
      'migrations/0000_init.sql': `CREATE TABLE "mod_${name}" ("id" text PRIMARY KEY);\n`,
    });
    writeFiles(prefix, { 'package.json': '{"dependencies":{}}\n' });
    return prefix;
  }

  it('is deterministic — the same tree hashes the same, wherever it lies', () => {
    const a = tree(modulesDir(), 'probe');
    const b = tree(modulesDir(), 'probe');
    expect(hashModuleTree(a)).toBe(hashModuleTree(a));
    expect(hashModuleTree(b)).toBe(hashModuleTree(a));
    expect(hashModuleTree(a)).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
  });

  it.each([
    ['SKILL.md', 'SKILL.md'],
    ['a migration', 'migrations/0000_init.sql'],
    ['the entry', 'index.js'],
  ])('changes when %s changes', (_label, rel) => {
    const prefix = tree(modulesDir(), 'probe');
    const before = hashModuleTree(prefix);
    appendFileSync(join(prefix, 'node_modules/drobek-module-probe', rel), '\n-- changed\n');
    expect(hashModuleTree(prefix)).not.toBe(before);
  });
});

describe('installModule (task selfhost:module:add)', () => {
  it('records a module under its name: staging moved, nested host peers deleted, lockfile written by hashModuleTree', async () => {
    const dir = modulesDir();
    const staging = stage(dir, 'drobek-module-guestbook', {
      from: GUESTBOOK_FIXTURE,
      extra: {
        'node_modules/zod/package.json': '{"name":"zod","version":"4.0.0"}',
        'node_modules/@drobek/modules/package.json': '{"name":"@drobek/modules","version":"1.1.0"}',
        'node_modules/left-pad/package.json': '{"name":"left-pad","version":"1.0.0"}',
        'node_modules/left-pad/node_modules/drizzle-orm/package.json': '{"name":"drizzle-orm","version":"0.45.0"}',
      },
    });
    const r = await add(dir, staging, 'https://example.com/drobek-module-guestbook-1.0.0.tgz');
    expect(r).toMatchObject({ name: 'guestbook', package: 'drobek-module-guestbook', version: '1.0.0', contract: '^1.1', entry: 'guestbook', replaced: null });
    expect(r.prefix).toBe(join(dir, 'guestbook'));
    expect(r.strippedPeers.sort()).toEqual(['node_modules/@drobek/modules', 'node_modules/left-pad/node_modules/drizzle-orm', 'node_modules/zod']);
    expect(existsSync(join(dir, 'guestbook/node_modules/left-pad/package.json'))).toBe(true);
    expect(existsSync(join(dir, 'guestbook/node_modules/@drobek'))).toBe(false);
    expect(stagingLeft(dir)).toEqual([]);
    const lock = readModulesLock(dir)!;
    expect(lock.modules.guestbook).toEqual({
      package: 'drobek-module-guestbook',
      version: '1.0.0',
      resolved: 'https://example.com/drobek-module-guestbook-1.0.0.tgz',
      integrity: hashModuleTree(join(dir, 'guestbook')),
      contract: '^1.1',
      installedAt: '2026-09-26T12:00:00.000Z',
    });
    expect(r.integrity).toBe(lock.modules.guestbook.integrity);
  });

  it('writes the lockfile in a stable order: modules sorted by name, entry keys fixed', async () => {
    const dir = modulesDir();
    await add(dir, stage(dir, 'drobek-module-zeta', { files: tiny('zeta') }));
    await add(dir, stage(dir, '@acme/drobek-module-alpha', { files: tiny('alpha', { pkg: '@acme/drobek-module-alpha' }) }));
    const text = lockText(dir);
    const parsed = JSON.parse(text) as { modules: Record<string, Record<string, unknown>> };
    expect(Object.keys(parsed)).toEqual(['lockfileVersion', 'modules']);
    expect(Object.keys(parsed.modules)).toEqual(['alpha', 'zeta']);
    expect(Object.keys(parsed.modules.alpha)).toEqual(['package', 'version', 'resolved', 'integrity', 'contract', 'installedAt']);
    expect(text).toBe(formatModulesLock(readModulesLock(dir)!));
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('names the DROBEK_MODULES entry: the short name for drobek-module-<name>, else the package', async () => {
    const dir = modulesDir();
    const scoped = await add(dir, stage(dir, '@acme/drobek-module-erp', { files: tiny('erp', { pkg: '@acme/drobek-module-erp' }) }));
    expect(scoped).toMatchObject({ name: 'erp', entry: '@acme/drobek-module-erp' });
    // create-drobek-module acme-erp → package drobek-module-acme-erp, module acmeerp
    const dashed = await add(dir, stage(dir, 'drobek-module-acme-erp', { files: tiny('acmeerp', { pkg: 'drobek-module-acme-erp' }) }));
    expect(dashed).toMatchObject({ name: 'acmeerp', entry: 'drobek-module-acme-erp' });
    expect(Object.keys(readModulesLock(dir)!.modules)).toEqual(['acmeerp', 'erp']);
  });

  it('upgrades in place (add with a new version) and reports what it replaced', async () => {
    const dir = modulesDir();
    await add(dir, stage(dir, 'drobek-module-probe', { files: tiny('probe') }), 'drobek-module-probe@1.0.0');
    const r = await add(dir, stage(dir, 'drobek-module-probe', { files: tiny('probe', { version: '1.1.0' }) }), 'drobek-module-probe@1.1.0');
    expect(r.replaced).toEqual({ package: 'drobek-module-probe', version: '1.0.0' });
    expect(readModulesLock(dir)!.modules.probe).toMatchObject({ version: '1.1.0', resolved: 'drobek-module-probe@1.1.0', integrity: hashModuleTree(join(dir, 'probe')) });
    expect(stagingLeft(dir)).toEqual([]);
  });

  it('refuses a package without the @drobek/modules peer — nothing changes, the staging prefix is gone', async () => {
    const dir = modulesDir();
    await expect(add(dir, stage(dir, 'drobek-module-probe', { files: tiny('probe', { peers: null }) }))).rejects.toThrow(
      /drobek-module-probe does not declare "@drobek\/modules" in peerDependencies/
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a module whose contract this server does not implement (validateModule, as at start)", async () => {
    const dir = modulesDir();
    const files = tiny('probe');
    files['index.js'] = files['index.js'].replace("contract: '^1.1'", "contract: '^9.0'");
    await expect(add(dir, stage(dir, 'drobek-module-probe', { files }))).rejects.toThrow(
      new RegExp(`it needs module contract \\^9\\.0, but this server implements ${MODULE_CONTRACT_VERSION.replace(/\./g, '\\.')}`)
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it('rolls back to the previous install and lockfile when the new version fails the start-time checks', async () => {
    const dir = modulesDir();
    await add(dir, stage(dir, 'drobek-module-guestbook', { from: GUESTBOOK_FIXTURE }));
    const lockBefore = lockText(dir);
    const hashBefore = hashModuleTree(join(dir, 'guestbook'));
    const staging = stage(dir, 'drobek-module-guestbook', { from: GUESTBOOK_FIXTURE, files: { 'migrations/0000_guestbook_entries.sql': 'DROP TABLE "users";\n' } });
    await expect(add(dir, staging)).rejects.toThrow(/its migrations leave the module's namespace/);
    expect(lockText(dir)).toBe(lockBefore);
    expect(hashModuleTree(join(dir, 'guestbook'))).toBe(hashBefore);
    expect(stagingLeft(dir)).toEqual([]);
  });

  it('refuses a package npm linked from a directory (a symlink out of the prefix)', async () => {
    const dir = modulesDir();
    const src = join(modulesDir(), 'src');
    writeFiles(src, tiny('probe'));
    const staging = `.staging-link${++seq}`;
    mkdirSync(join(dir, staging, 'node_modules'), { recursive: true });
    symlinkSync(src, join(dir, staging, 'node_modules/drobek-module-probe'));
    writeFileSync(join(dir, staging, 'package.json'), '{"dependencies":{"drobek-module-probe":"file:../src"}}');
    await expect(add(dir, staging)).rejects.toThrow(/npm linked drobek-module-probe from a directory .*\(npm pack\)/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('accepts only <dir>/.staging-<id> as the staging prefix', async () => {
    const dir = modulesDir();
    await expect(add(dir, '../elsewhere')).rejects.toThrow(/staging prefix must be/);
    await expect(add(dir, 'probe')).rejects.toThrow(/staging prefix must be/);
    await expect(add(dir, '.staging-missing')).rejects.toThrow(/does not exist — npm installed nothing/);
  });
});

describe('removeModule (task selfhost:module:remove)', () => {
  it('deletes the directory and the lockfile entry, keeps every other module', async () => {
    const dir = modulesDir();
    await add(dir, stage(dir, 'drobek-module-probe', { files: tiny('probe') }));
    await add(dir, stage(dir, 'drobek-module-other', { files: tiny('other') }));
    expect(removeModule(dir, 'probe')).toEqual({ name: 'probe', package: 'drobek-module-probe', version: '1.0.0', removedDir: true, removedLockEntry: true });
    expect(existsSync(join(dir, 'probe'))).toBe(false);
    expect(Object.keys(readModulesLock(dir)!.modules)).toEqual(['other']);
  });

  it('refuses a name that is not installed or not a module name', () => {
    const dir = modulesDir();
    expect(() => removeModule(dir, 'ghost')).toThrow(/no module "ghost" is installed/);
    expect(() => removeModule(dir, '../etc')).toThrow(/is not a module name/);
  });
});

describe('listModules + formatModuleTable (task selfhost:module:list)', () => {
  it('reports ok / changed / missing / unrecorded and whether DROBEK_MODULES names it', async () => {
    const dir = modulesDir();
    for (const n of ['okay', 'changed', 'missing']) await add(dir, stage(dir, `drobek-module-${n}`, { files: tiny(n) }));
    await add(dir, stage(dir, '@acme/drobek-module-erp', { files: tiny('erp', { pkg: '@acme/drobek-module-erp' }) }));
    appendFileSync(join(dir, 'changed/node_modules/drobek-module-changed/index.js'), '// edited\n');
    rmSync(join(dir, 'missing'), { recursive: true });
    writeFiles(join(dir, 'stray'), { 'package.json': '{"dependencies":{"drobek-module-stray":"1.0.0"}}' });
    const rows = listModules(dir);
    expect(rows.map((r) => [r.name, r.status])).toEqual([
      ['changed', 'changed'],
      ['erp', 'ok'],
      ['missing', 'missing'],
      ['okay', 'ok'],
      ['stray', 'unrecorded'],
    ]);
    const table = formatModuleTable(rows, 'auth,okay,@acme/drobek-module-erp');
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/^NAME\s+PACKAGE\s+VERSION\s+CONTRACT\s+INTEGRITY\s+IN DROBEK_MODULES\s+STATUS$/);
    expect(lines.find((l) => l.startsWith('okay'))).toMatch(/drobek-module-okay\s+1\.0\.0\s+\^1\.1\s+sha512-\S{10}…\s+yes\s+ok$/);
    expect(lines.find((l) => l.startsWith('erp'))).toMatch(/\s+yes\s+ok$/);
    expect(lines.find((l) => l.startsWith('changed'))).toMatch(/\s+no\s+changed$/);
    expect(lines.find((l) => l.startsWith('stray'))).toMatch(/drobek-module-stray\s+-\s+-\s+-\s+no\s+unrecorded$/);
  });

  it('is empty for a directory that does not exist yet', () => {
    expect(listModules(join(modulesDir(), 'nope'))).toEqual([]);
  });
});

describe('helpers', () => {
  it('modulesEntryFor / entriesFor / suggestModulesLine', () => {
    expect(modulesEntryFor('erp', 'drobek-module-erp')).toBe('erp');
    expect(modulesEntryFor('erp', '@acme/drobek-module-erp')).toBe('@acme/drobek-module-erp');
    expect(entriesFor('auth, erp ,drobek-module-erp', 'drobek-module-erp')).toEqual(['erp', 'drobek-module-erp']);
    expect(entriesFor('erp', '@acme/drobek-module-erp')).toEqual([]);
    expect(suggestModulesLine('auth,email', 'erp', 'drobek-module-erp')).toEqual({ line: 'DROBEK_MODULES=auth,email,erp', already: false });
    expect(suggestModulesLine('auth,erp', 'erp', 'drobek-module-erp')).toEqual({ line: 'DROBEK_MODULES=auth,erp', already: true });
    expect(suggestModulesLine(undefined, 'erp', 'drobek-module-erp').line).toBe('DROBEK_MODULES=erp');
  });

  it('checkContractPeer: the contract version or the image release satisfies the range', () => {
    const m = (range?: string) => ({ name: 'drobek-module-x', peerDependencies: range === undefined ? {} : { '@drobek/modules': range } });
    expect(checkContractPeer(m('>=1.0.0'))).toBe('>=1.0.0');
    expect(checkContractPeer(m('^1.1'), 'dev')).toBe('^1.1');
    expect(checkContractPeer(m('^0.1.5'), 'v0.1.7')).toBe('^0.1.5');
    expect(() => checkContractPeer(m('^0.1.5'), 'dev')).toThrow(/needs @drobek\/modules \^0\.1\.5, but this server implements module contract/);
    expect(() => checkContractPeer(m('^0.1.5'), 'v0.2.0')).toThrow(/\(release 0\.2\.0\)/);
    expect(() => checkContractPeer(m())).toThrow(/does not declare "@drobek\/modules"/);
    expect(() => checkContractPeer(m('not a range!'))).toThrow(/is not a semver range/);
  });

  it('stripHostPeers keeps a module published under @drobek itself', () => {
    const prefix = join(modulesDir(), '.staging-x');
    writeFiles(prefix, {
      'node_modules/@drobek/drobek-module-x/package.json': '{}',
      'node_modules/@drobek/sdk/package.json': '{}',
      'node_modules/@acme/util/node_modules/zod/package.json': '{}',
    });
    expect(stripHostPeers(prefix, '@drobek/drobek-module-x')).toEqual(['node_modules/@acme/util/node_modules/zod', 'node_modules/@drobek/sdk']);
    expect(existsSync(join(prefix, 'node_modules/@drobek/drobek-module-x/package.json'))).toBe(true);
  });

  it('stagedPackageName needs exactly one dependency; shortIntegrity abbreviates', () => {
    const prefix = join(modulesDir(), '.staging-y');
    writeFiles(prefix, { 'package.json': '{"dependencies":{"a":"1","b":"1"}}' });
    expect(() => stagedPackageName(prefix)).toThrow(/exactly one dependency .* a, b/);
    expect(shortIntegrity(null)).toBe('-');
    expect(shortIntegrity(`sha512-${'A'.repeat(86)}==`)).toBe('sha512-AAAAAAAAAA…');
  });
});
