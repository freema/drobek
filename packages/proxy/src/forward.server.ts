/**
 * forwardToUpstream — the gateway core of one proxied call (PHY-59, NSO-297).
 * Principal-agnostic: WHO may call WHICH upstream is decided by the caller (the
 * `proxy` platform module checks the app's config, rule and rate limits on the
 * app host). This enforces what belongs to the upstream itself:
 *
 *   1. the method + path allow-lists (path normalized traversal-proof);
 *   2. the secret, decrypted IN MEMORY and injected (never logged or returned);
 *   3. the client's Cookie / Authorization / hop-by-hop / browser headers
 *      stripped (auth-inject.ts);
 *   4. the SSRF-safe forward: resolve once + pinned IP, port allow-list, no
 *      redirects, connect timeout, 20 s deadline, 5 MiB response cap;
 *   5. a `Content-Encoding` the upstream sent anyway (gzip / deflate / br) is
 *      decoded — the DECODED body must fit the same cap (NSO-326);
 *   6. the response relayed with allow-listed headers + `Cache-Control: no-store`.
 */
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { buildForwardHeaders, filterResponseHeaders } from './auth-inject.js';
import { decryptSecret } from './crypto.server.js';
import { ProxyError } from './errors.js';
import { DEFAULT_FORWARD_DEADLINE_MS, proxyMaxResponseBytes, ssrfSafeForward } from './ssrf.server.js';
import type { UpstreamRecord } from './upstreams.server.js';
import { assertMethodAllowed, resolveForwardTarget } from './validate.js';

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

  // 4) SSRF-safe forward (pinned IP, port allow-list, no redirects, deadline, size cap).
  const maxBytes = proxyMaxResponseBytes(env);
  const result = await ssrfSafeForward({
    url: target,
    method,
    headers,
    body,
    env,
    maxResponseBytes: maxBytes,
    deadlineMs: input.deadlineMs ?? DEFAULT_FORWARD_DEADLINE_MS,
  });

  // 5) Decode what the upstream encoded despite `Accept-Encoding: identity`.
  const nullBody = result.status === 204 || result.status === 304 || method === 'HEAD';
  const encoding = Object.entries(result.headers).find(([k]) => k.toLowerCase() === 'content-encoding')?.[1];
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
