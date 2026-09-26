/**
 * create-drobek-module (NSO-349) — scaffold an external drobek platform
 * module from `template/`:
 *
 *   npm create drobek-module@latest erp            → drobek-module-erp/, module "erp"
 *   npm create drobek-module@latest @acme/drobek-module-erp
 *   npm create drobek-module@latest acme-erp       → drobek-module-acme-erp/, module "acmeerp"
 *
 * The output is a complete module (contract ^1.1): a route pair over its own
 * table (`mod_<name>_items`, migration 0000_init), the SDK slice, config with
 * an owner confirmation, a secret, a limit, an own error code, SKILL.md in
 * the five-section format, and tests — createModuleTestContext over PGlite
 * with the core migrations, and the checkSkill gate (`npm run check`).
 * examples/drobek-module-hello in the drobek repository is this output plus
 * the slot demo.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The template shipped next to dist/ (and next to src/ in the repository). */
export const TEMPLATE_DIR = fileURLToPath(new URL('../template', import.meta.url));

/** `defineModule({ name })`: also the URL segment, config key, skill name and table prefix. */
const MODULE_NAME_RE = /^[a-z][a-z0-9]{1,30}$/;
const RESERVED = ['sdk', 'v1', 'drobek', 'internal'];
/** The modules drobek ships: a new module needs its own name (replacing one is an operator decision, docs/MODULES.md). */
const BUILT_IN = ['auth', 'email', 'forms', 'data', 'proxy', 'files'];
const PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export interface ScaffoldTarget {
  /** The npm package name (`drobek-module-erp`, `@acme/drobek-module-erp`). */
  packageName: string;
  /** The module name (`erp`). */
  moduleName: string;
  /** The directory created (`drobek-module-erp`). */
  dirName: string;
  /** What the operator lists in DROBEK_MODULES: the short name when the package is `drobek-module-<name>`, else the package. */
  modulesEntry: string;
}

/** Resolve `<name>` (a short name, `drobek-module-<x>` or a scoped package) to package, module and directory names. */
export function parseTarget(input: string, moduleOverride?: string): ScaffoldTarget {
  const raw = input.trim();
  const packageName = raw.startsWith('@') || raw.startsWith('drobek-module-') ? raw : `drobek-module-${raw}`;
  if (!PACKAGE_RE.test(packageName)) throw new Error(`"${raw}" is not a valid npm package name (lower case, digits, - . _; optionally @scope/)`);
  const dirName = packageName.split('/').pop()!;
  const moduleName = moduleOverride ?? dirName.replace(/^drobek-module-/, '').replace(/[^a-z0-9]/g, '');
  if (!MODULE_NAME_RE.test(moduleName)) {
    throw new Error(`module name "${moduleName}" must match ${MODULE_NAME_RE} (lower case letters and digits, 2–31 characters) — pass --module <name>`);
  }
  if (RESERVED.includes(moduleName)) throw new Error(`module name "${moduleName}" is reserved (${RESERVED.join(', ')})`);
  if (BUILT_IN.includes(moduleName)) throw new Error(`"${moduleName}" is a built-in drobek module — pick another name (--module <name>)`);
  return { packageName, moduleName, dirName, modulesEntry: packageName === `drobek-module-${moduleName}` ? moduleName : packageName };
}

export interface ScaffoldOptions {
  /** Where the module directory is created (default: the working directory). */
  parent?: string;
  /** The @drobek/modules version the module is written against (default: this package's version — they are released together). */
  drobekVersion?: string;
  /** Write into an existing non-empty directory. */
  force?: boolean;
}

export interface ScaffoldResult {
  dir: string;
  target: ScaffoldTarget;
  /** The files written, relative to `dir`. */
  files: string[];
}

/** This package's version (= the @drobek/modules release it ships with). */
export function ownVersion(): string {
  return (JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;
}

/** Replace `{{module}}`, `{{MODULE}}`, `{{package}}`, `{{entry}}`, `{{drobekVersion}}`. */
export function renderTemplate(text: string, target: ScaffoldTarget, drobekVersion: string): string {
  const vars: Record<string, string> = {
    module: target.moduleName,
    MODULE: target.moduleName.toUpperCase(),
    package: target.packageName,
    entry: target.modulesEntry,
    drobekVersion,
  };
  return text.replace(/\{\{(\w+)\}\}/g, (all, key: string) => vars[key] ?? all);
}

function templateFiles(dir: string, base = dir): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? templateFiles(p, base) : [relative(base, p)];
    });
}

/** `_gitignore` → `.gitignore` (npm pack drops a real `.gitignore` from the template). */
const RENAMED: Record<string, string> = { _gitignore: '.gitignore' };
function outputPath(rel: string): string {
  return rel
    .split(/[\\/]/)
    .map((seg) => RENAMED[seg] ?? seg)
    .join('/');
}

export function scaffold(target: ScaffoldTarget, opts: ScaffoldOptions = {}): ScaffoldResult {
  const dir = resolve(opts.parent ?? process.cwd(), target.dirName);
  if (existsSync(dir) && readdirSync(dir).length > 0 && !opts.force) {
    throw new Error(`${dir} exists and is not empty (use --force to write into it)`);
  }
  const drobekVersion = opts.drobekVersion ?? ownVersion();
  const files: string[] = [];
  for (const rel of templateFiles(TEMPLATE_DIR)) {
    const out = outputPath(rel);
    const text = renderTemplate(readFileSync(join(TEMPLATE_DIR, rel), 'utf8'), target, drobekVersion);
    mkdirSync(dirname(join(dir, out)), { recursive: true });
    writeFileSync(join(dir, out), text);
    files.push(out);
  }
  return { dir, target, files };
}
