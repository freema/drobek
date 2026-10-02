import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { APPS_DOMAIN, APPS_URL_SCHEME, BASE_URL_WEB, DROBEK_URL } from '../../playwright.config';

/**
 * Raw requests to app hosts (`<slug>[--preview|--v<N>].<APPS_DOMAIN>`).
 *
 * Node and curl do not resolve `*.localhost` on every system, so a request to
 * a `*.localhost` app host goes to 127.0.0.1 with an explicit Host header (and
 * the host as TLS SNI over https — exactly what a browser sends). Any other
 * host (a real APPS_DOMAIN, e.g. the @smoke run against production) is
 * resolved normally. Over https the certificate is verified against Node's
 * trust store — the image e2e flow (`task e2e:image`) adds Caddy's local root
 * CA through NODE_EXTRA_CA_CERTS. No cookie jar: every header is explicit.
 * Not a spec file — Playwright never collects it.
 */

/**
 * Every app host lets the dashboard origin (PUBLIC_APP_URL = the
 * e2e's BASE_URL_WEB) frame it, for the app-list thumbnail — the CSP's
 * `frame-ancestors` is this origin instead of `'none'` (plus the app's own
 * override, when one is set).
 */
export const DASHBOARD_ORIGIN = new URL(BASE_URL_WEB).origin;

export interface Raw {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  /** The raw response bytes (`body` is them decoded as UTF-8). */
  bytes: Buffer;
}

export interface RawOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

/** `slug.apps.localhost:3041` → { hostname, port } (port defaults from the scheme). */
function splitHost(host: string, scheme: 'http' | 'https'): { hostname: string; port: number } {
  const m = /^(.*?)(?::(\d+))?$/.exec(host) as RegExpExecArray;
  return { hostname: m[1], port: m[2] ? Number(m[2]) : scheme === 'https' ? 443 : 80 };
}

const isLoopbackName = (hostname: string): boolean => hostname === 'localhost' || hostname.endsWith('.localhost');

/** A request to `host` (+ optional :port) over `scheme`; `via` connects elsewhere with the same Host. */
function rawRequest(
  scheme: 'http' | 'https',
  host: string,
  path = '/',
  opts: RawOpts = {},
  via?: { hostname: string; port: number }
): Promise<Raw> {
  const { hostname, port } = via ?? splitHost(host, scheme);
  const sni = splitHost(host, scheme).hostname;
  const send = scheme === 'https' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      {
        host: isLoopbackName(hostname) ? '127.0.0.1' : hostname,
        port,
        path,
        method: opts.method ?? 'GET',
        headers: { ...opts.headers, Host: host },
        setHost: false,
        ...(scheme === 'https' ? { servername: sni } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: bytes.toString('utf8'), bytes });
        });
      }
    );
    req.setTimeout(15_000, () => req.destroy(new Error(`timeout: ${scheme}://${host}${path}`)));
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** A request to an app host of THIS target (scheme from APPS_URL_SCHEME). */
export function hostRequest(host: string, path = '/', opts: RawOpts = {}): Promise<Raw> {
  return rawRequest(APPS_URL_SCHEME as 'http' | 'https', host, path, opts);
}

/** GET an absolute URL: an app URL as a tool returned it (preview_url / published_url), the mock IdP's. */
export function getAppUrl(url: string, path = '/', opts: RawOpts = {}): Promise<Raw> {
  const u = new URL(url);
  return rawRequest(u.protocol === 'https:' ? 'https' : 'http', u.host, path, opts);
}

/**
 * A request with `Host: host` straight to drobek (DROBEK_URL, plain http) —
 * what the TLS proxy forwards, including headers only the proxy may set
 * (`X-Real-IP` under TRUST_PROXY=x-real-ip) or names it never serves itself
 * (Caddy's ask on `drobek:3000`, a custom domain before it has a certificate).
 */
export function directRequest(host: string, path = '/', opts: RawOpts = {}): Promise<Raw> {
  const drobek = new URL(DROBEK_URL);
  return rawRequest('http', host, path, opts, { hostname: drobek.hostname, port: Number(drobek.port || 80) });
}

export const prodHost = (slug: string): string => `${slug}.${APPS_DOMAIN}`;
export const previewHost = (slug: string): string => `${slug}--preview.${APPS_DOMAIN}`;
export const versionHost = (slug: string, n: number): string => `${slug}--v${n}.${APPS_DOMAIN}`;
export const urlOf = (host: string): string => `${APPS_URL_SCHEME}://${host}`;
