/**
 * PURE request/registration validation (PHY-59) — no db, no network; unit
 * tested. Covers: method allow-list, path-prefix allow-list with traversal-proof
 * normalization, and base_url validation at REGISTRATION (http(s) only + not a
 * private/reserved IP literal + no userinfo).
 */
import { ProxyError } from './errors.js';
import { isBlockedIp } from './ip-classify.js';

/** HTTP methods a proxy may be configured to allow. */
export const ALLOWED_METHOD_SET = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;

export type AllowedMethod = (typeof ALLOWED_METHOD_SET)[number];

export function isAllowedMethodName(value: string): value is AllowedMethod {
  return (ALLOWED_METHOD_SET as readonly string[]).includes(value.toUpperCase());
}

/** Normalize + validate the configured method list (upper-cased, deduped). */
export function normalizeMethods(methods: string[]): AllowedMethod[] {
  const out: AllowedMethod[] = [];
  for (const raw of methods) {
    const m = String(raw).trim().toUpperCase();
    if (!isAllowedMethodName(m)) {
      throw new ProxyError('invalid_request', `unsupported method: ${raw}`);
    }
    if (!out.includes(m as AllowedMethod)) out.push(m as AllowedMethod);
  }
  if (out.length === 0) {
    throw new ProxyError('invalid_request', 'at least one method must be allowed');
  }
  return out;
}

/** Normalize + validate configured path prefixes (each must start with '/'). */
export function normalizePrefixes(prefixes: string[]): string[] {
  const out: string[] = [];
  for (const raw of prefixes) {
    let p = String(raw).trim();
    if (p === '') continue;
    if (!p.startsWith('/')) p = `/${p}`;
    // Collapse duplicate slashes; strip a trailing slash (except the bare root).
    p = p.replace(/\/{2,}/g, '/');
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    if (p.includes('..')) {
      throw new ProxyError('invalid_request', 'path prefix may not contain ".."');
    }
    if (!out.includes(p)) out.push(p);
  }
  if (out.length === 0) {
    throw new ProxyError(
      'invalid_request',
      'at least one allowed path prefix is required'
    );
  }
  return out;
}

function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    // A malformed %-escape is suspicious → treat as traversal.
    return '..';
  }
}

/**
 * Normalize the forwarded subpath (the route `*` splat) to a leading-slash path,
 * REJECTING any traversal. A single `.` segment is dropped; a `..` segment (raw
 * OR percent-encoded) or an encoded slash inside a segment is rejected outright —
 * a legitimate API subpath never needs to climb out of its prefix.
 */
export function normalizeForwardPath(rawSplat: string): string {
  const trimmed = String(rawSplat ?? '').replace(/^\/+/, '');
  if (trimmed === '') return '/';
  const segments = trimmed.split('/');
  const keep: string[] = [];
  for (const seg of segments) {
    if (seg === '') continue; // collapse '//'
    const dec = safeDecode(seg);
    if (dec === '.') continue;
    if (dec === '..' || seg === '..' || seg.toLowerCase().includes('%2e%2e')) {
      throw new ProxyError('path_not_allowed', 'path traversal is not allowed');
    }
    if (dec.includes('/') || seg.toLowerCase().includes('%2f')) {
      throw new ProxyError('path_not_allowed', 'encoded path separators are not allowed');
    }
    keep.push(seg);
  }
  return `/${keep.join('/')}`;
}

/** Throw method_not_allowed unless `method` is in the allow-list (case-insensitive). */
export function assertMethodAllowed(method: string, allowed: string[]): void {
  const m = method.toUpperCase();
  const ok = allowed.some((a) => a.toUpperCase() === m);
  if (!ok) {
    throw new ProxyError('method_not_allowed', `method ${m} is not allowed`);
  }
}

/** True when `path` is inside `prefix` at a segment boundary (`/api` ⊄ `/apix`). */
export function pathMatchesPrefix(path: string, prefix: string): boolean {
  if (prefix === '/') return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Throw path_not_allowed unless the normalized path is under an allowed prefix. */
export function assertPathAllowed(path: string, prefixes: string[]): void {
  if (!prefixes.some((p) => pathMatchesPrefix(path, p))) {
    throw new ProxyError('path_not_allowed', `path ${path} is outside the allowed prefixes`);
  }
}

export interface ValidatedBaseUrl {
  url: URL;
  /** origin + path, no trailing slash, no query/hash — what we persist. */
  normalized: string;
}

/**
 * Validate a base_url at REGISTRATION: http(s) only, no userinfo, and the host
 * must NOT be a private/reserved IP LITERAL or `localhost`. (Hostnames that
 * resolve to a private IP are caught at forward time by the DNS-pinned SSRF
 * guard — this is the cheap literal check that also rejects the obvious cases.)
 */
export function validateBaseUrl(raw: string): ValidatedBaseUrl {
  let url: URL;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new ProxyError('invalid_request', 'base_url must be a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProxyError('invalid_request', 'base_url must be http(s)');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ProxyError('invalid_request', 'base_url must not contain credentials');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) {
    throw new ProxyError('invalid_request', 'base_url host is not allowed');
  }
  // If the host is an IP LITERAL, reject a private/reserved one outright.
  if (/^[0-9.]+$/.test(host) || host.includes(':')) {
    if (isBlockedIp(host)) {
      throw new ProxyError('invalid_request', 'base_url host resolves to a private/reserved address');
    }
  }
  // Persist origin + path only (strip query/hash/trailing slash).
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const normalized = `${url.protocol}//${url.host}${path === '/' ? '' : path}`;
  return { url, normalized };
}

/**
 * Build the concrete target URL for a forward: base_url (origin + configured base
 * path) + the normalized subpath + the caller's query string. Path segments are
 * joined without doubling or dropping slashes.
 */
export function buildTargetUrl(
  baseUrl: string,
  subpath: string,
  search: string
): URL {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const sub = subpath.startsWith('/') ? subpath : `/${subpath}`;
  const joined = `${basePath}${sub}` || '/';
  const target = new URL(joined, `${base.protocol}//${base.host}`);
  if (search && search !== '?') {
    target.search = search.startsWith('?') ? search : `?${search}`;
  }
  return target;
}
