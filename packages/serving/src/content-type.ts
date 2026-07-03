/**
 * Fixed extension → Content-Type map for served app files (U7, PHY-58).
 *
 * SECURITY: the served `Content-Type` is derived from the request PATH's
 * extension, NEVER from the blob's stored `content_type` (which came in on an
 * untrusted upload and could be spoofed). Combined with
 * `X-Content-Type-Options: nosniff`, this stops an author from mislabeling a
 * blob to coax the browser into executing it as an active type. Unknown
 * extensions fall back to `application/octet-stream` — with nosniff the browser
 * will not sniff that into script/HTML.
 */

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

/**
 * Lowercase file extension (no dot) of a path, or `''` when there is none.
 * Query/hash are stripped; a leading-dot basename (e.g. `.gitignore`) counts as
 * NO extension.
 */
export function extensionOf(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] ?? '';
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** True when the path's basename carries a real file extension. */
export function hasExtension(path: string): boolean {
  return extensionOf(path) !== '';
}

/** The fixed content type for a request path (extension-driven, upload-agnostic). */
export function contentTypeForPath(path: string): string {
  const ext = extensionOf(path);
  return (ext && CONTENT_TYPES[ext]) || DEFAULT_CONTENT_TYPE;
}
