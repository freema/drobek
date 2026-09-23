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
   * Resolved entry points: output name (without extension) → app source path.
   * `drobek.json` itself lists `entries` as an ARRAY of paths; the output name
   * is the basename.
   */
  entries: Record<string, string>;
  /**
   * `"beacon": false` in drobek.json turns the browser error beacon off
   * (M1-07): the compiler then adds no beacon import. Default true.
   */
  beacon: boolean;
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
  const config: AppConfig = { imports: {}, entries: {}, beacon: true };

  const raw = files.get(CONFIG_FILE);
  let parsed: { imports?: unknown; entries?: unknown; beacon?: unknown } = {};
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

  if (parsed.beacon !== undefined) {
    if (typeof parsed.beacon !== 'boolean') {
      errors.push(configError('"beacon" must be true or false (false turns off the browser error reports get_logs shows)'));
    } else {
      config.beacon = parsed.beacon;
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
