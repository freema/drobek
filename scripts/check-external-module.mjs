#!/usr/bin/env node
/** Test a trusted external module against this checkout's packed public API.
 * Runs the module's build/tests in a disposable copy, never in its checkout.
 * Requires pnpm build:packages first. npm registry access may be needed.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { packPackages, stagePackages } from './npm-packages.mjs';

const source = process.argv[2];
if (!source) {
  console.error('usage: node scripts/check-external-module.mjs /path/to/trusted-module [X.Y.Z]');
  process.exit(2);
}
const moduleDir = realpathSync(resolve(source));
const original = JSON.parse(readFileSync(join(moduleDir, 'package.json'), 'utf8'));
for (const command of ['typecheck', 'build', 'test']) {
  assert.ok(original.scripts?.[command], `module needs an npm run ${command} script`);
}
const root = mkdtempSync(join(realpathSync(tmpdir()), 'drobek-module-compat-'));
console.log(`Compatibility workspace (retained for diagnostics): ${root}`);
const packages = join(root, 'packages');
const version = process.argv[3]?.replace(/^v/, '') || undefined;
const staged = await stagePackages({ out: packages, ...(version ? { version } : {}) });
const packed = packPackages(staged, packages);
// Keyed by the workspace name: a `file:` tarball installs under the dependency's key, as the
// published `npm:@freema/drobek-*` aliases do, so the module's `@drobek/*` imports resolve.
const tarballs = Object.fromEntries(staged.map((pkg, i) => [pkg.workspace, `file:${packed[i]}`]));
const project = join(root, 'module');
const excluded = new Set(['node_modules', '.git', '.drobek', '.drobek-npm', 'dist', 'coverage']);
cpSync(moduleDir, project, { recursive: true, filter: (path) => path === moduleDir || !excluded.has(basename(path)) });
const manifest = structuredClone(original);
manifest.devDependencies = {
  ...manifest.devDependencies,
  '@drobek/modules': tarballs['@drobek/modules'],
  '@drobek/sdk': tarballs['@drobek/sdk'],
};
// Ensure the contract's SDK dependency also uses the candidate tarball,
// even before this version is available on npm. Other lockfile pins remain.
manifest.overrides = { ...manifest.overrides, '@drobek/sdk': '$@drobek/sdk' };
writeFileSync(join(project, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
const env = { ...process.env, npm_config_cache: join(root, 'npm-cache') };
function run(cwd, command, args, capture = false) {
  return execFileSync(command, args, {
    cwd, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
}
run(project, 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
for (const command of ['typecheck', 'build', 'test']) run(project, 'npm', ['run', command]);

// Pack the original public manifest: local candidate paths must never ship.
writeFileSync(join(project, 'package.json'), JSON.stringify(original, null, 2) + '\n');
const [artifact] = JSON.parse(run(project, 'npm', ['pack', '--ignore-scripts', '--json'], true));
const moduleTarball = join(project, artifact.filename);
assert.ok(existsSync(moduleTarball));
const consumer = join(root, 'consumer');
mkdirSync(consumer);
writeFileSync(join(consumer, 'package.json'), JSON.stringify({
  private: true, type: 'module',
  dependencies: {
    [original.name]: `file:${moduleTarball}`,
    '@drobek/modules': tarballs['@drobek/modules'],
    '@drobek/sdk': tarballs['@drobek/sdk'],
  },
  overrides: { '@drobek/sdk': '$@drobek/sdk' },
}, null, 2) + '\n');
run(consumer, 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
writeFileSync(join(consumer, 'check.mjs'), `
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { isDefinedModule, loadModules, buildSdk } from '@drobek/modules';
const pkg = ${JSON.stringify(original.name)};
const mod = (await import(pkg)).default;
assert.ok(isDefinedModule(mod), 'packed module must share the host contract');
const modules = await loadModules({ DROBEK_MODULES: pkg }, {
  importer: (name) => import(name),
});
assert.equal(modules.length, 1);
if (mod.migrations) assert.ok(existsSync(mod.migrations.folder), 'packed migrations missing');
if (mod.sdk) assert.ok(existsSync(mod.sdk.entry), 'packed SDK entry missing');
await buildSdk(modules);
console.log('Packed module loads and its SDK builds:', mod.name, mod.version, mod.contract);
`);
run(consumer, process.execPath, ['check.mjs']);
console.log(`PASS: ${original.name}@${original.version} against @drobek/modules (@freema/drobek-modules@${staged.find((pkg) => pkg.workspace === '@drobek/modules').version})`);
