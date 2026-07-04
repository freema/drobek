/**
 * forwardProxy (PHY-59) — the BFF forward orchestrator. Resolves the upstream,
 * rate-limits the caller, enforces the method + path allow-lists, decrypts the
 * secret IN MEMORY, injects it, and forwards through the SSRF-safe choke point,
 * returning the upstream response with drobek-owned CORS + `no-store`.
 *
 * The caller's workspace MEMBERSHIP is authorized by the route BEFORE this runs
 * (v1 = any member). This module trusts the passed workspaceId/userId.
 */
import { buildForwardHeaders, filterResponseHeaders } from './auth-inject.js';
import { decryptSecret } from './crypto.server.js';
import { ProxyError } from './errors.js';
import { enforceProxyRateLimit } from './rate-limit.js';
import { ssrfSafeForward } from './ssrf.server.js';
import { resolveUpstreamForForward } from './upstreams.server.js';
import {
  assertMethodAllowed,
  assertPathAllowed,
  buildTargetUrl,
  normalizeForwardPath,
} from './validate.js';

export interface ForwardInput {
  workspaceId: string;
  userId: string;
  /** Upstream name from `/:ws/api/proxy/:name/*`. */
  name: string;
  /** The `*` splat — the subpath under the upstream. */
  subpath: string;
  request: Request;
  env?: NodeJS.ProcessEnv;
}

const BODYLESS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Drobek-owned CORS: reflect Origin ONLY when it is the drobek app origin. */
function corsFor(request: Request, env: NodeJS.ProcessEnv): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  const allow = [env.PUBLIC_ORIGIN, env.PUBLIC_APP_URL]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.replace(/\/$/, ''));
  if (allow.includes(origin.replace(/\/$/, ''))) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
    };
  }
  // Not the drobek origin → do NOT reflect (blocks cross-origin reads).
  return { Vary: 'Origin' };
}

export async function forwardProxy(input: ForwardInput): Promise<Response> {
  const env = input.env ?? process.env;
  const method = input.request.method.toUpperCase();

  // 1) Resolve the upstream (404 if the name is unknown in this workspace).
  const upstream = await resolveUpstreamForForward(input.workspaceId, input.name);

  // 2) Rate-limit per (workspace, user, upstream) — bound abuse early.
  await enforceProxyRateLimit(
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      upstreamId: upstream.id,
    },
    env
  );

  // 3) Method + path allow-lists (path normalized traversal-proof).
  assertMethodAllowed(method, upstream.allowedMethods);
  const normalizedPath = normalizeForwardPath(input.subpath);
  assertPathAllowed(normalizedPath, upstream.allowedPathPrefixes);

  // 4) Build the target URL = base_url + subpath + query.
  const search = new URL(input.request.url).search;
  const target = buildTargetUrl(upstream.baseUrl, normalizedPath, search);

  // 5) Decrypt the secret IN MEMORY (fail closed on a wrong/rotated KEK).
  let secret: string | null = null;
  if (upstream.authType !== 'none') {
    if (!upstream.secret) {
      throw new ProxyError('config_error', 'upstream has no stored secret');
    }
    secret = decryptSecret(upstream.secret, env);
  }

  // 6) Build outgoing headers — strips client Cookie/Authorization + hop-by-hop,
  //    injects the upstream auth.
  const headers = buildForwardHeaders(input.request.headers, {
    authType: upstream.authType,
    authHeaderName: upstream.authHeaderName,
    secret,
  });

  // 7) Read the client body (bodyless methods carry none).
  let body: Buffer | undefined;
  if (!BODYLESS.has(method)) {
    const buf = Buffer.from(await input.request.arrayBuffer());
    if (buf.length > 0) body = buf;
  }

  // 8) SSRF-safe forward (no redirects, pinned IP, timeout).
  const result = await ssrfSafeForward({ url: target, method, headers, body });

  // 9) Relay the upstream response with drobek CORS + no-store.
  const outHeaders = filterResponseHeaders(Object.entries(result.headers));
  outHeaders['Cache-Control'] = 'no-store';
  outHeaders['X-Content-Type-Options'] = 'nosniff';
  Object.assign(outHeaders, corsFor(input.request, env));

  // A 204/304 (and HEAD) response must carry no body per the Fetch spec.
  const nullBody = result.status === 204 || result.status === 304 || method === 'HEAD';
  return new Response(nullBody ? null : new Uint8Array(result.body), {
    status: result.status,
    headers: outHeaders,
  });
}
