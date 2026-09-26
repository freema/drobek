/**
 * Host-provided peers (NSO-345): a module installed in `DROBEK_MODULES_DIR`
 * brings its own `node_modules`, possibly with its own copies of
 * `@drobek/modules`, `zod` or `drizzle-orm`. Two copies of the contract mean
 * two `ModuleError` classes, two zod runtimes, two drizzle query builders —
 * so before the first such module is imported, the loader registers a
 * `node:module` resolve hook: an `import` of
 *
 *   @drobek/<anything>   zod   zod/<subpath>   drizzle-orm   drizzle-orm/<subpath>
 *
 * whose importing file lies under the modules directory resolves as if the
 * SERVER imported it — first from `@drobek/modules` itself (whose own
 * dependencies are zod, drizzle-orm and the other @drobek packages), then
 * from the server's package.json (`DROBEK_MODULES_ROOT`, default the working
 * directory). A specifier the server cannot resolve falls back to the
 * module's own copy; imports from anywhere else are untouched.
 *
 * The hook sees ESM `import` (static and dynamic) — a CommonJS `require()`
 * inside the modules directory is not redirected, so a module is an ES module.
 */
import { register } from 'node:module';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Does `specifier` name a package the host provides? */
export function isHostPeer(specifier: string): boolean {
  return (
    specifier.startsWith('@drobek/') ||
    specifier === 'zod' ||
    specifier.startsWith('zod/') ||
    specifier === 'drizzle-orm' ||
    specifier.startsWith('drizzle-orm/')
  );
}

/**
 * The hook module (runs on Node's loader thread; registered as a data: URL so
 * it works from the built package and from sources alike). `initialize` gets
 * `{ root, parents }`: the modules directory as a file URL with a trailing
 * slash and the host parent URLs to resolve from, in order. It duplicates
 * `isHostPeer` (the loader thread cannot import this file).
 */
const HOOK_SOURCE = `
let root = null;
let parents = [];
const isPeer = (s) => s.startsWith('@drobek/') || s === 'zod' || s.startsWith('zod/') || s === 'drizzle-orm' || s.startsWith('drizzle-orm/');
export function initialize(data) {
  root = data.root;
  parents = data.parents;
}
export async function resolve(specifier, context, next) {
  if (root !== null && context.parentURL && context.parentURL.startsWith(root) && isPeer(specifier)) {
    for (const parentURL of parents) {
      try {
        return await next(specifier, { ...context, parentURL });
      } catch {
        // not resolvable from this host parent: try the next one
      }
    }
  }
  return next(specifier, context);
}
`;

const registered = new Set<string>();

/**
 * Register the peer hook for `modulesDir` (once per directory per process).
 * `serverRoot` is the directory whose package.json the server's dependencies
 * belong to. Returns the directory's real path (the hook compares the
 * importing file's real path — symlinks such as macOS `/tmp` resolved).
 */
export function registerHostPeers(modulesDir: string, serverRoot: string): string {
  const real = realpathSync(modulesDir);
  if (registered.has(real)) return real;
  const root = pathToFileURL(real).href.replace(/\/?$/, '/');
  const parents = [import.meta.url, pathToFileURL(resolve(serverRoot, 'package.json')).href];
  register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`, { data: { root, parents } });
  registered.add(real);
  return real;
}
