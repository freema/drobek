#!/usr/bin/env node
/**
 * The npm packages for external module authors (NSO-349): `@drobek/sdk`,
 * `@drobek/modules` and `create-drobek-module`.
 *
 * The workspace manifests stay what the server needs (`workspace:*` links to
 * private packages). This script derives the PUBLISHED packages from the
 * built workspace (`pnpm build:packages` first) into `dist-npm/<dir>/`:
 *
 *  - `@drobek/sdk`: its `dist/` as built (no dependencies).
 *  - `@drobek/modules`: `dist/index.js` + `dist/testing.js` bundled with
 *    esbuild — the private workspace packages (`@drobek/db`, `@drobek/core`,
 *    `@drobek/compile`, …) are inlined, every npm package stays an import.
 *    The declarations are rolled up with rollup-plugin-dts, so the `.d.ts`
 *    never names a private package. `zod` + `drizzle-orm` are
 *    peerDependencies (the server provides its own instances to external
 *    modules), `typescript` an optional peer (`checkSkill`), `@drobek/sdk`
 *    a dependency at the same version, the other npm imports dependencies
 *    with the ranges the workspace uses. The core migrations
 *    (`packages/db/drizzle/migrations`) ship in `dist/migrations/core` for
 *    `coreMigrationsDir()`.
 *  - `create-drobek-module`: its `dist/` + `template/`.
 *
 * Every package gets the repository's licence (AGPL-3.0-only, LICENSE) and
 * the version passed with `--version` (the release tag without the `v`;
 * default: the workspace version).
 *
 *   node scripts/npm-packages.mjs stage   [--version X.Y.Z] [--out dist-npm]
 *   node scripts/npm-packages.mjs pack    [--version X.Y.Z] [--out dist-npm]   → dist-npm/*.tgz
 *   node scripts/npm-packages.mjs publish  --version X.Y.Z  [--dry-run]
 *
 * `publish` (the CI `npm` job on a release tag) skips a package whose version
 * is already on the registry and publishes a pre-release (`X.Y.Z-rc.1`) under
 * the dist-tag `next`. Authentication is npm Trusted Publishing (OIDC) — no
 * token; provenance is attached automatically.
 */
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'git+https://github.com/freema/drobek.git';
const LICENSE = 'AGPL-3.0-only';
/** Host-provided: an external module gets the server's instances (one copy of each). */
export const PEERS = ['zod', 'drizzle-orm'];
const OPTIONAL_PEERS = { typescript: '^5.0.0' };
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

/** The packages in publish order (a dependency before its dependents). */
export const NPM_PACKAGES = [
  { name: '@drobek/sdk', src: 'packages/sdk', dir: 'drobek-sdk' },
  { name: '@drobek/modules', src: 'packages/modules', dir: 'drobek-modules' },
  { name: 'create-drobek-module', src: 'packages/create-drobek-module', dir: 'create-drobek-module' },
];

function commonManifest(pkg, src, version) {
  return {
    name: pkg.name,
    version,
    description: pkg.description,
    license: LICENSE,
    type: 'module',
    author: 'Tomáš Grasl',
    homepage: 'https://github.com/freema/drobek/blob/main/docs/MODULES.md#writing-a-module',
    repository: { type: 'git', url: REPO_URL, directory: src },
    bugs: { url: 'https://github.com/freema/drobek/issues' },
    keywords: ['drobek', 'drobek-module', 'mcp'],
    engines: pkg.engines ?? { node: '>=22.0.0' },
    publishConfig: { access: 'public' },
  };
}

function copyCommon(src, out) {
  cpSync(join(ROOT, 'LICENSE'), join(out, 'LICENSE'));
  const readme = join(ROOT, src, 'README.md');
  if (!existsSync(readme)) throw new Error(`${src}/README.md is missing`);
  cpSync(readme, join(out, 'README.md'));
}

function requireBuilt(file) {
  if (!existsSync(file)) throw new Error(`${relative(ROOT, file)} is missing — run \`pnpm build:packages\` first`);
}

async function stageSdk(entry, out, version) {
  const src = join(ROOT, entry.src);
  const pkg = readJson(join(src, 'package.json'));
  requireBuilt(join(src, 'dist/index.js'));
  cpSync(join(src, 'dist'), join(out, 'dist'), { recursive: true });
  copyCommon(entry.src, out);
  writeJson(join(out, 'package.json'), {
    ...commonManifest(pkg, entry.src, version),
    exports: pkg.exports,
    files: ['dist', 'README.md', 'LICENSE'],
    sideEffects: false,
  });
}

/** The package name of a bare specifier (`@scope/x/y` → `@scope/x`, `x/y` → `x`). */
export function packageOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The private `@drobek/*` packages a declaration file still imports (comments aside). */
export function privateImports(dtsText) {
  const re = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+['"](@drobek\/(?!sdk\b)[^'"]+)['"]|\bimport\(\s*['"](@drobek\/(?!sdk\b)[^'"]+)['"]\s*\)/g;
  return [...dtsText.matchAll(re)].map((m) => m[1] ?? m[2]);
}

const isBuiltin = (spec) => spec.startsWith('node:') || builtinModules.includes(spec.split('/')[0]);
/** A private workspace package that is inlined into the bundle. */
const isInlined = (name) => name.startsWith('@drobek/') && name !== '@drobek/sdk';

/** The nearest package.json above `file`. */
function manifestOf(file) {
  for (let d = dirname(file); d !== dirname(d); d = dirname(d)) {
    if (existsSync(join(d, 'package.json'))) return join(d, 'package.json');
  }
  throw new Error(`no package.json above ${file}`);
}

async function stageModules(entry, out, version) {
  const src = join(ROOT, entry.src);
  const pkg = readJson(join(src, 'package.json'));
  const entries = { index: join(src, 'dist/index.js'), testing: join(src, 'dist/testing.js') };
  for (const f of Object.values(entries)) requireBuilt(f);
  const esbuild = await import('esbuild');

  // 1. JS: inline the private workspace packages, keep every npm import.
  /** npm package → the range the importing workspace package declares. */
  const npmDeps = new Map();
  const external = {
    name: 'drobek-externals',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (isBuiltin(args.path)) return { external: true };
        const name = packageOf(args.path);
        if (isInlined(name)) {
          if (args.pluginData === 'drobek-inlined') return undefined;
          // The workspace packages are libraries without import-time effects:
          // what the entries do not use (e.g. @drobek/auth's react-router
          // routes behind @drobek/insights) is dropped with its npm imports.
          const r = await build.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: 'drobek-inlined' });
          if (r.errors.length) return { errors: r.errors };
          return { path: r.path, sideEffects: false };
        }
        if (!npmDeps.has(name)) {
          const m = readJson(manifestOf(args.importer));
          const range = m.dependencies?.[name] ?? m.peerDependencies?.[name] ?? m.devDependencies?.[name];
          if (!range && name !== 'typescript') throw new Error(`${relative(ROOT, args.importer)} imports ${name}, which its package.json does not declare`);
          npmDeps.set(name, range);
        }
        return { external: true };
      });
    },
  };
  const built = await esbuild.build({
    entryPoints: entries,
    metafile: true,
    outdir: join(out, 'dist'),
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    chunkNames: '[name]-[hash]',
    plugins: [external],
    logLevel: 'error',
    legalComments: 'inline',
    banner: { js: '// @drobek/modules — AGPL-3.0-only — https://github.com/freema/drobek' },
  });

  // Only what the output still imports becomes a dependency.
  const imported = new Set(
    Object.values(built.metafile.outputs).flatMap((o) => o.imports.filter((i) => i.external && !isBuiltin(i.path)).map((i) => packageOf(i.path)))
  );
  for (const name of [...npmDeps.keys()]) if (!imported.has(name)) npmDeps.delete(name);

  // 2. Declarations: one rolled-up .d.ts per entry, private packages inlined.
  const { rollup } = await import('rollup');
  const { dts } = await import('rollup-plugin-dts');
  const dtsExternal = (id) => {
    if (id.startsWith('.') || id.startsWith('/')) return false;
    if (isBuiltin(id)) return true;
    return !isInlined(packageOf(id));
  };
  // pnpm links a workspace package into every dependent's node_modules: resolve
  // to the real file, or one package would be inlined once per link path.
  const realpaths = {
    name: 'drobek-realpaths',
    async resolveId(source, importer, options) {
      if (!isInlined(packageOf(source)) || source.startsWith('.')) return null;
      const r = await this.resolve(source, importer, { ...options, skipSelf: true });
      return r && !r.external ? { ...r, id: realpathSync(r.id) } : r;
    },
  };
  const bundle = await rollup({
    input: { index: join(src, 'dist/index.d.ts'), testing: join(src, 'dist/testing.d.ts') },
    plugins: [realpaths, dts({ respectExternal: true, tsconfig: join(src, 'tsconfig.build.json') })],
    external: dtsExternal,
    onwarn(w, warn) {
      if (w.code === 'CIRCULAR_DEPENDENCY' || w.code === 'UNUSED_EXTERNAL_IMPORT') return;
      warn(w);
    },
  });
  await bundle.write({ dir: join(out, 'dist'), format: 'es', entryFileNames: '[name].d.ts', chunkFileNames: '[name]-[hash].d.ts' });
  await bundle.close();
  const privateLeak = readdirSync(join(out, 'dist'))
    .filter((f) => f.endsWith('.d.ts'))
    .flatMap((f) => privateImports(readFileSync(join(out, 'dist', f), 'utf8')).map((m) => `${f}: ${m}`));
  if (privateLeak.length) throw new Error(`the rolled-up declarations still import private packages: ${privateLeak.join(', ')}`);

  // 3. The core migrations for coreMigrationsDir() (SQL + journal; drizzle's migrator reads nothing else).
  const coreSrc = join(ROOT, 'packages/db/drizzle/migrations');
  const coreOut = join(out, 'dist/migrations/core');
  mkdirSync(join(coreOut, 'meta'), { recursive: true });
  for (const f of readdirSync(coreSrc)) if (f.endsWith('.sql')) cpSync(join(coreSrc, f), join(coreOut, f));
  cpSync(join(coreSrc, 'meta/_journal.json'), join(coreOut, 'meta/_journal.json'));

  copyCommon(entry.src, out);
  const dependencies = {};
  const peerDependencies = {};
  for (const [name, range] of [...npmDeps].sort(([a], [b]) => a.localeCompare(b))) {
    if (name === '@drobek/sdk') dependencies[name] = version;
    else if (PEERS.includes(name)) peerDependencies[name] = range;
    else if (!(name in OPTIONAL_PEERS)) dependencies[name] = range;
  }
  for (const p of PEERS) if (!peerDependencies[p]) peerDependencies[p] = pkg.dependencies[p];
  Object.assign(peerDependencies, OPTIONAL_PEERS);
  writeJson(join(out, 'package.json'), {
    ...commonManifest(pkg, entry.src, version),
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './testing': { types: './dist/testing.d.ts', default: './dist/testing.js' },
      './package.json': './package.json',
    },
    files: ['dist', 'README.md', 'LICENSE'],
    dependencies,
    peerDependencies,
    peerDependenciesMeta: Object.fromEntries(Object.keys(OPTIONAL_PEERS).map((n) => [n, { optional: true }])),
  });
}

async function stageCreate(entry, out, version) {
  const src = join(ROOT, entry.src);
  const pkg = readJson(join(src, 'package.json'));
  requireBuilt(join(src, 'dist/cli.js'));
  cpSync(join(src, 'dist'), join(out, 'dist'), { recursive: true, filter: (f) => !f.endsWith('.test.js') && !f.endsWith('.test.d.ts') });
  cpSync(join(src, 'template'), join(out, 'template'), { recursive: true });
  copyCommon(entry.src, out);
  writeJson(join(out, 'package.json'), {
    ...commonManifest(pkg, entry.src, version),
    bin: pkg.bin,
    exports: pkg.exports,
    files: ['dist', 'template', 'README.md', 'LICENSE'],
  });
}

const STAGERS = { '@drobek/sdk': stageSdk, '@drobek/modules': stageModules, 'create-drobek-module': stageCreate };

/** The version the workspace packages carry (when no --version is given). */
export function workspaceVersion() {
  return readJson(join(ROOT, 'packages/modules/package.json')).version;
}

/** Stage every npm package into `<out>/<dir>`; returns `{ name, version, dir }` per package. */
export async function stagePackages({ out = join(ROOT, 'dist-npm'), version = workspaceVersion() } = {}) {
  if (!SEMVER_RE.test(version)) throw new Error(`--version ${JSON.stringify(version)} is not X.Y.Z[-pre]`);
  rmSync(out, { recursive: true, force: true });
  const staged = [];
  for (const entry of NPM_PACKAGES) {
    const dir = join(out, entry.dir);
    mkdirSync(dir, { recursive: true });
    await STAGERS[entry.name](entry, dir, version);
    staged.push({ name: entry.name, version, dir });
  }
  return staged;
}

/** `npm pack` every staged package into `out`; returns the tarball paths (same order). */
export function packPackages(staged, out) {
  return staged.map((s) => {
    const json = execFileSync('npm', ['pack', s.dir, '--pack-destination', out, '--json', '--ignore-scripts'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return join(out, JSON.parse(json)[0].filename);
  });
}

/** Is `name@version` on the registry? */
function published(name, version, exec) {
  try {
    return exec('npm', ['view', `${name}@${version}`, 'version', '--json']).trim() !== '';
  } catch (err) {
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    if (/E404|404 Not Found|is not in this registry/i.test(text)) return false;
    throw err;
  }
}

/**
 * Publish every staged package whose version is not on the registry yet.
 * A pre-release goes out under the dist-tag `next` (never `latest`).
 */
export function publishPackages(staged, { dryRun = false, exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), log = console.log } = {}) {
  const results = [];
  for (const s of staged) {
    if (published(s.name, s.version, exec)) {
      log(`${s.name}@${s.version} is already published — skipped`);
      results.push({ name: s.name, action: 'skipped' });
      continue;
    }
    const args = ['publish', s.dir, '--access', 'public', ...(s.version.includes('-') ? ['--tag', 'next'] : []), ...(dryRun ? ['--dry-run'] : [])];
    log(`npm ${args.join(' ')}`);
    exec('npm', args);
    results.push({ name: s.name, action: dryRun ? 'dry-run' : 'published' });
  }
  return results;
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv) {
  const [cmd, ...args] = argv;
  const out = resolve(argValue(args, '--out') ?? join(ROOT, 'dist-npm'));
  const version = argValue(args, '--version')?.replace(/^v/, '');
  if (!['stage', 'pack', 'publish'].includes(cmd)) {
    console.error('usage: node scripts/npm-packages.mjs stage|pack|publish [--version X.Y.Z] [--out dir] [--dry-run]');
    process.exit(2);
  }
  if (cmd === 'publish' && !version) throw new Error('publish needs --version (the release tag)');
  const staged = await stagePackages({ out, ...(version ? { version } : {}) });
  for (const s of staged) console.log(`staged ${s.name}@${s.version} → ${relative(ROOT, s.dir)}`);
  if (cmd === 'pack') for (const t of packPackages(staged, out)) console.log(`packed ${relative(ROOT, t)}`);
  if (cmd === 'publish') publishPackages(staged, { dryRun: args.includes('--dry-run') });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
