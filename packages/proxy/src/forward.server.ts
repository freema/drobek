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
 *   5. the response relayed with filtered headers + `Cache-Control: no-store`.
 */
import { buildForwardHeaders, filterResponseHeaders } from './auth-inject.js';
import { decryptSecret } from './crypto.server.js';
import { ProxyError } from './errors.js';
import { DEFAULT_FORWARD_DEADLINE_MS, ssrfSafeForward } from './ssrf.server.js';
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
  const result = await ssrfSafeForward({
    url: target,
    method,
    headers,
    body,
    env,
    deadlineMs: input.deadlineMs ?? DEFAULT_FORWARD_DEADLINE_MS,
  });

  // 5) Relay: filtered headers, never cached.
  const outHeaders = filterResponseHeaders(Object.entries(result.headers));
  for (const k of Object.keys(outHeaders)) {
    if (k.toLowerCase() === 'cache-control') delete outHeaders[k];
  }
  outHeaders['Cache-Control'] = 'no-store';
  outHeaders['X-Content-Type-Options'] = 'nosniff';
  const nullBody = result.status === 204 || result.status === 304 || method === 'HEAD';
  return {
    status: result.status,
    headers: outHeaders,
    body: nullBody ? null : result.body,
    resolvedIp: result.resolvedIp,
  };
}
