/**
 * Loading the active modules (M1-01): `DROBEK_MODULES` is a comma-separated
 * list the operator sets. Each entry resolves to a package, in this order:
 *
 *   1. a BUILT-IN module of this repo (`modules/<name>`, the BUILTIN_MODULES
 *      table below);
 *   2. a short name `x` → the npm package `drobek-module-x`;
 *   3. a full package name (`drobek-module-x`, `@scope/pkg`, anything with a
 *      `/`) → exactly that package.
 *
 * Third-party packages resolve from the SERVER's install (`<cwd>/package.json`
 * — `/app` in the image, `apps/server` in the dev stack; override with
 * `DROBEK_MODULES_ROOT`), so an operator adds one with a plain dependency of
 * the server. The package's default export (or its `module` export) must come
 * from `defineModule()`.
 *
 * Anything off — unknown package, not a module, invalid name/schema/defaults,
 * two modules with one name, a missing sdk.entry — stops the server at start
 * with a message that names the module. Nothing is skipped silently.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODULE_NAME_RE, isDefinedModule, type AnyModule } from './contract.js';
import { SECRET_NAME_RE } from './secrets.server.js';
import { toPath } from './sdk-build.js';

/** Built-in modules shipped in this repo (`modules/<name>`), by name. */
export const BUILTIN_MODULES: Readonly<Record<string, () => Promise<unknown>>> = {};

/** Names a module may not take (they are path segments of `/__drobek/…`). */
export const RESERVED_MODULE_NAMES = new Set(['sdk', 'v1', 'drobek', 'internal']);

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export class ModuleLoadError extends Error {
  constructor(message: string) {
    super(`drobek refuses to start: ${message}`);
    this.name = 'ModuleLoadError';
  }
}

/** `DROBEK_MODULES` → trimmed, de-duplicated entries (order kept). */
export function parseModuleList(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const name = part.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The package an entry of DROBEK_MODULES refers to (rules 2 + 3 above). */
export function packageNameFor(entry: string): string {
  if (entry.startsWith('@') || entry.includes('/') || entry.startsWith('drobek-module-')) return entry;
  return `drobek-module-${entry}`;
}

export interface ResolveOptions {
  /** Directory whose package.json the third-party modules are dependencies of. */
  root?: string;
  /** Test seam: import by specifier. */
  importer?: (specifier: string) => Promise<unknown>;
}

function exportedModule(ns: unknown): unknown {
  if (isDefinedModule(ns)) return ns;
  const o = ns as Record<string, unknown> | null;
  if (o && isDefinedModule(o.default)) return o.default;
  if (o && isDefinedModule(o.module)) return o.module;
  // A CJS/ESM interop double default.
  const d = o?.default as Record<string, unknown> | undefined;
  if (d && isDefinedModule(d.default)) return d.default;
  return null;
}

/** Import one DROBEK_MODULES entry → its module (throws ModuleLoadError). */
export async function resolveModule(entry: string, opts: ResolveOptions = {}): Promise<AnyModule> {
  let ns: unknown;
  if (BUILTIN_MODULES[entry]) {
    ns = await BUILTIN_MODULES[entry]();
  } else {
    const pkg = packageNameFor(entry);
    try {
      if (opts.importer) {
        ns = await opts.importer(pkg);
      } else {
        const root = resolve(opts.root ?? process.env.DROBEK_MODULES_ROOT ?? process.cwd());
        const manifest = resolve(root, 'package.json');
        let url: string | null = null;
        if (existsSync(manifest)) {
          try {
            url = pathToFileURL(createRequire(manifest).resolve(pkg)).href;
          } catch {
            url = null;
          }
        }
        ns = await import(/* @vite-ignore */ url ?? pkg);
      }
    } catch (err) {
      throw new ModuleLoadError(
        `DROBEK_MODULES names "${entry}", but the package "${pkg}" cannot be loaded (${String((err as Error)?.message ?? err).split('\n')[0]}). Install it as a dependency of the server or remove it from DROBEK_MODULES.`
      );
    }
  }
  const mod = exportedModule(ns);
  if (!mod) {
    throw new ModuleLoadError(`"${entry}" does not export a drobek module (default export from defineModule()).`);
  }
  return mod as AnyModule;
}

/** Every structural rule of the contract (throws ModuleLoadError naming the module). */
export function validateModule(m: AnyModule): void {
  const who = `module "${String(m?.name)}"`;
  const fail = (msg: string): never => {
    throw new ModuleLoadError(`${who}: ${msg}`);
  };
  if (typeof m.name !== 'string' || !MODULE_NAME_RE.test(m.name)) {
    fail(`name must match ${MODULE_NAME_RE} (lowercase letters and digits)`);
  }
  if (RESERVED_MODULE_NAMES.has(m.name)) fail('this name is reserved');
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) fail('version must be semver (e.g. 1.0.0)');
  if (!m.skill || typeof m.skill.useWhen !== 'string' || !m.skill.useWhen.trim()) fail('skill.useWhen is required');
  if (typeof m.skill.markdown !== 'string' || !m.skill.markdown.trim()) fail('skill.markdown is required');
  if (!m.configSchema || typeof (m.configSchema as { safeParse?: unknown }).safeParse !== 'function') {
    fail('configSchema must be a zod schema');
  }
  const defaults = m.configSchema.safeParse(m.configDefaults);
  if (!defaults.success) fail(`configDefaults do not pass configSchema: ${defaults.error.issues[0]?.message ?? ''}`);
  for (const s of m.secrets ?? []) {
    if (!SECRET_NAME_RE.test(s.name)) fail(`secret name "${s.name}" must be UPPER_SNAKE`);
  }
  for (const l of m.limits ?? []) {
    if (!ENV_NAME_RE.test(l.env)) fail(`limit "${l.env}" must be an UPPER_SNAKE env name`);
    if (!Number.isInteger(l.default) || l.default <= 0) fail(`limit "${l.env}" needs a positive integer default`);
  }
  if (m.sdk) {
    if (typeof m.sdk.entry !== 'string' || !existsSync(toPath(m.sdk.entry))) fail(`sdk.entry does not exist: ${m.sdk.entry}`);
    if (typeof m.sdk.types !== 'string' || !/\binterface\s+Api\b/.test(m.sdk.types)) {
      fail('sdk.types must declare `interface Api`');
    }
  }
  if (m.migrations && !existsSync(toPath(m.migrations.folder))) fail(`migrations.folder does not exist: ${m.migrations.folder}`);
  if (m.routes !== undefined && typeof m.routes !== 'function') fail('routes must be a function');
}

/** Resolve + validate every DROBEK_MODULES entry; no duplicates. */
export async function loadModules(env: NodeJS.ProcessEnv = process.env, opts: ResolveOptions = {}): Promise<AnyModule[]> {
  const modules: AnyModule[] = [];
  for (const entry of parseModuleList(env.DROBEK_MODULES)) {
    const m = await resolveModule(entry, opts);
    validateModule(m);
    if (modules.some((x) => x.name === m.name)) {
      throw new ModuleLoadError(`two entries of DROBEK_MODULES load a module named "${m.name}"`);
    }
    modules.push(m);
  }
  const limitNames = new Map<string, string>();
  for (const m of modules) {
    for (const l of m.limits ?? []) {
      const owner = limitNames.get(l.env);
      if (owner && owner !== m.name) {
        throw new ModuleLoadError(`limit "${l.env}" is declared by both "${owner}" and "${m.name}"`);
      }
      limitNames.set(l.env, m.name);
    }
  }
  return modules;
}
