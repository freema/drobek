/**
 * What a version SERVES (M0-06). Pure. A version holds `source` files (what
 * the agent wrote) and `built` files (esbuild's output: `main.js`, `main.css`,
 * extra entries, bundled assets). The served manifest is:
 *   - every built file;
 *   - every source file NOT shadowed by a built file on the same path
 *     (built wins — `main.js` is always the compiled one);
 *   - minus sources the browser must never get: TypeScript/JSX sources
 *     (`*.ts`, `*.tsx`, `*.jsx`, `*.mts`, `*.cts`) — they are compiler input,
 *     not assets, and would only leak code the build already tree-shook — and
 *     `drobek.json` (build config: the import map and entries; nothing in the
 *     browser needs it, so it is kept off the surface).
 */
import { extensionOf } from './content-type.js';

export interface ServedFile {
  sha256: string;
  size: number;
}

export type ServedManifest = Map<string, ServedFile>;

export interface StoredFile {
  path: string;
  sha256: string;
  size: number;
  kind: 'source' | 'built';
}

const NEVER_SERVED_EXTS = new Set(['ts', 'tsx', 'jsx', 'mts', 'cts']);
const NEVER_SERVED_PATHS = new Set(['drobek.json']);

/** Is this SOURCE path withheld from the browser? */
export function isUnservedSource(path: string): boolean {
  return NEVER_SERVED_PATHS.has(path) || NEVER_SERVED_EXTS.has(extensionOf(path));
}

export function servedManifest(files: Iterable<StoredFile>): ServedManifest {
  const out: ServedManifest = new Map();
  const sources: StoredFile[] = [];
  for (const f of files) {
    if (f.kind === 'built') out.set(f.path, { sha256: f.sha256, size: f.size });
    else sources.push(f);
  }
  for (const f of sources) {
    if (out.has(f.path) || isUnservedSource(f.path)) continue;
    out.set(f.path, { sha256: f.sha256, size: f.size });
  }
  return out;
}
