#!/usr/bin/env node
/** Test this checkout's packed public packages from outside the monorepo:
 *  1. the PACKED create-drobek-module scaffolds a module that installs the
 *     packed @freema/drobek-modules + -sdk, typechecks, builds and passes
 *     `npm test` and `npm run check`;
 *  2. a trusted external module (optional) builds and passes its tests
 *     against them, and its packed tarball loads with its SDK building.
 * Everything runs in a disposable temp directory, never in a checkout.
 * Requires pnpm build:packages first; npm registry access is needed.
 *
 *   node scripts/check-external-module.mjs [/path/to/trusted-module] [X.Y.Z]
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { packPackages, stagePackages } from './npm-packages.mjs';

const args = process.argv.slice(2).filter((a) => a !== '');
const source = args[0] && !/^v?\d+\.\d+\.\d+/.test(args[0]) ? args.shift() : undefined;
const version = args[0]?.replace(/^v/, '') || undefined;
const root = mkdtempSync(join(realpathSync(tmpdir()), 'drobek-module-compat-'));
console.log(`Compatibility workspace (retained for diagnostics): ${root}`);
const packages = join(root, 'packages');
const staged = await stagePackages({ out: packages, ...(version ? { version } : {}) });
const packed = packPackages(staged, packages);
// Keyed by the workspace name: a `file:` tarball installs under the dependency's key, as the
// published `npm:@freema/drobek-*` aliases do, so the module's `@drobek/*` imports resolve.
const tarballs = Object.fromEntries(staged.map((pkg, i) => [pkg.workspace, `file:${packed[i]}`]));
const candidate = staged.find((pkg) => pkg.workspace === '@drobek/modules').version;
const env = { ...process.env, npm_config_cache: join(root, 'npm-cache') };
function run(cwd, command, argv, capture = false) {
  return execFileSync(command, argv, {
    cwd, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
}
const install = (cwd) => run(cwd, 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
// The candidate tarballs replace the module's @drobek/* dev dependencies; the override makes the
// modules package's own SDK dependency use the candidate too, before this version is on npm.
const withCandidates = (manifest) => ({
  ...manifest,
  devDependencies: { ...manifest.devDependencies, '@drobek/modules': tarballs['@drobek/modules'], '@drobek/sdk': tarballs['@drobek/sdk'] },
  overrides: { ...manifest.overrides, '@drobek/sdk': '$@drobek/sdk' },
});

const creator = join(root, 'creator');
mkdirSync(creator);
writeFileSync(join(creator, 'package.json'), JSON.stringify({ private: true, dependencies: { 'create-drobek-module': tarballs['create-drobek-module'] } }, null, 2) + '\n');
install(creator);
run(root, process.execPath, [join(creator, 'node_modules/create-drobek-module/dist/cli.js'), 'acme-erp', '--dir', join(root, 'scaffold')]);
const scaffolded = join(root, 'scaffold/drobek-module-acme-erp');
const generated = JSON.parse(readFileSync(join(scaffolded, 'package.json'), 'utf8'));
assert.equal(generated.devDependencies['@drobek/modules'], `npm:@freema/drobek-modules@^${candidate}`);
assert.equal(generated.peerDependencies['@drobek/modules'], `>=${candidate}`);
writeFileSync(join(scaffolded, 'package.json'), JSON.stringify(withCandidates(generated), null, 2) + '\n');
install(scaffolded);
for (const command of ['typecheck', 'build', 'test', 'check']) run(scaffolded, 'npm', ['run', command]);
console.log(`PASS: a create-drobek-module scaffold against @freema/drobek-modules@${candidate}`);

if (!source) process.exit(0);

const moduleDir = realpathSync(resolve(source));
const original = JSON.parse(readFileSync(join(moduleDir, 'package.json'), 'utf8'));
for (const command of ['typecheck', 'build', 'test']) {
  assert.ok(original.scripts?.[command], `module needs an npm run ${command} script`);
}
const project = join(root, 'module');
const excluded = new Set(['node_modules', '.git', '.drobek', '.drobek-npm', 'dist', 'coverage']);
cpSync(moduleDir, project, { recursive: true, filter: (path) => path === moduleDir || !excluded.has(basename(path)) });
writeFileSync(join(project, 'package.json'), JSON.stringify(withCandidates(original), null, 2) + '\n');
install(project);
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
install(consumer);
writeFileSync(join(consumer, 'check.mjs'), `
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { isDefinedModule, parseJobInterval } from '@drobek/modules';
import { buildSdk, loadModules } from '@drobek/modules/testing';
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
const jobs = modules[0].jobs ?? [];
for (const job of jobs) {
  if (typeof job.every !== 'function') assert.notEqual(parseJobInterval(job.every), null, 'job ' + job.name + ': invalid interval');
}
console.log('Packed module loads and its SDK builds:', mod.name, mod.version, mod.contract, 'jobs:', jobs.map((j) => j.name).join(', ') || 'none');
`);
run(consumer, process.execPath, ['check.mjs']);
console.log(`PASS: ${original.name}@${original.version} against @drobek/modules (@freema/drobek-modules@${candidate})`);
