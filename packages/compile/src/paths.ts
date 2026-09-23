import { posix } from 'node:path';

/** Extensions esbuild compiles/bundles from source. */
export const SOURCE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs'] as const;
/** Text files: must be valid UTF-8, scanned for secrets. */
export const TEXT_EXTS = new Set([
  ...SOURCE_EXTS,
  '.css',
  '.json',
  '.html',
  '.txt',
  '.md',
  '.svg',
  '.webmanifest',
]);
/** Binary assets: served as-is or emitted through esbuild's `file` loader. */
export const BINARY_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
]);

export function extOf(path: string): string {
  return posix.extname(path).toLowerCase();
}

export function isAllowedExt(path: string): boolean {
  const ext = extOf(path);
  return TEXT_EXTS.has(ext) || BINARY_EXTS.has(ext);
}

/**
 * Normalize an app file path: `\` → `/`, strip a leading `./` or `/`, collapse
 * repeated slashes. Returns null for empty, directory-like or traversal paths.
 */
export function normalizeAppPath(raw: string): string | null {
  const p = raw.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/');
  if (p === '' || p === '.' || p.endsWith('/')) return null;
  if (p.split('/').some((s) => s === '..' || s === '.' || s === '')) return null;
  if (/[\0-\x1f]/.test(p)) return null;
  return p;
}

/**
 * Resolve a relative (`./x`, `../x`) or root-absolute (`/x`) specifier against
 * the importing app file. Returns null when it would escape the app root.
 */
export function resolveAppSpecifier(specifier: string, importer: string): string | null {
  const joined = specifier.startsWith('/')
    ? posix.normalize(specifier.slice(1))
    : posix.normalize(posix.join(posix.dirname(importer), specifier));
  if (joined === '.' || joined.startsWith('../') || joined === '..' || posix.isAbsolute(joined)) {
    return null;
  }
  return joined;
}
