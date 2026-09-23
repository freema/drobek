/**
 * PURE header construction (PHY-59) — unit tested. Builds the header set sent to
 * the upstream: the client's headers MINUS the ones that must never cross the
 * gateway (hop-by-hop, Host, and — critically — the client's Cookie AND
 * Authorization, so the drobek session and any client credential are NEVER
 * forwarded), PLUS the injected upstream secret in the configured shape.
 */
import { ProxyError } from './errors.js';

export type UpstreamAuthType = 'none' | 'bearer' | 'header';

/** Hop-by-hop headers (RFC 7230 §6.1) — never forwarded end-to-end. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Client → upstream: additionally stripped. `host` is set by the HTTP client to
 * the upstream host; `cookie`/`authorization` carry the drobek session + client
 * credentials and must NEVER leak to the upstream; `content-length` is recomputed
 * by the client; `x-forwarded-*` / `forwarded` / `via` / `x-real-ip` would leak
 * internal topology and the end user's IP; `origin` / `referer` / `sec-*` are the
 * BROWSER's view of the app host (APIs that refuse browser calls key on them);
 * `x-drobek-sdk` is drobek's own CSRF marker. `accept-encoding` is replaced by
 * `identity`: the gateway relays the body as-is and drops `content-encoding`.
 */
const STRIP_TO_UPSTREAM = new Set([
  ...HOP_BY_HOP,
  'host',
  'cookie',
  'authorization',
  'content-length',
  'accept-encoding',
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'origin',
  'referer',
  'x-drobek-sdk',
]);

/** Browser-only request metadata (`sec-fetch-*`, `sec-ch-ua*`, …) never crosses the gateway. */
function strippedToUpstream(name: string): boolean {
  return STRIP_TO_UPSTREAM.has(name) || name.startsWith('sec-');
}

/**
 * Upstream → client: strip hop-by-hop + framing headers (the drobek HTTP client
 * re-frames the response), any Set-Cookie from the upstream (it must not be
 * planted in the app's origin) and the upstream's CORS grants
 * (`access-control-*`: the upstream must not open the app host's proxy route
 * to other origins).
 */
const STRIP_FROM_UPSTREAM = new Set([
  ...HOP_BY_HOP,
  'content-length',
  'content-encoding',
  'set-cookie',
  'set-cookie2',
]);

export interface InjectAuthInput {
  authType: UpstreamAuthType;
  authHeaderName?: string | null;
  /** Decrypted plaintext secret — held in memory only, never logged. */
  secret?: string | null;
}

/**
 * Build the outgoing header map for the upstream request from the client's
 * incoming headers, then inject the upstream auth. The injected header always
 * OVERWRITES any client-supplied value of the same name.
 */
export function buildForwardHeaders(
  incoming: Headers,
  inject: InjectAuthInput
): Record<string, string> {
  const out: Record<string, string> = {};
  incoming.forEach((value, key) => {
    const name = key.toLowerCase();
    if (!strippedToUpstream(name)) out[name] = value;
  });
  // The body is relayed verbatim (never decoded), so ask for it unencoded.
  out['accept-encoding'] = 'identity';

  if (inject.authType === 'bearer') {
    if (!inject.secret) {
      throw new ProxyError('config_error', 'bearer upstream has no secret');
    }
    out['authorization'] = `Bearer ${inject.secret}`;
  } else if (inject.authType === 'header') {
    const name = (inject.authHeaderName ?? '').trim();
    if (!name) {
      throw new ProxyError('config_error', 'header auth upstream has no header name');
    }
    if (!inject.secret) {
      throw new ProxyError('config_error', 'header upstream has no secret');
    }
    out[name.toLowerCase()] = inject.secret;
  }
  // 'none' → inject nothing.
  return out;
}

/** Filter an upstream response's headers before relaying them to the client. */
export function filterResponseHeaders(
  entries: Iterable<[string, string]>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const name = k.toLowerCase();
    if (!STRIP_FROM_UPSTREAM.has(name) && !name.startsWith('access-control-')) out[k] = v;
  }
  return out;
}
