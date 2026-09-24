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
 * `identity`; an upstream that encodes anyway is decoded by the forward path.
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
 * Upstream → client: an ALLOW-LIST (NSO-326). The relay answers on the APP's
 * origin, so nothing an upstream sends that acts on that origin may pass:
 * `Set-Cookie`, the upstream's CORS grants (`access-control-*`),
 * `Clear-Site-Data`, `Refresh`, `Link` (preload / prefetch), HSTS,
 * `Service-Worker-Allowed`, … are dropped by not being listed.
 * `content-length` and `content-encoding` are framing: the body may have been
 * decoded (forward.server.ts) and the app host re-frames it. `cache-control`
 * passes here and is then overwritten with `no-store` by the forward path.
 */
const ALLOWED_FROM_UPSTREAM = new Set([
  'content-type',
  'content-language',
  'content-range',
  'accept-ranges',
  'cache-control',
  'expires',
  'pragma',
  'etag',
  'last-modified',
  'vary',
  'date',
  'age',
  'retry-after',
  'request-id',
  'x-amzn-requestid',
  'x-amz-request-id',
  'ratelimit',
  'ratelimit-policy',
]);

/** Request ids (`x-request-id`, `x-correlation-id`, `x-trace-id`) and rate-limit hints (`x-ratelimit-*`, `ratelimit-*`). */
const ALLOWED_PATTERNS = [/^x-(request|correlation|trace)-id$/, /^x-ratelimit-[a-z0-9-]+$/, /^ratelimit-[a-z0-9-]+$/];

/**
 * A `Location` passes only as a RELATIVE reference — no scheme, no `//host`,
 * no backslash (browsers read `/\host` as `//host`), no control characters.
 * An absolute one would reveal the upstream's base URL (or point anywhere),
 * so it is dropped.
 */
function relativeLocation(value: string): string | null {
  const v = value.trim();
  if (v === '' || v.includes('\\') || [...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return null;
  if (v.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(v)) return null;
  return v;
}

function isHtml(contentType: string | undefined): boolean {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml';
}

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
  // Ask for the body unencoded (an encoded answer is decoded within the cap anyway).
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

/** Filter an upstream response's headers before relaying them to the client (allow-list). */
export function filterResponseHeaders(
  entries: Iterable<[string, string]>
): Record<string, string> {
  const list = [...entries];
  const contentType = list.find(([k]) => k.toLowerCase() === 'content-type')?.[1];
  const out: Record<string, string> = {};
  for (const [k, v] of list) {
    const name = k.toLowerCase();
    if (name === 'location') {
      const rel = relativeLocation(v);
      if (rel !== null) out[k] = rel;
    } else if (name === 'content-disposition') {
      // An HTML answer is never turned into a named download on the app origin.
      if (!isHtml(contentType)) out[k] = v;
    } else if (ALLOWED_FROM_UPSTREAM.has(name) || ALLOWED_PATTERNS.some((re) => re.test(name))) {
      out[k] = v;
    }
  }
  return out;
}
