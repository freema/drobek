/**
 * The browser SDK of THIS server (M1-01): at startup esbuild bundles the SDK
 * core (`@drobek/sdk` core.ts) + the `sdk.entry` of every active module into
 * ONE ES module, served on every app host at `/__drobek/sdk.js`; the
 * declarations go to `/__drobek/sdk.d.ts`. Only ACTIVE modules are in it.
 *
 * Versioning: `hash` = sha256 of the bundle (16 hex chars). `url` =
 * `/__drobek/sdk.js?v=<hash>` is what the compiler maps the bare `drobek`
 * import to, and is served `immutable`; the unversioned URL revalidates
 * (ETag). This is platform code read from the operator's disk — never app
 * code.
 *
 * The error beacon (M1-07) is a separate, tiny script `/__drobek/beacon.js`
 * (the `@drobek/sdk` beacon entry): the compiler imports its versioned URL at
 * the top of every app entry, so every app reports its browser errors even
 * when it never imports `drobek`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { CORE_SDK_TYPES } from '@drobek/sdk';
import type { AnyModule } from './contract.js';

export const SDK_PATH = '/__drobek/sdk.js';
export const SDK_TYPES_PATH = '/__drobek/sdk.d.ts';
/** The browser error beacon script (M1-07). */
export const BEACON_SCRIPT_PATH = '/__drobek/beacon.js';

/** The bundled beacon script: `url` = `/__drobek/beacon.js?v=<hash>` (what the compiler imports). */
export interface BeaconScript {
  js: Buffer;
  hash: string;
  url: string;
}

export interface SdkBundle {
  js: Buffer;
  dts: string;
  hash: string;
  /** `/__drobek/sdk.js?v=<hash>` */
  url: string;
  /** The active modules it contains, in order. */
  modules: string[];
  /**
   * `drobek/<module>` → the source of that module's `sdk.inline` (read at
   * start). The compiler builds these INTO an app that imports them, with the
   * app's own import map (M1-02) — they are not part of `js`.
   */
  inline: Record<string, string>;
  /** The error beacon script every compiled app imports (M1-07). */
  beacon: BeaconScript;
}

/** The import specifier of a module's inline SDK source. */
export function inlineSpecifier(module: string): string {
  return `drobek/${module}`;
}

/** file: URL or path → absolute path. */
export function toPath(pathOrUrl: string): string {
  return pathOrUrl.startsWith('file:') ? fileURLToPath(pathOrUrl) : pathOrUrl;
}

/** The SDK core source: `@drobek/sdk` dist/core.js (src/core.ts in a source checkout). */
function sdkCoreEntry(): string {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('@drobek/sdk/package.json'));
  for (const candidate of [join(root, 'dist/core.js'), join(root, 'src/core.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('@drobek/sdk core not found (build @drobek/sdk first)');
}

/** The beacon entry: `@drobek/sdk` dist/beacon-entry.js (src/beacon-entry.ts in a source checkout). */
function sdkBeaconEntry(): string {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('@drobek/sdk/package.json'));
  for (const candidate of [join(root, 'dist/beacon-entry.js'), join(root, 'src/beacon-entry.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('@drobek/sdk beacon entry not found (build @drobek/sdk first)');
}

/** Bundle the beacon script (esbuild, in memory, minified — it loads on every app page). */
export async function buildBeaconScript(entry: string = sdkBeaconEntry()): Promise<BeaconScript> {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
  });
  const js = Buffer.from(result.outputFiles[0].contents);
  const hash = createHash('sha256').update(js).digest('hex').slice(0, 16);
  return { js, hash, url: `${BEACON_SCRIPT_PATH}?v=${hash}` };
}

/** The composed entry module esbuild bundles (exported for tests). */
export function sdkEntrySource(coreEntry: string, modules: AnyModule[]): string {
  const withSdk = modules.filter((m) => m.sdk);
  const lines = [
    '// drobek SDK — composed at server start from the SDK core + the active platform modules.',
    `import { createCore, DrobekError } from ${JSON.stringify(coreEntry)};`,
    ...withSdk.map((m, i) => `import m${i} from ${JSON.stringify(toPath(m.sdk!.entry))};`),
    'export const drobek = Object.freeze({',
    ...withSdk.map((m, i) => `  ${JSON.stringify(m.name)}: m${i}(createCore(${JSON.stringify(m.name)})),`),
    '});',
    'export { DrobekError };',
    'export default drobek;',
    '',
  ];
  return lines.join('\n');
}

function indent(text: string, pad = '  '): string {
  return text
    .trim()
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n');
}

/** One module's slice of sdk.d.ts (also what skill_info shows for it). */
export function moduleTypes(module: AnyModule): string | null {
  if (!module.sdk) return null;
  return [`export declare namespace ${module.name} {`, indent(module.sdk.types), '}'].join('\n');
}

/** The `drobek/<name>` declarations, as comment blocks after the main module (they are separate imports). */
function inlineDeclarations(modules: AnyModule[]): string[] {
  return modules
    .filter((m) => m.sdk?.inline)
    .map((m) =>
      [
        `// ── import { … } from '${inlineSpecifier(m.name)}' — compiled into the app with its own import map ──`,
        ...m.sdk!.inline!.types.trim().split('\n').map((l) => `// ${l}`.trimEnd()),
        '',
      ].join('\n')
    );
}

export function sdkDeclarations(modules: AnyModule[]): string {
  const withSdk = modules.filter((m) => m.sdk);
  return [
    "// drobek SDK types — `import { drobek } from 'drobek'`. Generated at server start;",
    '// only the platform modules active on this server are listed.',
    CORE_SDK_TYPES,
    '',
    ...withSdk.map((m) => moduleTypes(m) + '\n'),
    'export interface Drobek {',
    ...withSdk.map((m) => `  /** Use when ${m.skill.useWhen.replace(/\*\//g, '* /')} — skill_info('${m.name}') */\n  readonly ${m.name}: ${m.name}.Api;`),
    '}',
    'export declare const drobek: Drobek;',
    'export default drobek;',
    '',
    ...inlineDeclarations(withSdk),
  ].join('\n');
}

/** Bundle the SDK for `modules` (esbuild, in memory). Throws on a broken module entry. */
export async function buildSdk(
  modules: AnyModule[],
  coreEntry: string = sdkCoreEntry(),
  beaconEntry: string = sdkBeaconEntry()
): Promise<SdkBundle> {
  const inline: Record<string, string> = {};
  for (const m of modules) {
    if (m.sdk && !existsSync(toPath(m.sdk.entry))) {
      throw new Error(`module "${m.name}": sdk.entry does not exist: ${toPath(m.sdk.entry)}`);
    }
    if (m.sdk?.inline) {
      const file = toPath(m.sdk.inline.entry);
      if (!existsSync(file)) throw new Error(`module "${m.name}": sdk.inline.entry does not exist: ${file}`);
      inline[inlineSpecifier(m.name)] = readFileSync(file, 'utf8');
    }
  }
  const result = await esbuild.build({
    stdin: { contents: sdkEntrySource(coreEntry, modules), loader: 'js', resolveDir: dirname(coreEntry), sourcefile: 'drobek-sdk.js' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: false,
    legalComments: 'none',
    charset: 'utf8',
    external: ['https://*', 'http://*'],
    logLevel: 'silent',
  });
  const js = Buffer.from(result.outputFiles[0].contents);
  const hash = createHash('sha256').update(js).digest('hex').slice(0, 16);
  return {
    js,
    dts: sdkDeclarations(modules),
    hash,
    url: `${SDK_PATH}?v=${hash}`,
    modules: modules.filter((m) => m.sdk).map((m) => m.name),
    inline,
    beacon: await buildBeaconScript(beaconEntry),
  };
}
