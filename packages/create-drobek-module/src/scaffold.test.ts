/**
 * NSO-349: the scaffold, and the npm packages it is written against.
 *
 *  - parseTarget / scaffold: names, placeholders, refusal of a non-empty dir;
 *  - examples/drobek-module-hello IS the scaffold's output (+ the slot demo):
 *    same files, same boilerplate, same scripts;
 *  - the real thing, offline: scripts/npm-packages.mjs stages + `npm pack`s
 *    @drobek/sdk, @drobek/modules and create-drobek-module; the PACKED
 *    create-drobek-module generates a module into a temp directory OUTSIDE the
 *    workspace; the PACKED @drobek/modules + @drobek/sdk are unpacked into its
 *    node_modules (npm packages linked from the workspace store — no network);
 *    the module typechecks, builds, loads, and passes its own tests
 *    (createModuleTestContext over PGlite + checkSkill). A template or a
 *    public type that rots turns this red.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PEERS, ROOT, packPackages, stagePackages } from '../../../scripts/npm-packages.mjs';
import { TEMPLATE_DIR, parseTarget, renderTemplate, scaffold } from './index.js';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const EXAMPLE = join(ROOT, 'examples/drobek-module-hello');
const tmp = mkdtempSync(join(realpathSync(tmpdir()), 'drobek-scaffold-'));

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir)
    .filter((n) => n !== 'node_modules' && n !== 'dist')
    .flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n), base) : [relative(base, join(dir, n))]))
    .sort();
}

describe('parseTarget', () => {
  it('derives package, module, directory and the DROBEK_MODULES entry', () => {
    expect(parseTarget('erp')).toEqual({ packageName: 'drobek-module-erp', moduleName: 'erp', dirName: 'drobek-module-erp', modulesEntry: 'erp' });
    expect(parseTarget('drobek-module-erp').modulesEntry).toBe('erp');
    expect(parseTarget('@acme/drobek-module-erp')).toEqual({
      packageName: '@acme/drobek-module-erp',
      moduleName: 'erp',
      dirName: 'drobek-module-erp',
      modulesEntry: '@acme/drobek-module-erp',
    });
    // A module name has no dashes: the full package name goes into DROBEK_MODULES.
    expect(parseTarget('acme-erp')).toMatchObject({ packageName: 'drobek-module-acme-erp', moduleName: 'acmeerp', modulesEntry: 'drobek-module-acme-erp' });
    expect(parseTarget('acme-erp', 'erp').moduleName).toBe('erp');
  });

  it('refuses invalid, reserved and built-in names', () => {
    expect(() => parseTarget('Bad Name')).toThrow(/not a valid npm package name/);
    expect(() => parseTarget('x')).toThrow(/must match/);
    expect(() => parseTarget('sdk')).toThrow(/reserved/);
    expect(() => parseTarget('auth')).toThrow(/built-in/);
    expect(() => parseTarget('erp', 'Erp')).toThrow(/must match/);
  });
});

describe('scaffold', () => {
  it('writes the template with every placeholder replaced (and .gitignore from _gitignore)', () => {
    const { dir, files } = scaffold(parseTarget('acme-erp'), { parent: join(tmp, 'unit'), drobekVersion: '2.3.4' });
    expect(files).toEqual(expect.arrayContaining(['.gitignore', 'package.json', 'SKILL.md', 'README.md', 'src/index.ts', 'src/sdk.ts', 'src/schema.ts', 'src/index.test.ts', 'src/skill.test.ts', 'migrations/0000_init.sql', 'migrations/meta/_journal.json']));
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/\{\{\w+\}\}/);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg).toMatchObject({ name: 'drobek-module-acme-erp', type: 'module', peerDependencies: { '@drobek/modules': '>=2.3.4' } });
    expect(Object.keys(pkg.scripts)).toEqual(expect.arrayContaining(['build', 'typecheck', 'test', 'check']));
    expect(readFileSync(join(dir, 'src/index.ts'), 'utf8')).toContain("name: 'acmeerp'");
    expect(readFileSync(join(dir, 'src/index.ts'), 'utf8')).toContain("contract: '^1.1'");
    expect(readFileSync(join(dir, 'migrations/0000_init.sql'), 'utf8')).toContain('"mod_acmeerp_items"');
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('task selfhost:module:add -- drobek-module-acme-erp@0.1.0');
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('DROBEK_MODULES=auth,email,forms,data,proxy,files,drobek-module-acme-erp');
    expect(() => scaffold(parseTarget('acme-erp'), { parent: join(tmp, 'unit') })).toThrow(/not empty/);
  });

  it('renderTemplate leaves unknown placeholders alone', () => {
    expect(renderTemplate('{{module}} {{MODULE}} {{nope}}', parseTarget('erp'), '1.0.0')).toBe('erp ERP {{nope}}');
  });
});

describe('examples/drobek-module-hello is the scaffold output (+ the slot demo)', () => {
  const hello = parseTarget('hello');
  const generated = scaffold(hello, { parent: join(tmp, 'hello'), drobekVersion: '0.0.0' }).dir;

  it('has every file of the scaffold (the migration under its own name)', () => {
    const want = walk(generated).filter((f) => !f.startsWith('migrations/0'));
    expect(walk(EXAMPLE)).toEqual(expect.arrayContaining(want));
  });

  it('shares the boilerplate byte for byte', () => {
    for (const f of ['tsconfig.json', 'tsconfig.build.json', 'vitest.config.ts', 'src/skill.test.ts', '.gitignore']) {
      expect(readFileSync(join(EXAMPLE, f), 'utf8'), f).toBe(readFileSync(join(generated, f), 'utf8'));
    }
  });

  it('has the same package shape (the example links the workspace packages where the scaffold has npm peers)', () => {
    const ex = JSON.parse(readFileSync(join(EXAMPLE, 'package.json'), 'utf8'));
    const gen = JSON.parse(readFileSync(join(generated, 'package.json'), 'utf8'));
    for (const key of ['type', 'exports', 'files', 'scripts', 'engines', 'license']) expect(ex[key], key).toEqual(gen[key]);
    expect(Object.keys({ ...ex.dependencies, ...ex.peerDependencies }).sort()).toEqual(Object.keys(gen.peerDependencies).sort());
  });

  it('tests itself the scaffold way: coreMigrationsDir + createTestApp, checkSkill', () => {
    const test = readFileSync(join(EXAMPLE, 'src/index.test.ts'), 'utf8');
    expect(test).toContain("from '@drobek/modules/testing'");
    expect(test).toMatch(/coreMigrationsDir\(\)/);
    expect(test).toMatch(/createTestApp\(/);
    expect(test).not.toContain('@drobek/db');
  });
});

/** Where the workspace has an npm package installed (its real path). */
function installed(name: string): string {
  const dirs = [PKG_DIR, join(ROOT, 'packages/modules'), ROOT, ...['packages', 'modules'].flatMap((d) => readdirSync(join(ROOT, d)).map((n) => join(ROOT, d, n)))];
  for (const d of dirs) {
    const p = join(d, 'node_modules', name);
    if (existsSync(join(p, 'package.json'))) return realpathSync(p);
  }
  throw new Error(`${name} is not installed anywhere in the workspace`);
}

function untar(tgz: string, into: string) {
  mkdirSync(into, { recursive: true });
  execFileSync('tar', ['-xzf', tgz, '-C', into, '--strip-components=1']);
}

describe('the packed packages: a module generated by create-drobek-module passes its tests against them', () => {
  let staged: { name: string; version: string; dir: string }[];
  let tarballs: string[];
  let project: string;
  const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '', NO_COLOR: '1', FORCE_COLOR: '0' } });

  beforeAll(async () => {
    const out = join(tmp, 'npm');
    staged = await stagePackages({ out, version: '0.9.0' });
    tarballs = packPackages(staged, out);
  });

  it('stages three self-contained packages: AGPL-3.0-only, host peers, no private package, no workspace link', () => {
    expect(staged.map((s) => s.name)).toEqual(['@drobek/sdk', '@drobek/modules', 'create-drobek-module']);
    for (const s of staged) {
      const pkg = JSON.parse(readFileSync(join(s.dir, 'package.json'), 'utf8'));
      expect(pkg, s.name).toMatchObject({ version: '0.9.0', license: 'AGPL-3.0-only', publishConfig: { access: 'public' }, repository: { url: 'git+https://github.com/freema/drobek.git' } });
      expect(pkg.private, s.name).toBeUndefined();
      expect(JSON.stringify(pkg), s.name).not.toContain('workspace:');
      expect(existsSync(join(s.dir, 'README.md')) && existsSync(join(s.dir, 'LICENSE')), s.name).toBe(true);
    }
    const mods = JSON.parse(readFileSync(join(staged[1].dir, 'package.json'), 'utf8'));
    for (const p of PEERS) {
      expect(mods.peerDependencies[p], p).toBeDefined();
      expect(mods.dependencies[p], p).toBeUndefined();
    }
    expect(mods.dependencies['@drobek/sdk']).toBe('0.9.0');
    expect(Object.keys(mods.dependencies).filter((d) => d.startsWith('@drobek/'))).toEqual(['@drobek/sdk']);
    expect(mods.peerDependenciesMeta.typescript.optional).toBe(true);
    for (const f of readdirSync(join(staged[1].dir, 'dist')).filter((n) => n.endsWith('.d.ts') || n.endsWith('.js'))) {
      expect(readFileSync(join(staged[1].dir, 'dist', f), 'utf8'), f).not.toMatch(/from ['"]@drobek\/(?!sdk)/);
    }
    expect(existsSync(join(staged[1].dir, 'dist/migrations/core/meta/_journal.json'))).toBe(true);
    expect(tarballs.every((t) => existsSync(t))).toBe(true);
  });

  it('the generated module typechecks, builds, loads and passes npm test + npm run check', () => {
    // 1. Generate with the PACKED scaffold, outside the workspace.
    const create = join(tmp, 'pkg-create');
    untar(tarballs[2], create);
    execFileSync(process.execPath, [join(create, 'dist/cli.js'), 'acme-erp', '--dir', join(tmp, 'gen')], { encoding: 'utf8' });
    project = join(tmp, 'gen/drobek-module-acme-erp');
    const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['@drobek/modules']).toBe('^0.9.0');

    // 2. "npm install", offline: our tarballs unpacked, npm packages linked from the store.
    const nm = join(project, 'node_modules');
    untar(tarballs[0], join(nm, '@drobek/sdk'));
    untar(tarballs[1], join(nm, '@drobek/modules'));
    const mods = JSON.parse(readFileSync(join(nm, '@drobek/modules/package.json'), 'utf8'));
    const npmDeps = new Set([...Object.keys(pkg.devDependencies), ...Object.keys(mods.dependencies), ...Object.keys(mods.peerDependencies)]);
    for (const name of npmDeps) {
      if (name.startsWith('@drobek/')) continue;
      mkdirSync(dirname(join(nm, name)), { recursive: true });
      symlinkSync(installed(name), join(nm, name), 'dir');
    }
    writeFileSync(join(project, '.npmrc'), 'offline=true\n');

    // 3. What the author runs.
    const tsc = join(nm, 'typescript/bin/tsc');
    run(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json']);
    run(process.execPath, [tsc, '-p', 'tsconfig.build.json']);
    expect(existsSync(join(project, 'dist/index.js')) && existsSync(join(project, 'dist/sdk.js'))).toBe(true);
    const loaded = run(process.execPath, ['--input-type=module', '-e', "const m = (await import('./dist/index.js')).default; console.log(JSON.stringify({ name: m.name, contract: m.contract, errors: m.errors.map((e) => e.code) }));"]);
    expect(JSON.parse(loaded)).toEqual({ name: 'acmeerp', contract: '^1.1', errors: ['acmeerp_full'] });
    const vitest = join(nm, 'vitest/vitest.mjs');
    const test = run(process.execPath, [vitest, 'run', '--reporter=verbose']);
    expect(test).toMatch(/Tests\s+9 passed/);
    const check = run(process.execPath, [vitest, 'run', 'src/skill.test.ts']);
    expect(check).toMatch(/Tests\s+1 passed/);
  });
});

it('the template directory ships inside the package', () => {
  expect(existsSync(join(TEMPLATE_DIR, 'SKILL.md'))).toBe(true);
});
