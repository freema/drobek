import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatModulesLock, hashModuleTree, parseModulesLock, readModulesLock, type ModulesLock } from './lock.js';
import { tempModulesDir } from './test/modules-dir.js';

const dirs: string[] = [];
function tree(files: Record<string, string>): string {
  const root = tempModulesDir();
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FILES = { 'package.json': '{}', 'node_modules/a/index.js': 'export default 1', 'node_modules/a/package.json': '{"name":"a"}', 'node_modules/b/x.js': '' };
const SAMPLE = `sha512-${'A'.repeat(86)}==`;

describe('hashModuleTree', () => {
  it('is deterministic: independent of creation order, mtimes and location', () => {
    const a = tree(FILES);
    const b = tree(Object.fromEntries(Object.entries(FILES).reverse()));
    utimesSync(join(b, 'package.json'), new Date(0), new Date(0));
    mkdirSync(join(b, 'node_modules/empty-dir'));
    expect(hashModuleTree(a)).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(hashModuleTree(a)).toBe(hashModuleTree(b));
  });

  it('changes with any content, rename, added or removed file', () => {
    const base = hashModuleTree(tree(FILES));
    expect(hashModuleTree(tree({ ...FILES, 'node_modules/b/x.js': ' ' }))).not.toBe(base);
    const { ['node_modules/b/x.js']: _gone, ...rest } = FILES;
    expect(hashModuleTree(tree({ ...rest, 'node_modules/b/y.js': '' }))).not.toBe(base);
    expect(hashModuleTree(tree(rest))).not.toBe(base);
    expect(hashModuleTree(tree({ ...FILES, '.hidden': '' }))).not.toBe(base);
  });

  it('records symlinks inside the tree by target, and refuses one that leaves it', () => {
    const root = tree(FILES);
    const before = hashModuleTree(root);
    mkdirSync(join(root, 'node_modules/.bin'));
    symlinkSync('../a/index.js', join(root, 'node_modules/.bin/a'));
    expect(hashModuleTree(root)).not.toBe(before);
    symlinkSync('/etc/hosts', join(root, 'escape'));
    expect(() => hashModuleTree(root)).toThrow(/symlink that leaves the module directory/);
  });
});

describe('modules.lock.json', () => {
  const lock: ModulesLock = {
    lockfileVersion: 1,
    modules: {
      zeta: { package: 'drobek-module-zeta', version: '1.0.0', resolved: 'drobek-module-zeta@1.0.0', integrity: SAMPLE, contract: '^1.1' },
      alpha: { package: '@acme/drobek-module-alpha', version: '2.1.0', resolved: 'https://x/alpha.tgz', integrity: SAMPLE, contract: null, installedAt: '2026-09-26T00:00:00.000Z' },
    },
  };

  it('round-trips; formatModulesLock sorts module names and ends with a newline', () => {
    const text = formatModulesLock(lock);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"zeta"'));
    const dir = tree({ 'modules.lock.json': text });
    expect(readModulesLock(dir)).toEqual(lock);
    expect(readModulesLock(tree({}))).toBeNull();
  });

  it('refuses a malformed lockfile with the reason', () => {
    expect(() => parseModulesLock({ lockfileVersion: 2, modules: {} })).toThrow(/lockfileVersion must be 1/);
    expect(() => parseModulesLock({ lockfileVersion: 1 })).toThrow(/"modules" must be an object/);
    expect(() => parseModulesLock({ lockfileVersion: 1, modules: { x: { ...lock.modules.zeta, integrity: 'sha256-abc' } } })).toThrow(/integrity must be sha512/);
    expect(() => parseModulesLock({ lockfileVersion: 1, modules: { x: { ...lock.modules.zeta, package: '' } } })).toThrow(/package must be a non-empty string/);
    expect(parseModulesLock({ lockfileVersion: 1, modules: { x: { ...lock.modules.zeta, contract: undefined } } }).modules.x.contract).toBeNull();
    expect(() => readModulesLock(tree({ 'modules.lock.json': '{nope' }))).toThrow(/modules\.lock\.json is not valid JSON/);
  });
});
