import type { Loader, Plugin } from 'esbuild';
import { SDK_SPECIFIER, SDK_URL } from './config.js';
import { BINARY_EXTS, extOf, resolveAppSpecifier } from './paths.js';
import type { CompileErrorCode } from './types.js';

export const APP_NAMESPACE = 'app';

const LOADERS: Record<string, Loader> = {
  '.tsx': 'tsx',
  '.ts': 'ts',
  '.jsx': 'jsx',
  '.js': 'js',
  '.mjs': 'js',
  '.css': 'css',
  '.json': 'json',
  '.txt': 'text',
  '.md': 'text',
  '.html': 'text',
  '.webmanifest': 'text',
  '.svg': 'file',
};

/** Extensions tried for extension-less relative imports, then `/index.*`. */
const RESOLVE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.css', '.json'];

export interface VirtualFsState {
  /** App path → content (text as string, binary assets as Buffer). */
  files: Map<string, string | Buffer>;
  imports: Record<string, string>;
  /** What the bare `drobek` import resolves to (external). */
  sdkUrl: string;
  maxImportDepth: number;
  /** App paths handed to esbuild (a subset of `files`, asserted in tests). */
  loaded: Set<string>;
  /** Set when the compile timed out — plugin callbacks stop doing work. */
  aborted: boolean;
  /** Resolves when the compile times out — pending plugin work races it. */
  abort: Promise<void>;
  /** Test seam: awaited before every load. */
  beforeLoad?: (path: string) => Promise<void>;
}

/** esbuild message `detail`: the drobek error code (+ the specifier of an unresolved import). */
export interface FailDetail {
  code: CompileErrorCode;
  specifier?: string;
}

function fail(code: CompileErrorCode, text: string, specifier?: string) {
  const detail: FailDetail = specifier === undefined ? { code } : { code, specifier };
  return { errors: [{ text, detail }] };
}

function lookupBare(specifier: string, imports: Record<string, string>): string | null {
  if (imports[specifier]) return imports[specifier];
  // `react-dom/client` → imports["react-dom"] + "/client" (esm.sh subpaths).
  let best: string | null = null;
  for (const name of Object.keys(imports)) {
    if (specifier.startsWith(`${name}/`) && (!best || name.length > best.length)) best = name;
  }
  return best ? `${imports[best].replace(/\/+$/, '')}${specifier.slice(best.length)}` : null;
}

function findInApp(path: string, files: Map<string, string | Buffer>): string | null {
  if (files.has(path)) return path;
  for (const ext of RESOLVE_EXTS) if (files.has(path + ext)) return path + ext;
  for (const ext of RESOLVE_EXTS) if (files.has(`${path}/index${ext}`)) return `${path}/index${ext}`;
  return null;
}

/**
 * Resolves and loads ONLY from the in-memory file map — nothing ever touches
 * the server's disk or network. Bare specifiers go through `drobek.json`
 * `imports` and stay external (the browser fetches them).
 */
export function virtualFsPlugin(state: VirtualFsState): Plugin {
  const depth = new Map<string, number>();

  return {
    name: 'drobek-virtual-fs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (state.aborted) return fail('timeout', 'compile aborted');
        const spec = args.path;

        if (args.kind === 'entry-point') {
          depth.set(spec, 0);
          return { path: spec, namespace: APP_NAMESPACE };
        }
        if (/^https?:\/\//i.test(spec) || spec.startsWith('data:') || spec.startsWith('#')) {
          return { path: spec, external: true };
        }
        if (spec.startsWith('//')) {
          return fail(
            'unresolved_import',
            `"${spec}" is a scheme-less URL — write the full https:// URL or add the package to drobek.json imports.`,
            spec
          );
        }
        if (spec === SDK_SPECIFIER) return { path: state.sdkUrl || SDK_URL, external: true };

        const importer = args.namespace === APP_NAMESPACE ? args.importer : '';
        const parentDepth = depth.get(importer) ?? 0;

        if (spec.startsWith('.') || spec.startsWith('/')) {
          const target = resolveAppSpecifier(spec, importer);
          const found = target ? findInApp(target, state.files) : null;
          if (!found) {
            return fail(
              'unresolved_import',
              target
                ? `Cannot find "${spec}" in the app files (looked for ${target} with .tsx/.ts/.jsx/.js/.css/.json and /index.*).`
                : `"${spec}" points outside the app — imports may only reference the app's own files.`,
              spec
            );
          }
          const d = parentDepth + 1;
          if (d > state.maxImportDepth) {
            return fail(
              'limit_exceeded',
              `Import chain deeper than ${state.maxImportDepth} levels at "${found}".`
            );
          }
          const prev = depth.get(found);
          if (prev === undefined || d < prev) depth.set(found, d);
          return { path: found, namespace: APP_NAMESPACE };
        }

        const url = lookupBare(spec, state.imports);
        if (url) return { path: url, external: true };
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        return fail(
          'unresolved_import',
          `Unknown import "${spec}". drobek has no node_modules and no Node built-ins — add the package to drobek.json imports: { "${pkg}": "https://esm.sh/${pkg}@<version>" }`,
          spec
        );
      });

      build.onLoad({ filter: /.*/, namespace: APP_NAMESPACE }, async (args) => {
        if (state.beforeLoad) await Promise.race([state.beforeLoad(args.path), state.abort]);
        if (state.aborted) return fail('timeout', 'compile aborted');
        const content = state.files.get(args.path);
        if (content === undefined) {
          return fail('unresolved_import', `Cannot load "${args.path}".`);
        }
        state.loaded.add(args.path);
        const ext = extOf(args.path);
        const loader: Loader = BINARY_EXTS.has(ext) ? 'file' : (LOADERS[ext] ?? 'text');
        return { contents: content, loader };
      });
    },
  };
}
