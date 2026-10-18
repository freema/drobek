import { normalizeAppPath, SOURCE_EXTS, extOf } from './paths.js';
import type { CompileMessage } from './types.js';

export const CONFIG_FILE = 'drobek.json';
export const SDK_SPECIFIER = 'drobek';
export const SDK_URL = '/__drobek/sdk.js';
const DEFAULT_ENTRIES = ['src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js'];

export interface AppConfig {
  /** Bare specifier → `https://` module URL (esm.sh etc.). */
  imports: Record<string, string>;
  /**
   * Import aliases onto app files, tsconfig `compilerOptions.paths` style:
   * `"@/*": ["src/*"]` lets `@/lib/utils` resolve to `src/lib/utils.ts`.
   * Targets are app-relative paths (a leading `./` is dropped), tried in order.
   */
  paths: Record<string, string[]>;
  /**
   * Resolved entry points: output name (without extension) → app source path.
   * `drobek.json` itself lists `entries` as an ARRAY of paths; the output name
   * is the basename.
   */
  entries: Record<string, string>;
  /**
   * `"beacon": false` in drobek.json turns the browser error beacon off:
   * the compiler then adds no beacon import. Default true.
   */
  beacon: boolean;
  /**
   * `"feedback": false` in drobek.json keeps the feedback widget off the
   * app's preview and version hosts (the serving layer reads it with
   * feedbackWidgetEnabled). Default true.
   */
  feedback: boolean;
  /**
   * `"reload": false` in drobek.json keeps the live-reload script off the
   * app's preview host (the serving layer reads it with previewScriptOptions).
   * Default true.
   */
  reload: boolean;
  /**
   * `"browserErrors": false` in drobek.json stops the preview script from
   * reporting the page's errors (get_logs `browser`). Default true.
   */
  browserErrors: boolean;
}

function configError(text: string): CompileMessage {
  return { code: 'invalid_config', file: CONFIG_FILE, text };
}

/**
 * Read `drobek.json` (optional) and pick the entry points: `src/main.*` →
 * `main.js`/`main.css`, plus every `entries` path → `<basename>.js`.
 */
export function readAppConfig(
  files: Map<string, string>
): { config: AppConfig; errors: CompileMessage[] } {
  const errors: CompileMessage[] = [];
  const config: AppConfig = { imports: {}, paths: {}, entries: {}, beacon: true, feedback: true, reload: true, browserErrors: true };

  const raw = files.get(CONFIG_FILE);
  let parsed: { imports?: unknown; paths?: unknown; entries?: unknown; beacon?: unknown; feedback?: unknown; reload?: unknown; browserErrors?: unknown } = {};
  if (raw !== undefined) {
    try {
      const v = JSON.parse(raw) as unknown;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        errors.push(configError('drobek.json must be a JSON object'));
      } else {
        parsed = v as typeof parsed;
      }
    } catch (err) {
      errors.push(configError(`drobek.json is not valid JSON: ${(err as Error).message}`));
    }
  }

  if (parsed.imports !== undefined) {
    if (typeof parsed.imports !== 'object' || parsed.imports === null || Array.isArray(parsed.imports)) {
      errors.push(configError('"imports" must be an object of { "<package>": "https://…" }'));
    } else {
      for (const [name, url] of Object.entries(parsed.imports as Record<string, unknown>)) {
        if (typeof url !== 'string' || !/^https:\/\/[^\s]+$/.test(url)) {
          errors.push(
            configError(`imports["${name}"] must be an https:// URL, e.g. "https://esm.sh/${name}@<version>"`)
          );
          continue;
        }
        config.imports[name] = url;
      }
    }
  }

  if (parsed.paths !== undefined) readPaths(parsed.paths, config, errors);

  if (parsed.beacon !== undefined) {
    if (typeof parsed.beacon !== 'boolean') {
      errors.push(configError('"beacon" must be true or false (false turns off the browser error reports get_logs shows)'));
    } else {
      config.beacon = parsed.beacon;
    }
  }

  if (parsed.feedback !== undefined) {
    if (typeof parsed.feedback !== 'boolean') {
      errors.push(configError('"feedback" must be true or false (false keeps the feedback widget off the preview)'));
    } else {
      config.feedback = parsed.feedback;
    }
  }

  if (parsed.reload !== undefined) {
    if (typeof parsed.reload !== 'boolean') {
      errors.push(configError('"reload" must be true or false (false keeps the preview from reloading itself after a write)'));
    } else {
      config.reload = parsed.reload;
    }
  }

  if (parsed.browserErrors !== undefined) {
    if (typeof parsed.browserErrors !== 'boolean') {
      errors.push(configError('"browserErrors" must be true or false (false stops the preview from reporting its errors to get_logs kind "browser")'));
    } else {
      config.browserErrors = parsed.browserErrors;
    }
  }

  const main = DEFAULT_ENTRIES.find((p) => files.has(p));
  if (main) config.entries.main = main;

  if (parsed.entries !== undefined) {
    if (!Array.isArray(parsed.entries)) {
      errors.push(configError('"entries" must be an array of source paths, e.g. ["src/admin.tsx"]'));
    } else {
      for (const item of parsed.entries) {
        const path = typeof item === 'string' ? normalizeAppPath(item) : null;
        if (!path || !(SOURCE_EXTS as readonly string[]).includes(extOf(path))) {
          errors.push(configError(`entries: ${JSON.stringify(item)} is not a .ts/.tsx/.js/.jsx path`));
          continue;
        }
        if (!files.has(path)) {
          errors.push(configError(`entries: "${path}" does not exist`));
          continue;
        }
        const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
        if (config.entries[name] && config.entries[name] !== path) {
          errors.push(configError(`entries: output name "${name}" is used twice`));
          continue;
        }
        config.entries[name] = path;
      }
    }
  }

  return { config, errors };
}

const PATHS_EXAMPLE = '{ "@/*": ["src/*"] }';

function readPaths(raw: unknown, config: AppConfig, errors: CompileMessage[]): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push(configError(`"paths" must be an object of aliases onto app files, e.g. ${PATHS_EXAMPLE}`));
    return;
  }
  for (const [alias, value] of Object.entries(raw as Record<string, unknown>)) {
    const stars = alias.split('*').length - 1;
    if (alias === '' || alias === '*' || stars > 1 || (stars === 1 && !alias.endsWith('*')) || /^[./]/.test(alias) || /^https?:/i.test(alias) || alias === SDK_SPECIFIER || alias.startsWith(`${SDK_SPECIFIER}/`)) {
      errors.push(configError(`paths: "${alias}" is not an alias — use a prefix like "@/*" or an exact name like "~config" (not "drobek", not a relative path or URL)`));
      continue;
    }
    const targets = Array.isArray(value) ? value : [value];
    const out: string[] = [];
    for (const target of targets) {
      const shapeOk = typeof target === 'string' && target.split('*').length - 1 === stars && (stars === 0 || target.endsWith('*'));
      const norm = shapeOk ? normalizeAppPath(stars ? `${target.slice(0, -1)}x` : target) : null;
      if (!norm) {
        errors.push(configError(`paths["${alias}"]: ${JSON.stringify(target)} is not an app path${stars ? ' ending in *' : ''}, e.g. ${PATHS_EXAMPLE}`));
        continue;
      }
      out.push(stars ? `${norm.slice(0, -1)}*` : norm);
    }
    if (out.length > 0) config.paths[alias] = out;
  }
}

/**
 * The app paths an aliased specifier may stand for, in order — `null` when
 * no `paths` alias matches it. The longest matching prefix wins.
 */
export function aliasTargets(specifier: string, paths: Record<string, string[]>): string[] | null {
  if (!specifier.endsWith('*') && Object.prototype.hasOwnProperty.call(paths, specifier)) return paths[specifier];
  let best: string | null = null;
  for (const alias of Object.keys(paths)) {
    if (!alias.endsWith('*')) continue;
    const prefix = alias.slice(0, -1);
    if (specifier.length > prefix.length && specifier.startsWith(prefix) && (best === null || prefix.length > best.length)) best = prefix;
  }
  if (best === null) return null;
  const rest = specifier.slice(best.length);
  return paths[`${best}*`].map((t) => `${t.slice(0, -1)}${rest}`);
}

/**
 * Does a version with this drobek.json text show the feedback widget on its
 * preview and version hosts? Only an explicit `"feedback": false` turns it
 * off; a missing or unreadable file keeps the default.
 */
export function feedbackWidgetEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  try {
    const v = JSON.parse(raw) as unknown;
    return !(v && typeof v === 'object' && !Array.isArray(v) && (v as { feedback?: unknown }).feedback === false);
  } catch {
    return true;
  }
}

/** What the preview script does on the hosts of a version (see previewScriptOptions). */
export interface PreviewScriptOptions {
  /** The preview host reloads itself after a write that compiled (`"reload": false` turns it off). */
  reload: boolean;
  /** The preview and version hosts report the page's errors (`"browserErrors": false` turns it off). */
  browserErrors: boolean;
}

/**
 * The preview-script switches of a version with this drobek.json text: only
 * an explicit `false` turns one off; a missing or unreadable file keeps the
 * defaults.
 */
export function previewScriptOptions(raw: string | undefined): PreviewScriptOptions {
  const on: PreviewScriptOptions = { reload: true, browserErrors: true };
  if (raw === undefined) return on;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return on;
    const o = v as { reload?: unknown; browserErrors?: unknown };
    return { reload: o.reload !== false, browserErrors: o.browserErrors !== false };
  } catch {
    return on;
  }
}
