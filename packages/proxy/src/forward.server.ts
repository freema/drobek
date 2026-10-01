/**
 * forwardToUpstream — the gateway core of one proxied call.
 * Principal-agnostic: WHO may call WHICH upstream is decided by the caller (the
 * `proxy` platform module checks the app's config, rule and rate limits on the
 * app host). This enforces what belongs to the upstream itself:
 *
 *   1. the method + path allow-lists (path normalized traversal-proof);
 *   2. the secret, decrypted IN MEMORY and injected (never logged or returned);
 *   3. the client's Cookie / Authorization / hop-by-hop / browser headers
 *      stripped (auth-inject.ts);
 *   4. the SSRF-safe forward: resolve once + pinned IP, port allow-list,
 *      connect timeout, 20 s deadline, 5 MiB response cap — the deadline and
 *      the cap cover the whole redirect chain;
 *   4b. a 301/302/303/307/308 is followed (at most 3 hops, each through the
 *      SSRF guard again) only when the target keeps the base URL's scheme,
 *      host and port, stays under its base path and allowed prefixes and the
 *      resulting method is allowed; 301/302/303 turn a non-GET/HEAD request
 *      into a GET without a body, 307/308 resend method and body. Any other
 *      redirect, and any other 3xx but 304, is `upstream_redirect` (502)
 *      naming only the target's path — a foreign Location never reaches the app;
 *   5. a `Content-Encoding` the upstream sent anyway (gzip / deflate / br) is
 *      decoded — the DECODED body must fit the same cap;
 *   6. the response relayed with allow-listed headers + `Cache-Control: no-store`.
 */
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { buildForwardHeaders, filterResponseHeaders } from './auth-inject.js';
import { decryptSecret } from './crypto.server.js';
import { ProxyError } from './errors.js';
import { DEFAULT_FORWARD_DEADLINE_MS, proxyMaxResponseBytes, ssrfSafeForward, type SsrfForwardResult } from './ssrf.server.js';
import type { UpstreamRecord } from './upstreams.server.js';
import {
  assertMethodAllowed,
  assertPathAllowed,
  normalizeForwardPath,
  pathMatchesPrefix,
  resolveForwardTarget,
  targetSubpath,
} from './validate.js';

export interface ForwardInput {
  upstream: UpstreamRecord;
  /** The client's method (HEAD included). */
  method: string;
  /** The subpath under the upstream (raw, percent-encoded; normalized here). */
  subpath: string;
  /** The client's raw query string, with or without `?` ('' for none). */
  search: string;
  /** The client's request headers (filtered here). */
  headers: Headers;
  body?: Buffer;
  env?: NodeJS.ProcessEnv;
  /** Wall-clock cap of the exchange (default 20 s). */
  deadlineMs?: number;
  /** A lower response cap than PROXY_MAX_RESPONSE_BYTES (a module job's own limit); never a higher one. */
  maxResponseBytes?: number;
}

export interface ForwardResult {
  status: number;
  headers: Record<string, string>;
  /** null for HEAD / 204 / 304. */
  body: Buffer | null;
  /** The address the gateway connected to (non-secret; for logs). */
  resolvedIp: string;
}

const BODYLESS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Redirects followed within the upstream's origin and prefixes. */
const MAX_UPSTREAM_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function locationPathOf(location: URL | null): string | null {
  return location ? location.pathname : null;
}

function redirectRefused(location: URL | null, why: string): ProxyError {
  const path = locationPathOf(location);
  const where = path === null ? 'a redirect' : `a redirect to ${path}`;
  return new ProxyError(
    'upstream_redirect',
    `the upstream answered ${where} that drobek does not follow (${why}) — allow that path prefix on the upstream, or register the target host as its own upstream`,
    { location_path: path }
  );
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
}

interface Hop {
  url: URL;
  method: string;
  body: Buffer | undefined;
  headers: Record<string, string>;
}

/**
 * The next hop of a redirect, or `upstream_redirect` when it may not be
 * followed: another scheme/host/port, a path outside the base path or the
 * allowed prefixes, a method the upstream does not allow, a loop or too many hops.
 */
function nextHop(
  upstream: UpstreamRecord,
  current: Hop,
  status: number,
  location: string | undefined,
  followed: number,
  seen: Set<string>
): Hop {
  if (location === undefined || location.trim() === '') throw redirectRefused(null, 'no Location');
  let next: URL;
  try {
    next = new URL(location.trim(), current.url);
  } catch {
    throw redirectRefused(null, 'an invalid Location');
  }
  next.hash = '';
  const base = new URL(upstream.baseUrl);
  if (next.origin !== base.origin) throw redirectRefused(next, 'another host, scheme or port');
  const basePath = base.pathname.replace(/\/+$/, '');
  if (!pathMatchesPrefix(next.pathname, basePath || '/')) {
    throw redirectRefused(next, 'outside the upstream base URL');
  }
  try {
    const rel = targetSubpath(next, upstream.baseUrl);
    assertPathAllowed(normalizeForwardPath(rel), upstream.allowedPathPrefixes);
    assertPathAllowed(rel, upstream.allowedPathPrefixes);
  } catch (err) {
    if (err instanceof ProxyError) throw redirectRefused(next, 'outside the allowed path prefixes');
    throw err;
  }
  if (followed >= MAX_UPSTREAM_REDIRECTS) {
    throw redirectRefused(next, `more than ${MAX_UPSTREAM_REDIRECTS} redirects`);
  }
  const toGet = status !== 307 && status !== 308 && current.method !== 'GET' && current.method !== 'HEAD';
  const method = toGet ? 'GET' : current.method;
  try {
    assertMethodAllowed(method, upstream.allowedMethods);
  } catch (err) {
    if (err instanceof ProxyError) throw redirectRefused(next, `method ${method} is not allowed`);
    throw err;
  }
  const key = `${method} ${next.href}`;
  if (seen.has(key)) throw redirectRefused(next, 'a redirect loop');
  seen.add(key);
  if (!toGet) return { url: next, method, body: current.body, headers: current.headers };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(current.headers)) {
    if (!/^content-/i.test(k)) headers[k] = v;
  }
  return { url: next, method, body: undefined, headers };
}

type Decoder = (buf: Buffer, opts: zlib.ZlibOptions | zlib.BrotliOptions) => Promise<Buffer>;
const gunzip = promisify(zlib.gunzip) as Decoder;
const inflate = promisify(zlib.inflate) as Decoder;
const inflateRaw = promisify(zlib.inflateRaw) as Decoder;
const brotli = promisify(zlib.brotliDecompress) as Decoder;

async function decodeOne(coding: string, buf: Buffer, maxBytes: number): Promise<Buffer> {
  const opts = { maxOutputLength: maxBytes };
  switch (coding) {
    case 'gzip':
    case 'x-gzip':
      return gunzip(buf, opts);
    case 'deflate':
      // RFC 9110 deflate is zlib-wrapped; some servers send it raw.
      return inflate(buf, opts).catch((err: unknown) => {
        if (err instanceof RangeError) throw err;
        return inflateRaw(buf, opts);
      });
    case 'br':
      return brotli(buf, opts);
    default:
      throw new ProxyError('upstream_error', `upstream answered with an unsupported Content-Encoding "${coding}"`);
  }
}

/**
 * Undo the upstream's `Content-Encoding` (a list is applied in order, so it is
 * undone right to left). Each decoded stage is capped at `maxBytes`: a small
 * compressed body that inflates past the cap is refused like a large one.
 */
export async function decodeBody(body: Buffer, contentEncoding: string | undefined, maxBytes: number): Promise<Buffer> {
  const codings = (contentEncoding ?? '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== '' && c !== 'identity');
  let out = body;
  for (const coding of codings.reverse()) {
    try {
      out = await decodeOne(coding, out, maxBytes);
    } catch (err) {
      if (err instanceof ProxyError) throw err;
      throw err instanceof RangeError
        ? new ProxyError('upstream_error', 'upstream response exceeded the size cap')
        : new ProxyError('upstream_error', 'upstream response could not be decoded');
    }
  }
  return out;
}

export async function forwardToUpstream(input: ForwardInput): Promise<ForwardResult> {
  const env = input.env ?? process.env;
  const method = input.method.toUpperCase();
  const upstream = input.upstream;

  // 1) Method + path allow-lists.
  assertMethodAllowed(method, upstream.allowedMethods);
  const target = resolveForwardTarget(upstream.baseUrl, input.subpath, input.search, upstream.allowedPathPrefixes);

  // 2) Decrypt the secret IN MEMORY (fail closed on a wrong/rotated KEK).
  let secret: string | null = null;
  if (upstream.authType !== 'none') {
    if (!upstream.secret) {
      throw new ProxyError('config_error', 'upstream has no stored secret');
    }
    secret = decryptSecret(upstream.secret, env);
  }

  // 3) Outgoing headers: client credentials + browser metadata stripped, auth injected.
  const headers = buildForwardHeaders(input.headers, {
    authType: upstream.authType,
    authHeaderName: upstream.authHeaderName,
    secret,
  });
  const body =
    !BODYLESS.has(method) && input.body && input.body.length > 0 ? input.body : undefined;

  // 4) SSRF-safe forward (pinned IP, port allow-list, deadline, size cap), each
  //    redirect hop checked by nextHop and sent through the guard again.
  const envMax = proxyMaxResponseBytes(env);
  const maxBytes =
    input.maxResponseBytes !== undefined && Number.isInteger(input.maxResponseBytes) && input.maxResponseBytes > 0
      ? Math.min(envMax, input.maxResponseBytes)
      : envMax;
  const deadlineMs = input.deadlineMs ?? DEFAULT_FORWARD_DEADLINE_MS;
  const startedAt = Date.now();
  const origin = new URL(upstream.baseUrl).origin;
  let hop: Hop = { url: target, method, body, headers };
  const seen = new Set([`${method} ${target.href}`]);
  let budget = maxBytes;
  let followed = 0;
  let result: SsrfForwardResult;
  for (;;) {
    if (hop.url.origin !== origin) {
      // nextHop never leaves the origin; the injected secret must not either.
      throw redirectRefused(hop.url, 'another host, scheme or port');
    }
    const remaining = deadlineMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new ProxyError('upstream_error', 'upstream request timed out');
    result = await ssrfSafeForward({
      url: hop.url,
      method: hop.method,
      headers: hop.headers,
      body: hop.body,
      env,
      maxResponseBytes: budget,
      deadlineMs: remaining,
    });
    if (result.status < 300 || result.status > 399 || result.status === 304) break;
    if (!REDIRECT_STATUSES.has(result.status)) {
      const loc = headerOf(result.headers, 'location');
      let parsed: URL | null = null;
      try {
        parsed = loc ? new URL(loc, hop.url) : null;
      } catch {
        parsed = null;
      }
      throw redirectRefused(parsed, `status ${result.status}`);
    }
    budget -= result.body.length;
    if (budget <= 0) throw new ProxyError('upstream_error', 'upstream response exceeded the size cap');
    hop = nextHop(upstream, hop, result.status, headerOf(result.headers, 'location'), followed, seen);
    followed += 1;
  }

  // 5) Decode what the upstream encoded despite `Accept-Encoding: identity`.
  const nullBody = result.status === 204 || result.status === 304 || hop.method === 'HEAD';
  const encoding = headerOf(result.headers, 'content-encoding');
  const decoded = nullBody || result.body.length === 0 ? result.body : await decodeBody(result.body, encoding, maxBytes);

  // 6) Relay: allow-listed headers, never cached.
  const outHeaders = filterResponseHeaders(Object.entries(result.headers));
  for (const k of Object.keys(outHeaders)) {
    if (k.toLowerCase() === 'cache-control') delete outHeaders[k];
  }
  outHeaders['Cache-Control'] = 'no-store';
  outHeaders['X-Content-Type-Options'] = 'nosniff';
  return {
    status: result.status,
    headers: outHeaders,
    body: nullBody ? null : decoded,
    resolvedIp: result.resolvedIp,
  };
}
