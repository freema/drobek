/**
 * Client ID Metadata Documents (M0-04, NSO-282) — the MCP authorization spec's
 * preferred client identification: the `client_id` IS an https URL, and the
 * document served there describes the client. No registration round-trip, no
 * stored client secret; the client is always public (PKCE).
 *
 * Fetch contract (the ONE place the server fetches an agent-chosen URL):
 *   - https only, default port, canonical URL with a path, no credentials,
 *     no fragment;
 *   - through the @drobek/proxy SSRF guard (resolve once, reject private /
 *     reserved IPs, pin the connection to the checked IP, never follow a
 *     redirect) with an EMPTY host allow-list — the proxy's
 *     PROXY_ALLOWED_HOSTS never applies here;
 *   - 64 KiB cap enforced while streaming, 5 s wall clock for the whole fetch;
 *   - the validated result is cached in Redis for 1 h (a rejection for 60 s).
 *
 * The document must name itself (`client_id` === the URL, exactly) and its
 * redirect_uris must pass the same policy as DCR (redirect-uri.ts).
 *
 * DEV/TEST ONLY: `OAUTH_CIMD_DEV_ORIGINS` lists exact origins (scheme + host +
 * port, e.g. `http://proxy-echo:8099`) that may serve a document over http
 * and from a private address — the e2e mock. It is ignored when
 * NODE_ENV=production and never widens any other origin.
 */
import { createHash } from 'node:crypto';
import { getRedis } from '@drobek/core';
import { ProxyError, ssrfSafeForward } from '@drobek/proxy';
import {
  CIMD_CACHE_TTL_SEC,
  CIMD_FAILURE_TTL_SEC,
  CIMD_MAX_BYTES,
  CIMD_TIMEOUT_MS,
} from './constants.js';
import { checkClientMetadata } from './redirect-uri.js';

/** A client_id that is a URL is a CIMD client_id (DCR ids are plain hex). */
export function isUrlClientId(clientId: string): boolean {
  return /^https?:\/\//i.test(clientId);
}

/** The exact dev/test origins allowed to serve CIMD over http from a private IP. */
export function cimdDevOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  if (env.NODE_ENV === 'production') return new Set();
  const out = new Set<string>();
  for (const entry of (env.OAUTH_CIMD_DEV_ORIGINS ?? '').split(/[,\s]+/)) {
    if (!entry) continue;
    try {
      const origin = new URL(entry).origin;
      // Exact origins only — a path, trailing slash or wildcard is ignored.
      if (origin !== 'null' && origin === entry) out.add(origin);
    } catch {
      /* not a URL → ignored */
    }
  }
  return out;
}

export type CimdUrlCheck =
  | { ok: true; url: URL; devOrigin: boolean }
  | { ok: false; reason: string };

/** Structural rules for a CIMD client_id URL (pure). */
export function checkCimdClientIdUrl(
  raw: string,
  devOrigins: ReadonlySet<string>
): CimdUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'client_id is not a valid URL' };
  }
  if (raw.includes('#')) return { ok: false, reason: 'client_id must not contain a fragment' };
  if (url.username || url.password) {
    return { ok: false, reason: 'client_id must not contain credentials' };
  }
  if (url.pathname === '/') return { ok: false, reason: 'client_id must contain a path' };
  // Canonical form only: no dot segments, no upper-case host, no explicit :443.
  if (url.href !== raw) return { ok: false, reason: 'client_id must be a canonical URL' };
  const devOrigin = devOrigins.has(url.origin);
  if (!devOrigin) {
    if (url.protocol !== 'https:') return { ok: false, reason: 'client_id must use https' };
    if (url.port !== '') return { ok: false, reason: 'client_id must use the default https port' };
  }
  return { ok: true, url, devOrigin };
}

export interface CimdClientMetadata {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export type CimdResolution =
  | { ok: true; client: CimdClientMetadata }
  | { ok: false; reason: string };

function stringList(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;
}

/** Validate a fetched metadata document against the URL it was fetched from (pure). */
export function validateCimdDocument(doc: unknown, clientId: string): CimdResolution {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, reason: 'metadata document is not a JSON object' };
  }
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) {
    return { ok: false, reason: 'metadata document client_id does not match its URL' };
  }
  if (d.client_secret !== undefined || d.client_secret_expires_at !== undefined) {
    return { ok: false, reason: 'metadata document must not carry a client secret' };
  }
  const auth = d.token_endpoint_auth_method;
  if (auth !== undefined && auth !== 'none') {
    return { ok: false, reason: 'only public clients (token_endpoint_auth_method "none") are supported' };
  }
  if (d.grant_types !== undefined) {
    const grants = stringList(d.grant_types);
    if (!grants || !grants.includes('authorization_code')) {
      return { ok: false, reason: 'grant_types must include authorization_code' };
    }
  }
  if (d.response_types !== undefined) {
    const types = stringList(d.response_types);
    if (!types || !types.includes('code')) {
      return { ok: false, reason: 'response_types must include code' };
    }
  }
  // A document without a name is still identifiable: show its host.
  const name =
    typeof d.client_name === 'string' && d.client_name.trim()
      ? d.client_name
      : new URL(clientId).host;
  const meta = checkClientMetadata({ clientName: name, redirectUris: d.redirect_uris });
  if (!meta.ok) return { ok: false, reason: meta.description };
  return {
    ok: true,
    client: { clientId, clientName: meta.clientName, redirectUris: meta.redirectUris },
  };
}

/** A fetch/parse failure whose message is safe to show on the error page. */
export class CimdFetchError extends Error {}

export type CimdFetcher = (url: URL, opts: { allowPrivate: boolean }) => Promise<unknown>;

/** Fetch + JSON-parse a metadata document through the SSRF guard. */
export const fetchCimdDocument: CimdFetcher = async (url, { allowPrivate }) => {
  let timer: NodeJS.Timeout | undefined;
  const overall = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CimdFetchError('metadata document fetch timed out')),
      CIMD_TIMEOUT_MS
    );
  });
  let res;
  try {
    res = await Promise.race([
      ssrfSafeForward({
        url,
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'drobek-oauth-cimd' },
        // EMPTY by default: a private/reserved address is always rejected,
        // except the exact dev/test origin the caller vouched for.
        allowedHosts: allowPrivate
          ? new Set([url.hostname.replace(/^\[|\]$/g, '').toLowerCase()])
          : new Set<string>(),
        timeoutMs: CIMD_TIMEOUT_MS,
        maxResponseBytes: CIMD_MAX_BYTES,
        deadlineMs: CIMD_TIMEOUT_MS,
      }),
      overall,
    ]);
  } catch (err) {
    if (err instanceof CimdFetchError) throw err;
    if (err instanceof ProxyError && err.code === 'ssrf_blocked') {
      throw new CimdFetchError('metadata host resolves to a private or reserved address');
    }
    if (err instanceof ProxyError && /size cap/.test(err.message)) {
      throw new CimdFetchError(`metadata document exceeds ${CIMD_MAX_BYTES} bytes`);
    }
    if (err instanceof ProxyError && /timed out/.test(err.message)) {
      throw new CimdFetchError('metadata document fetch timed out');
    }
    throw new CimdFetchError('metadata document could not be fetched');
  } finally {
    clearTimeout(timer);
  }
  if (res.status !== 200) {
    // 3xx included: redirects are never followed.
    throw new CimdFetchError(`metadata document answered HTTP ${res.status}`);
  }
  try {
    return JSON.parse(res.body.toString('utf8')) as unknown;
  } catch {
    throw new CimdFetchError('metadata document is not valid JSON');
  }
};

/** Minimal cache seam (Redis in production, a Map in unit tests). */
export interface CimdCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
}

const redisCache: CimdCache = {
  get: (key) => getRedis().get(key),
  set: async (key, value, ttlSec) => {
    await getRedis().set(key, value, 'EX', ttlSec);
  },
};

export interface CimdDeps {
  fetch?: CimdFetcher;
  cache?: CimdCache;
  env?: NodeJS.ProcessEnv;
}

function cacheKey(clientId: string): string {
  return `drobek:oauth:cimd:${createHash('sha256').update(clientId).digest('hex')}`;
}

/**
 * Resolve a CIMD client_id to validated client metadata (cached). Any failure
 * — bad URL, blocked address, fetch error, oversize, mismatch, bad redirect —
 * is `{ ok: false, reason }`; the AS answers it with `invalid_client`.
 */
export async function resolveCimdMetadata(
  clientId: string,
  deps: CimdDeps = {}
): Promise<CimdResolution> {
  const check = checkCimdClientIdUrl(clientId, cimdDevOrigins(deps.env));
  if (!check.ok) return check;

  const cache = deps.cache ?? redisCache;
  const key = cacheKey(clientId);
  try {
    const hit = await cache.get(key);
    if (hit) return JSON.parse(hit) as CimdResolution;
  } catch {
    /* cache unavailable → fetch */
  }

  let result: CimdResolution;
  try {
    const doc = await (deps.fetch ?? fetchCimdDocument)(check.url, {
      allowPrivate: check.devOrigin,
    });
    result = validateCimdDocument(doc, clientId);
  } catch (err) {
    result = {
      ok: false,
      reason:
        err instanceof CimdFetchError
          ? err.message
          : 'metadata document could not be fetched',
    };
  }

  try {
    await cache.set(
      key,
      JSON.stringify(result),
      result.ok ? CIMD_CACHE_TTL_SEC : CIMD_FAILURE_TTL_SEC
    );
  } catch {
    /* best effort */
  }
  return result;
}
