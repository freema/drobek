/**
 * Every call to the IdP (discovery, JWKS, token, userinfo) goes through the
 * @drobek/proxy SSRF guard: the host resolved once and the connection pinned
 * to that IP, private and reserved addresses refused, no redirects, 5 s, at
 * most 64 KiB. The proxy's PROXY_ALLOWED_HOSTS never applies: a private
 * address is reachable only for the operator's own issuer host
 * (AUTH_OIDC_ISSUER) and the dev origins (AUTH_OIDC_DEV_ORIGINS, never in
 * production). https only, except a dev origin.
 */
import { effectivePort, proxyAllowedPorts, ssrfSafeForward } from '@drobek/proxy';

const IDP_TIMEOUT_MS = 5_000;
const IDP_MAX_BYTES = 64 * 1024;

export interface IdpRequest {
  url: URL;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  /** The host may resolve to a private address (the operator's issuer host or a dev origin). */
  allowPrivate: boolean;
  /** Any port of this URL is fine (the operator's issuer or a dev origin); else PROXY_ALLOWED_PORTS. */
  anyPort: boolean;
}

export interface IdpResponse {
  status: number;
  body: Buffer;
}

export type IdpFetch = (req: IdpRequest) => Promise<IdpResponse>;

/** The guarded fetch (the default; tests pass a fake). */
export const guardedFetch: IdpFetch = async (req) => {
  const host = req.url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const res = await ssrfSafeForward({
    url: req.url,
    method: req.method,
    headers: { 'user-agent': 'drobek-oidc', ...req.headers },
    ...(req.body !== undefined ? { body: Buffer.from(req.body, 'utf8') } : {}),
    allowedHosts: req.allowPrivate ? new Set([host]) : new Set<string>(),
    allowedPorts: req.anyPort ? new Set([effectivePort(req.url)]) : proxyAllowedPorts(),
    timeoutMs: IDP_TIMEOUT_MS,
    maxResponseBytes: IDP_MAX_BYTES,
    deadlineMs: IDP_TIMEOUT_MS,
  });
  return { status: res.status, body: res.body };
};
