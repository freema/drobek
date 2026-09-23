/**
 * Origin check for the dashboard's mutating endpoints (M0-06, CSRF).
 *
 * The apps live on sibling hosts of the dashboard's registrable domain
 * (`<slug>.drobek.app` next to `drobek.app`), which makes every app SAME-SITE
 * with the dashboard: `SameSite=Lax` no longer stops app JS from submitting a
 * form or a `fetch(…, {credentials:'include'})` POST to the dashboard with the
 * session attached. Browsers always send `Origin` on such requests, so every
 * non-GET/HEAD/OPTIONS request to the dashboard is checked:
 *
 *   - Origin at or under APPS_DOMAIN                → 403 (the case that matters);
 *   - Origin `null` (sandboxed frame, opaque origin) → 403;
 *   - Origin = the dashboard origin (PUBLIC_APP_URL), or the request's own
 *     Host (a self-host reached under another name) → allowed;
 *   - any other Origin (a foreign site)              → 403;
 *   - NO Origin: allowed — non-browser clients (curl, server-to-server) send
 *     none and carry no ambient cookies; every current browser sends Origin on
 *     POST. A browser request that still lacks it but says
 *     `Sec-Fetch-Site: cross-site|same-site` is refused.
 *
 * EXEMPT (not cookie-authenticated; called cross-origin by native and web
 * MCP clients by design): `/oauth/token`, `/oauth/register` and `/mcp`
 * (Bearer-authenticated, mounted before this check anyway).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dashboardOrigin, hostConfig, isAppsOrigin, type HostConfig } from '@drobek/apps';

export const ORIGIN_CHECK_EXEMPT_PATHS: readonly string[] = ['/oauth/token', '/oauth/register', '/mcp'];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface OriginCheckInput {
  method: string;
  /** Request path (no query). */
  path: string;
  origin: string | null;
  secFetchSite: string | null;
  /** The request's Host header. */
  host: string | null;
  /** The dashboard origin, e.g. `https://drobek.app`. */
  dashboardOrigin: string;
  hosts: HostConfig;
}

export type OriginCheckDecision =
  | { ok: true }
  | { ok: false; reason: 'apps_origin' | 'null_origin' | 'foreign_origin' | 'cross_site_without_origin' };

function isExempt(path: string): boolean {
  return ORIGIN_CHECK_EXEMPT_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

export function decideOriginCheck(input: OriginCheckInput): OriginCheckDecision {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };
  if (isExempt(input.path)) return { ok: true };

  const origin = input.origin?.trim() ?? '';
  if (origin === '') {
    const site = input.secFetchSite?.trim().toLowerCase();
    if (site === 'cross-site' || site === 'same-site') {
      return { ok: false, reason: 'cross_site_without_origin' };
    }
    return { ok: true };
  }
  if (origin === 'null') return { ok: false, reason: 'null_origin' };
  if (isAppsOrigin(origin, input.hosts)) return { ok: false, reason: 'apps_origin' };

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { ok: false, reason: 'foreign_origin' };
  }
  if (url.origin === input.dashboardOrigin) return { ok: true };
  if (input.host && url.host === input.host.trim().toLowerCase()) return { ok: true };
  return { ok: false, reason: 'foreign_origin' };
}

function headerOf(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (v === undefined) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

/**
 * node:http / Express middleware applying `decideOriginCheck` to every request
 * that reaches the dashboard side (mount it after the apps-host dispatch).
 */
export function createOriginCheckMiddleware(
  opts: { hosts?: HostConfig; dashboardOrigin?: string; onReject?: (reason: string, req: IncomingMessage) => void } = {}
): (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void {
  const hosts = opts.hosts ?? hostConfig();
  const dashboard = opts.dashboardOrigin ?? dashboardOrigin();
  return (req, res, next) => {
    const url = req.url ?? '/';
    const q = url.indexOf('?');
    const decision = decideOriginCheck({
      method: req.method ?? 'GET',
      path: q === -1 ? url : url.slice(0, q),
      origin: headerOf(req, 'origin'),
      secFetchSite: headerOf(req, 'sec-fetch-site'),
      host: headerOf(req, 'host'),
      dashboardOrigin: dashboard,
      hosts,
    });
    if (decision.ok) {
      next();
      return;
    }
    opts.onReject?.(decision.reason, req);
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end('Forbidden: cross-origin request refused');
  };
}
