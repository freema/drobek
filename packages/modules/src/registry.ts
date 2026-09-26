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
 * A short name must load a module of that name (`auth` → a module named
 * `auth`); a full package name may export any name — that is how an operator
 * replaces a built-in module (`@acme/drobek-module-auth`).
 *
 * Anything off — unknown package, not a module, invalid name/schema/defaults,
 * a `contract` range this server does not satisfy, two modules with one name,
 * a missing sdk.entry, a module whose `requires` is not active, a clashing
 * limit or error code, a contribution to an unknown slot or one that fails
 * the slot's schema, an invalid `DROBEK_MODULE_<NAME>_DEFAULTS` — stops the
 * server at start with a message that names the module. Nothing is skipped
 * silently.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { createConsoleLogger, type Logger } from '@drobek/core';
import {
  MODULE_CONTRACT_VERSION,
  MODULE_ERROR_CODE_RE,
  MODULE_NAME_RE,
  SLOT_NAME_RE,
  isDefinedModule,
  type AnyModule,
} from './contract.js';
import { CORE_ERROR_CODES, issuePaths } from './errors.js';
import { CORE_LIMITS } from './limits.js';
import { mergePatch } from './merge-patch.js';
import { SECRET_NAME_RE } from './secrets.server.js';
import { toPath } from './sdk-build.js';

/** Names a module may not take (they are path segments of `/__drobek/…`). */
export const RESERVED_MODULE_NAMES = new Set(['sdk', 'v1', 'drobek', 'internal']);

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const CORE_CODES = new Set(CORE_ERROR_CODES);
const AVAILABILITY = new Set<string>(['default', 'opt-in']);
const DASHBOARD_EDITORS = new Set<string>(['collections', 'upstreams']);
const HOOKS = ['onAppCreate', 'onPublish', 'onAppDelete'] as const;
const DEFAULTS_ENV_RE = /^DROBEK_MODULE_([A-Z0-9]+)_DEFAULTS$/;

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
  /** Start-up warnings (a module without `contract`, an unused DROBEK_MODULE_<NAME>_DEFAULTS). */
  log?: Logger;
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
  if (m.contract !== undefined) {
    if (typeof m.contract !== 'string' || semver.validRange(m.contract) === null) {
      fail(`contract must be a semver range of module contract versions (e.g. '^1.1'), got ${JSON.stringify(m.contract)}`);
    }
    if (!semver.satisfies(MODULE_CONTRACT_VERSION, m.contract)) {
      fail(
        `it needs module contract ${m.contract}, but this server implements ${MODULE_CONTRACT_VERSION} — install a version of the module built for this drobek, or upgrade drobek`
      );
    }
  }
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
    if (CORE_LIMITS.some((c) => c.env === l.env)) fail(`limit "${l.env}" is a core limit — pick another name`);
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
    for (const fn of ['update', 'importCsv', 'dropCollection'] as const) {
      if (m.records?.[fn] !== undefined && typeof m.records[fn] !== 'function') fail(`records.${fn} must be a function`);
    }
  }
  if (m.endUsers !== undefined) {
    for (const fn of ['list', 'setRole', 'setDisabled'] as const) {
      if (m.endUsers?.[fn] !== undefined && typeof m.endUsers[fn] !== 'function') fail(`endUsers.${fn} must be a function`);
    }
  }
  if (m.submissions !== undefined) {
    for (const fn of ['forms', 'list', 'csv', 'remove'] as const) {
      if (typeof m.submissions?.[fn] !== 'function') fail(`submissions.${fn} must be a function`);
    }
  }
  if (m.files !== undefined) {
    for (const fn of ['list', 'open', 'remove'] as const) {
      if (typeof m.files?.[fn] !== 'function') fail(`files.${fn} must be a function`);
    }
  }
  if (m.requires !== undefined) {
    if (!Array.isArray(m.requires) || m.requires.some((r) => typeof r !== 'string' || !MODULE_NAME_RE.test(r) || r === m.name)) {
      fail('requires must list the names of OTHER modules');
    }
  }
  if (m.hooks !== undefined) {
    for (const h of HOOKS) {
      if (m.hooks?.[h] !== undefined && typeof m.hooks[h] !== 'function') fail(`hooks.${h} must be a function`);
    }
  }
  if (m.errors !== undefined) {
    if (!Array.isArray(m.errors)) fail('errors must be an array of { code, meaning, fix }');
    const seen = new Set<string>();
    for (const e of m.errors ?? []) {
      const code = String(e?.code);
      if (typeof e?.code !== 'string' || !MODULE_ERROR_CODE_RE.test(e.code)) fail(`error code ${JSON.stringify(e?.code)} must match ${MODULE_ERROR_CODE_RE}`);
      if (typeof e.meaning !== 'string' || !e.meaning.trim()) fail(`error "${code}" needs a meaning`);
      if (typeof e.fix !== 'string' || !e.fix.trim()) fail(`error "${code}" needs a fix`);
      if (CORE_CODES.has(code)) fail(`error code "${code}" is a core code — answer it without declaring it, or pick another name`);
      if (seen.has(code)) fail(`error code "${code}" is declared twice`);
      seen.add(code);
    }
  }
  if (m.slots !== undefined) {
    if (!isPlainObject(m.slots)) fail('slots must be an object: slot name → { schema, unique?, description }');
    for (const [name, slot] of Object.entries(m.slots ?? {})) {
      if (!SLOT_NAME_RE.test(name)) fail(`slot "${name}" must be named <module>.<name> (${SLOT_NAME_RE})`);
      if (name.slice(0, name.indexOf('.')) !== m.name) fail(`slot "${name}" must start with the module's own name ("${m.name}.")`);
      if (typeof (slot?.schema as { safeParse?: unknown } | undefined)?.safeParse !== 'function') fail(`slot "${name}": schema must be a zod schema`);
      if (slot.unique !== undefined && (typeof slot.unique !== 'string' || !slot.unique)) fail(`slot "${name}": unique must name a key of the contribution`);
      if (typeof slot.description !== 'string' || !slot.description.trim()) fail(`slot "${name}" needs a description`);
    }
  }
  if (m.contributes !== undefined) {
    if (!isPlainObject(m.contributes)) fail('contributes must be an object: slot name → contribution');
    for (const name of Object.keys(m.contributes ?? {})) {
      if (!SLOT_NAME_RE.test(name)) fail(`contributes names "${name}", which is not a slot name (<module>.<name>)`);
    }
  }
  if (m.availability !== undefined && !AVAILABILITY.has(m.availability)) fail(`availability must be 'default' or 'opt-in'`);
  if (m.dashboard !== undefined) {
    if (!isPlainObject(m.dashboard)) fail('dashboard must be an object');
    const editor: unknown = (m.dashboard as { editor?: unknown }).editor;
    if (editor !== undefined && !DASHBOARD_EDITORS.has(String(editor))) fail(`dashboard.editor must be one of ${[...DASHBOARD_EDITORS].join(', ')}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One module's contribution to a slot, as the slot's schema parsed it. */
export interface SlotContribution {
  /** The contributing module. */
  module: string;
  value: unknown;
}

/**
 * Every `contributes` of the active modules, checked against the slots they
 * target and grouped by slot (each list in module order; every declared slot
 * present, [] without contributions). Refuses the start on a contribution to
 * a slot no active module declares, one that fails the slot's schema, and two
 * contributions with the same value of the slot's `unique` key.
 */
export function collectContributions(modules: AnyModule[]): Map<string, SlotContribution[]> {
  const hosts = new Map<string, AnyModule>();
  const out = new Map<string, SlotContribution[]>();
  for (const m of modules) {
    for (const name of Object.keys(m.slots ?? {})) {
      hosts.set(name, m);
      out.set(name, []);
    }
  }
  const uniques = new Map<string, Map<string, string>>();
  for (const c of modules) {
    for (const [name, value] of Object.entries(c.contributes ?? {})) {
      const host = hosts.get(name);
      if (!host) {
        const owner = name.slice(0, name.indexOf('.'));
        const why = modules.some((m) => m.name === owner)
          ? `the module "${owner}" declares no such slot`
          : `the module "${owner}" is not in DROBEK_MODULES`;
        throw new ModuleLoadError(`module "${c.name}" contributes to the slot "${name}", but ${why}`);
      }
      const slot = host.slots![name];
      const r = slot.schema.safeParse(value);
      if (!r.success) {
        const issues = issuePaths(r.error.issues).map((i) => `${i.path}: ${i.message}`).join('; ');
        throw new ModuleLoadError(
          `module "${c.name}": its contribution to the slot "${name}" (module "${host.name}") does not pass the slot's schema — ${issues}`
        );
      }
      if (slot.unique !== undefined) {
        const key = (r.data as Record<string, unknown> | null)?.[slot.unique];
        if (key === undefined || key === null) {
          throw new ModuleLoadError(`module "${c.name}": its contribution to the slot "${name}" has no "${slot.unique}" (the slot's unique key)`);
        }
        const seen = uniques.get(name) ?? new Map<string, string>();
        uniques.set(name, seen);
        const k = JSON.stringify(key);
        const other = seen.get(k);
        if (other !== undefined) {
          throw new ModuleLoadError(
            `modules "${other}" and "${c.name}" both contribute ${slot.unique} ${k} to the slot "${name}" — ${slot.unique} must be unique within the slot`
          );
        }
        seen.set(k, c.name);
      }
      out.get(name)!.push({ module: c.name, value: r.data });
    }
  }
  return out;
}

/** An error code may be declared by one active module only (a clash refuses the start). */
export function checkErrorCodes(modules: AnyModule[]): void {
  const owners = new Map<string, string>();
  for (const m of modules) {
    for (const e of m.errors ?? []) {
      const owner = owners.get(e.code);
      if (owner !== undefined && owner !== m.name) {
        throw new ModuleLoadError(`error code "${e.code}" is declared by both "${owner}" and "${m.name}"`);
      }
      owners.set(e.code, m.name);
    }
  }
}

/** The env var that overrides a module's config defaults: `DROBEK_MODULE_<NAME>_DEFAULTS`. */
export function moduleDefaultsEnvName(name: string): string {
  return `DROBEK_MODULE_${name.toUpperCase()}_DEFAULTS`;
}

/**
 * The config defaults of `m` on this server: its `configDefaults` with the
 * operator's `DROBEK_MODULE_<NAME>_DEFAULTS` (a JSON merge patch) applied —
 * validated by the module's configSchema (else ModuleLoadError with the issue
 * paths).
 */
export function effectiveConfigDefaults(m: AnyModule, env: NodeJS.ProcessEnv = process.env): unknown {
  const key = moduleDefaultsEnvName(m.name);
  const raw = env[key]?.trim();
  if (!raw) return m.configDefaults;
  let patch: unknown;
  try {
    patch = JSON.parse(raw);
  } catch (err) {
    throw new ModuleLoadError(`${key} is not valid JSON (${(err as Error).message})`);
  }
  if (!isPlainObject(patch)) {
    throw new ModuleLoadError(`${key} must be a JSON object: a merge patch over the defaults of the module "${m.name}"`);
  }
  const merged = mergePatch(m.configDefaults, patch);
  const r = m.configSchema.safeParse(merged);
  if (!r.success) {
    const issues = issuePaths(r.error.issues).map((i) => `${i.path}: ${i.message}`).join('; ');
    throw new ModuleLoadError(`${key}: the defaults of the module "${m.name}" do not pass its configSchema — ${issues}`);
  }
  return merged;
}

/**
 * Every rule ACROSS the active modules (one owner per authority, `requires`,
 * limit names, error codes, slots and contributions) plus the operator's
 * config-defaults overrides. Returns the modules with their effective
 * `configDefaults` (a module without an override is returned as is), in the
 * same order. Throws ModuleLoadError.
 */
export function checkModuleSet(modules: AnyModule[], env: NodeJS.ProcessEnv = process.env, log?: Logger): AnyModule[] {
  endUserAuthorityOf(modules);
  mailAuthorityOf(modules);
  recordsAuthorityOf(modules);
  submissionsAuthorityOf(modules);
  filesAuthorityOf(modules);
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
  checkErrorCodes(modules);
  collectContributions(modules);
  const active = new Set(modules.map((m) => m.name.toUpperCase()));
  for (const key of Object.keys(env)) {
    const hit = DEFAULTS_ENV_RE.exec(key);
    if (hit && !active.has(hit[1]) && env[key]?.trim()) {
      log?.warn(`${key} is set, but no active module is named "${hit[1].toLowerCase()}" — it is ignored`, { env: key });
    }
  }
  return modules.map((m) => {
    const defaults = effectiveConfigDefaults(m, env);
    return defaults === m.configDefaults ? m : (Object.freeze({ ...m, configDefaults: defaults }) as AnyModule);
  });
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

/** The one active module that stores form submissions (`submissions`), or null (two refuse the start). */
export function submissionsAuthorityOf(modules: AnyModule[]): AnyModule | null {
  const owners = modules.filter((m) => m.submissions !== undefined);
  if (owners.length > 1) {
    throw new ModuleLoadError(`only one module may store form submissions (submissions); active: ${owners.map((m) => m.name).join(', ')}`);
  }
  return owners[0] ?? null;
}

/** The one active module that stores end-user uploads (`files`), or null (two refuse the start). */
export function filesAuthorityOf(modules: AnyModule[]): AnyModule | null {
  const owners = modules.filter((m) => m.files !== undefined);
  if (owners.length > 1) {
    throw new ModuleLoadError(`only one module may store uploads (files); active: ${owners.map((m) => m.name).join(', ')}`);
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

/**
 * Resolve + validate every DROBEK_MODULES entry (no duplicates, a short name
 * loads a module of that name), then check the set (`checkModuleSet`).
 * Returns the modules in DROBEK_MODULES order, with their effective config
 * defaults.
 */
export async function loadModules(env: NodeJS.ProcessEnv = process.env, opts: ResolveOptions = {}): Promise<AnyModule[]> {
  const log = opts.log ?? createConsoleLogger('modules');
  const modules: AnyModule[] = [];
  for (const entry of parseModuleList(env.DROBEK_MODULES)) {
    const m = await resolveModule(entry, opts);
    validateModule(m);
    if (packageNameFor(entry) !== entry && m.name !== entry) {
      throw new ModuleLoadError(
        `DROBEK_MODULES names "${entry}", but the package "${packageNameFor(entry)}" exports the module "${m.name}" — a short name must match the module's name (list a replacement module by its full package name)`
      );
    }
    if (modules.some((x) => x.name === m.name)) {
      throw new ModuleLoadError(`two entries of DROBEK_MODULES load a module named "${m.name}"`);
    }
    if (m.contract === undefined) {
      const range = `^${semver.major(MODULE_CONTRACT_VERSION)}.${semver.minor(MODULE_CONTRACT_VERSION)}`;
      log.warn(`module "${m.name}" declares no contract range — add contract: '${range}' to its defineModule()`, {
        module: m.name,
        contract: MODULE_CONTRACT_VERSION,
      });
    }
    modules.push(m);
  }
  return checkModuleSet(modules, env, log);
}
