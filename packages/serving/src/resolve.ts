/**
 * Path resolution + caching decisions for the app-serving route (U7, PHY-58).
 * Pure — no db, no redis, no react — so the resolution/caching contract is
 * unit-tested in isolation.
 */
import { extensionOf, hasExtension } from './content-type.js';

export type RoutingMode = 'spa' | 'exact';

/** The canonical entry document; the deploy pipeline guarantees it exists. */
export const ENTRY_HTML = 'index.html';

/**
 * An HTML document is an "entry": it references the (immutable) hashed assets
 * and changes between deploys, so it must REVALIDATE. This covers the root
 * index.html, the SPA fallback, AND any nested index.html of a multi-page
 * static site. Everything else is treated as an immutable asset.
 */
function isHtmlEntry(path: string): boolean {
  const ext = extensionOf(path);
  return ext === 'html' || ext === 'htm';
}

export interface ResolveInput {
  /** The splat after `/:ws/app/:slug/` (may be `''` for the bare app root). */
  requestPath: string;
  routingMode: RoutingMode;
  /** Membership test against the active deploy's file manifest. */
  has: (path: string) => boolean;
}

export type ResolveResult =
  | { kind: 'file'; path: string; isEntry: boolean }
  | { kind: 'not-found' };

/**
 * Normalize a request splat into a candidate manifest key. Mirrors
 * `normalizeManifestPath` in @drobek/deploy so lookups line up with the stored
 * `deploy_files.path` rows: strip leading slash(es), collapse `//`, map the
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

// ── Caching decision ─────────────────────────────────────────────────────────

/** Fingerprinted / non-entry assets: cache hard for a year, never revalidate. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
/** The entry document: always revalidate (ETag = content hash → cheap 304). */
export const REVALIDATE_CACHE = 'no-cache';

export interface CacheDecision {
  cacheControl: string;
  immutable: boolean;
}

/**
 * Entry HTML (index.html, incl. the SPA fallback) MUST revalidate so a new
 * deploy is picked up immediately; every other file is treated as
 * content-addressed/immutable. Even a non-fingerprinted asset is safe: the
 * entry document that references it always revalidates, and its ETag (the
 * content hash) forces correctness.
 */
export function cacheControlFor(isEntry: boolean): CacheDecision {
  return isEntry
    ? { cacheControl: REVALIDATE_CACHE, immutable: false }
    : { cacheControl: IMMUTABLE_CACHE, immutable: true };
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
