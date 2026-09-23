/**
 * Loading the active modules (M1-01): `DROBEK_MODULES` is a comma-separated
 * list the operator sets. Each entry resolves to a package:
 *
 *   - a short name `x` → the npm package `drobek-module-x`;
 *   - a full package name (`drobek-module-x`, `@scope/pkg`, anything with a
 *     `/`) → exactly that package.
 *
 * Packages resolve from the SERVER's install (`<cwd>/package.json` — `/app`
 * in the image, `apps/server` in the dev stack; override with
 * `DROBEK_MODULES_ROOT`), so an operator adds one with a plain dependency of
 * the server. The BUILT-IN modules of this repo (`modules/<name>`, e.g.
 * `modules/auth` = `drobek-module-auth`) are workspace packages the server
 * depends on, so they resolve exactly like a third-party module. The
 * package's default export (or its `module` export) must come from
 * `defineModule()`.
 *
 * Anything off — unknown package, not a module, invalid name/schema/defaults,
 * two modules with one name, a missing sdk.entry, a module whose `requires`
 * is not active — stops the server at start with a message that names the
 * module. Nothing is skipped silently.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODULE_NAME_RE, isDefinedModule, type AnyModule } from './contract.js';
import { SECRET_NAME_RE } from './secrets.server.js';
import { toPath } from './sdk-build.js';

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
    if (m.sdk.inline !== undefined) {
      const { entry, types } = m.sdk.inline;
      if (typeof entry !== 'string' || !/\.(tsx?|jsx?|mjs)$/.test(toPath(entry)) || !existsSync(toPath(entry))) {
        fail(`sdk.inline.entry must be an existing .ts/.tsx/.js/.jsx file: ${String(entry)}`);
      }
      if (typeof types !== 'string' || !types.trim()) fail('sdk.inline.types is required');
    }
  }
  if (m.migrations && !existsSync(toPath(m.migrations.folder))) fail(`migrations.folder does not exist: ${m.migrations.folder}`);
  if (m.routes !== undefined && typeof m.routes !== 'function') fail('routes must be a function');
  if (m.endUsers !== undefined && typeof m.endUsers?.current !== 'function') fail('endUsers.current must be a function');
  if (m.mail !== undefined && typeof m.mail?.prepare !== 'function') fail('mail.prepare must be a function');
  if (m.records !== undefined) {
    for (const fn of ['collections', 'query', 'get', 'remove', 'csv'] as const) {
      if (typeof m.records?.[fn] !== 'function') fail(`records.${fn} must be a function`);
    }
  }
  if (m.requires !== undefined) {
    if (!Array.isArray(m.requires) || m.requires.some((r) => typeof r !== 'string' || !MODULE_NAME_RE.test(r) || r === m.name)) {
      fail('requires must list the names of OTHER modules');
    }
  }
}

/**
 * The one active module that owns app e-mail (`mail`), or null. Two would
 * apply two policies to one message: refused at start.
 */
export function mailAuthorityOf(modules: AnyModule[]): AnyModule | null {
  const owners = modules.filter((m) => m.mail !== undefined);
  if (owners.length > 1) {
    throw new ModuleLoadError(`only one module may own app e-mail (mail); active: ${owners.map((m) => m.name).join(', ')}`);
  }
  return owners[0] ?? null;
}

/**
 * The one active module that stores the app's records (`records`), or null.
 * query_data and the dashboard's data browser must read ONE store: two are
 * refused at start.
 */
export function recordsAuthorityOf(modules: AnyModule[]): AnyModule | null {
  const owners = modules.filter((m) => m.records !== undefined);
  if (owners.length > 1) {
    throw new ModuleLoadError(`only one module may store app records (records); active: ${owners.map((m) => m.name).join(', ')}`);
  }
  return owners[0] ?? null;
}

/** Every module's `requires` must be active too (a clear start error names what to add). */
export function checkRequires(modules: AnyModule[]): void {
  const active = new Set(modules.map((m) => m.name));
  for (const m of modules) {
    const missing = (m.requires ?? []).filter((r) => !active.has(r));
    if (missing.length > 0) {
      throw new ModuleLoadError(
        `module "${m.name}" requires the module${missing.length > 1 ? 's' : ''} ${missing.map((x) => `"${x}"`).join(', ')}: add ${missing.length > 1 ? 'them' : 'it'} to DROBEK_MODULES (e.g. DROBEK_MODULES=${[...active, ...missing].join(',')})`
      );
    }
  }
}

/**
 * The one active module that owns end-user sessions (`endUsers`), or null.
 * Two owners would disagree about who is signed in: refused at start.
 */
export function endUserAuthorityOf(modules: AnyModule[]): AnyModule | null {
  const owners = modules.filter((m) => m.endUsers !== undefined);
  if (owners.length > 1) {
    throw new ModuleLoadError(
      `only one module may own end-user sessions (endUsers); active: ${owners.map((m) => m.name).join(', ')}`
    );
  }
  return owners[0] ?? null;
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
  endUserAuthorityOf(modules);
  mailAuthorityOf(modules);
  recordsAuthorityOf(modules);
  checkRequires(modules);
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
