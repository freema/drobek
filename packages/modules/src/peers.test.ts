/**
 * NSO-345: host-provided peers, end to end in a plain `node` process (no
 * vitest module runner in between): a module in DROBEK_MODULES_DIR that
 * carries its OWN copies of `@drobek/modules` and `zod` gets the server's
 * instances — the same ModuleError class, the same zod — while a file
 * outside the directory keeps resolving its own copies.
 *
 * Runs against the BUILT package (dist/), like the server does: `task check`
 * / `task test` build the packages first.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isHostPeer } from './peers.js';
import { installDirModule, tempModulesDir, tinyModuleFiles } from './test/modules-dir.js';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const DIST_INDEX = join(PKG, 'dist/index.js');

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(file: string, text: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}

/** A bogus package copy that would break the module if it were used. */
function fakeCopies(nodeModules: string): void {
  write(join(nodeModules, 'zod/package.json'), JSON.stringify({ name: 'zod', version: '0.0.1', type: 'module', exports: './index.js' }));
  write(join(nodeModules, 'zod/index.js'), 'export const z = { fake: "zod" }; export default z;\n');
  write(
    join(nodeModules, '@drobek/modules/package.json'),
    JSON.stringify({ name: '@drobek/modules', version: '0.0.1', type: 'module', exports: './index.js' })
  );
  write(
    join(nodeModules, '@drobek/modules/index.js'),
    'export class ModuleError extends Error {}\nexport const defineModule = (m) => m;\nexport const z = { fake: "drobek" };\n'
  );
}

describe('host-provided peers', () => {
  it('names the peers: @drobek/*, zod, drizzle-orm (and their subpaths)', () => {
    for (const s of ['@drobek/modules', '@drobek/modules/testing', '@drobek/sdk', 'zod', 'zod/v4', 'drizzle-orm', 'drizzle-orm/pg-core']) {
      expect(isHostPeer(s)).toBe(true);
    }
    for (const s of ['zodiac', 'drizzle-orm-extra', '@drobekx/a', 'express', './zod.js']) expect(isHostPeer(s)).toBe(false);
  });

  it('a dir module with its own zod + @drobek/modules copies gets the server instances; imports from elsewhere keep theirs', () => {
    expect(existsSync(DIST_INDEX), `${DIST_INDEX} is missing — run pnpm build:packages first`).toBe(true);
    const dir = tempModulesDir();
    const outside = tempModulesDir();
    cleanup.push(dir, outside);

    const files = tinyModuleFiles('probe', {
      body: [
        `  configSchema: z.object({ n: z.number() }), configDefaults: { n: 1 },`,
        `  errors: [{ code: 'probe_failed', meaning: 'x', fix: 'y' }],`,
      ].join('\n'),
    });
    // The probe re-exports what it imported, so the parent can compare identities.
    files['index.js'] = files['index.js']
      .replace(`import { defineModule, z } from '@drobek/modules';`, `import { defineModule, ModuleError } from '@drobek/modules';\nimport { z } from 'zod';\nexport const seen = { ModuleError, z };`)
      .replace('  configSchema: z.object({}), configDefaults: {},\n', '');
    const prefix = installDirModule(dir, { name: 'probe', files, lock: false });
    fakeCopies(join(prefix, 'node_modules'));
    // Re-lock after the copies (they are part of the hashed prefix).
    const lockScript = `import { hashModuleTree, formatModulesLock } from ${JSON.stringify(pathToFileURL(join(PKG, 'dist/lock.js')).href)};
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(dir, 'modules.lock.json'))}, formatModulesLock({ lockfileVersion: 1, modules: { probe: {
  package: 'drobek-module-probe', version: '1.0.0', resolved: 'file:probe.tgz', integrity: hashModuleTree(${JSON.stringify(prefix)}), contract: '^1.1' } } }));`;
    execFileSync(process.execPath, ['--input-type=module', '-e', lockScript]);

    // A file OUTSIDE the modules directory with its own fake zod.
    fakeCopies(join(outside, 'node_modules'));
    write(join(outside, 'other.mjs'), `export { z } from 'zod';\n`);

    const script = `
import * as host from ${JSON.stringify(pathToFileURL(DIST_INDEX).href)};
const { modules, origins } = await host.loadModuleSet(
  { NODE_ENV: 'test', DROBEK_MODULES: 'probe', DROBEK_MODULES_DIR: ${JSON.stringify(dir)} },
  { log: { debug() {}, info() {}, warn() {}, error() {} } },
);
const probe = modules[0];
const ns = await import(${JSON.stringify(pathToFileURL(join(prefix, 'node_modules/drobek-module-probe/index.js')).href)});
const other = await import(${JSON.stringify(pathToFileURL(join(outside, 'other.mjs')).href)});
const err = new ns.seen.ModuleError('probe_failed', 'boom');
console.log(JSON.stringify({
  source: origins.probe.source,
  isDefinedModule: host.isDefinedModule(probe),
  sameModuleError: ns.seen.ModuleError === host.ModuleError,
  isModuleError: host.isModuleError(err),
  instanceOfHost: err instanceof host.ModuleError,
  sameZod: ns.seen.z === host.z,
  schemaIsHostZod: probe.configSchema instanceof host.z.ZodType,
  outsideZodFake: other.z.fake === 'zod',
}));
`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: outside, encoding: 'utf8' });
    expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual({
      source: 'dir',
      isDefinedModule: true,
      sameModuleError: true,
      isModuleError: true,
      instanceOfHost: true,
      sameZod: true,
      schemaIsHostZod: true,
      outsideZodFake: true,
    });
  }, 60_000);
});
