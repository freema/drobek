/**
 * Path resolution + caching decisions for the app hosts (U7, PHY-58; M0-06).
 * Pure — no db, no redis, no react — so the resolution/caching contract is
 * unit-tested in isolation.
 */
import { extensionOf, hasExtension } from './content-type.js';

export type RoutingMode = 'spa' | 'exact';

/** The canonical entry document of an app. */
export const ENTRY_HTML = 'index.html';

/** An HTML document (the entry, the SPA fallback, or any other page of a multi-page app). */
function isHtmlEntry(path: string): boolean {
  const ext = extensionOf(path);
  return ext === 'html' || ext === 'htm';
}

export interface ResolveInput {
  /** The request path on the app host (may be `''` or `/` for the root). */
  requestPath: string;
  routingMode: RoutingMode;
  /** Membership test against the served version's file list. */
  has: (path: string) => boolean;
}

export type ResolveResult =
  | { kind: 'file'; path: string; isEntry: boolean }
  | { kind: 'not-found' };

/**
 * Percent-decode a raw request path segment by segment. null when a segment
 * does not decode, or decodes to a separator / NUL (`%2f`, `%5c`, `%00`) —
 * an encoded slash must never smuggle `..` past normalizeRequestPath.
 */
export function decodeRequestPath(raw: string): string | null {
  const out: string[] = [];
  for (const segment of raw.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (/[/\\\0]/.test(decoded)) return null;
    out.push(decoded);
  }
  return out.join('/');
}

/**
 * Normalize a request path into a candidate file key. Mirrors
 * `normalizeAppPath` in @drobek/compile so lookups line up with the stored
 * `version_files.path` rows: strip leading slash(es), collapse `//`, map the
 * bare / trailing-slash form to that directory's `index.html`. Any traversal
 * (`..`, `.`, empty segment) → `null` (reject, never serve).
 */
export function normalizeRequestPath(raw: string): string | null {
  let p = raw.replace(/\\/g, '/');
  p = p.replace(/^\/+/, '').replace(/\/+/g, '/');
  if (p === '') return ENTRY_HTML;
  if (p.endsWith('/')) p = `${p}${ENTRY_HTML}`;
  const segments = p.split('/');
  if (segments.some((s) => s === '..' || s === '.' || s === '')) return null;
  return p;
}

/**
 * Resolve a request to a served file:
 *  - exact manifest hit → that file (isEntry iff it is an HTML document);
 *  - SPA miss with an EXTENSIONLESS request path → the entry document (the app
 *    router owns client routes);
 *  - SPA miss with an extension (a real asset) OR any `exact`-mode miss → 404
 *    (never serve HTML in place of a missing `.js`/`.css`/image).
 *
 * The extension test is on the ORIGINAL request path, so `/dashboard` and
 * `/dashboard/` both fall back but `/logo.png` does not.
 */
export function resolveServePath(input: ResolveInput): ResolveResult {
  const norm = normalizeRequestPath(input.requestPath);
  if (norm === null) return { kind: 'not-found' };

  if (input.has(norm)) {
    return { kind: 'file', path: norm, isEntry: isHtmlEntry(norm) };
  }

  if (input.routingMode === 'spa' && !hasExtension(input.requestPath)) {
    return { kind: 'file', path: ENTRY_HTML, isEntry: true };
  }
  return { kind: 'not-found' };
}

// ── Caching decision (M0-06) ─────────────────────────────────────────────────

/**
 * Everything revalidates by default: a host serves a MOVING version (preview
 * follows every write, prod follows publish), and `/main.js` keeps its name
 * across versions — so a browser must ask again each time. The ETag is the
 * content hash, so an unchanged file costs a 304.
 */
export const REVALIDATE_CACHE = 'public, max-age=0, must-revalidate';
/** A `*.js|*.css` requested with a content-hash query (`/main.js?v=3f9a…`): cache forever. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

// `?<hash>`, `?v=<hash>`, `?h=<hash>` or `?hash=<hash>` — 8–64 url-safe chars.
// A short counter like `?v=2` is NOT a hash and still revalidates.
const HASH_QUERY_RE = /^(?:(?:v|h|hash)=)?[A-Za-z0-9_-]{8,64}$/;
const IMMUTABLE_EXTS = new Set(['js', 'mjs', 'css']);

export interface CacheInput {
  /** The served file's path. */
  path: string;
  /** The raw query string without `?` ('' when none). */
  query: string;
  /** A password-protected app: never `public` (no shared cache may keep it). */
  isPrivate: boolean;
}

/**
 * `Cache-Control` for a served file: `immutable` only for JS/CSS addressed with
 * a hash query, `must-revalidate` for everything else (HTML included). A
 * password-protected app answers `private` so a CDN never stores gated bytes.
 */
export function cacheControlFor(input: CacheInput): string {
  const immutable = IMMUTABLE_EXTS.has(extensionOf(input.path)) && HASH_QUERY_RE.test(input.query);
  const value = immutable ? IMMUTABLE_CACHE : REVALIDATE_CACHE;
  return input.isPrivate ? value.replace(/^public/, 'private') : value;
}

/** ETag is the content address itself — a strong validator. */
export function etagFor(sha256: string): string {
  return `"${sha256}"`;
}

/**
 * RFC 7232 `If-None-Match`: 304 when the presented validator list contains the
 * etag (strong or its weak form) or `*`.
 */
export function isNotModified(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const trimmed = ifNoneMatch.trim();
  if (trimmed === '*') return true;
  return trimmed
    .split(',')
    .map((t) => t.trim())
    .some((t) => t === etag || t === `W/${etag}`);
}
