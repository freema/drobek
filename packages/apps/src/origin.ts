/**
 * The apps origin: every app lives on its own host under
 * `APPS_DOMAIN` — the published version at `<slug>.<APPS_DOMAIN>`, the working
 * copy at `<slug>--preview.<APPS_DOMAIN>`, one version at
 * `<slug>--v<N>.<APPS_DOMAIN>`. This module computes the URLs the tools and the
 * dashboard hand out; host.ts parses them back.
 *
 * `APPS_DOMAIN` is a bare host (optionally `:port`), no scheme. It is required
 * in production (the server refuses to start without it); in dev it defaults
 * to `apps.localhost:3041` (`*.localhost` resolves to loopback in browsers).
 * `APPS_URL_SCHEME` (http | https) defaults to http for `localhost` /
 * `*.localhost` and https otherwise.
 *
 * PATH ROUTING (`APPS_ROUTING_MODE=path`): a personal instance without a domain
 * of its own. Every app lives under ONE apps origin, `APPS_BASE_URL` (e.g. a
 * platform-generated `https://apps-xyz.up.railway.app`), told apart by the
 * first path segment: `<APPS_BASE_URL>/apps/<slug>/`,
 * `/apps/<slug>--preview/`, `/apps/<slug>--v<N>/` (host.ts parses them). The
 * apps origin must differ from the dashboard's; APPS_DOMAIN is not used. All
 * apps share one browser origin, so the mode is for one trusted owner only
 * (see docs/SECURITY.md → Path routing).
 */

import type { HostConfig } from './host.js';

export const DEV_APPS_DOMAIN = 'apps.localhost:3041';

export type AppsRoutingMode = 'subdomain' | 'path';

/** The first path segment of every app address in path routing: `/apps/<label>/`. */
export const APPS_PATH_PREFIX = '/apps/';

export interface AppsOrigin {
  /**
   * subdomain: the host (+ optional port) the app hosts live under, e.g.
   * `drobek.app`. path: the one apps host (+ port) of APPS_BASE_URL.
   */
  domain: string;
  scheme: 'http' | 'https';
  mode: AppsRoutingMode;
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*(?::(\\d{1,5}))?$`);

function isLocalhost(domain: string): boolean {
  const host = domain.replace(/:\d+$/, '');
  return host === 'localhost' || host.endsWith('.localhost');
}

type Resolved = { ok: true; origin: AppsOrigin } | { ok: false; error: string };

function resolveMode(env: NodeJS.ProcessEnv): AppsRoutingMode | null {
  const raw = env.APPS_ROUTING_MODE?.trim().toLowerCase() || 'subdomain';
  return raw === 'subdomain' || raw === 'path' ? raw : null;
}

function resolvePath(env: NodeJS.ProcessEnv): Resolved {
  const raw = env.APPS_BASE_URL?.trim();
  if (!raw) {
    return {
      ok: false,
      error: 'APPS_BASE_URL is not set (required with APPS_ROUTING_MODE=path) — e.g. APPS_BASE_URL=https://apps.example.com',
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'APPS_BASE_URL must be an absolute http(s) origin, e.g. https://apps.example.com' };
  }
  const bare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !bare || !DOMAIN_RE.test(url.host)) {
    return {
      ok: false,
      error: 'APPS_BASE_URL must be a bare http(s) origin (no path, query or credentials), e.g. https://apps.example.com',
    };
  }
  if (env.APPS_DOMAIN?.trim()) {
    return { ok: false, error: 'APPS_DOMAIN does not apply with APPS_ROUTING_MODE=path — apps live under APPS_BASE_URL/apps/<slug>/' };
  }
  if (env.APPS_URL_SCHEME?.trim()) {
    return { ok: false, error: 'APPS_URL_SCHEME does not apply with APPS_ROUTING_MODE=path — the scheme comes from APPS_BASE_URL' };
  }
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  if (env.NODE_ENV === 'production' && scheme !== 'https' && !isLocalhost(url.host)) {
    return { ok: false, error: 'APPS_BASE_URL must use https in production' };
  }
  let dashboard: URL | null = null;
  try {
    dashboard = new URL(dashboardOrigin(env));
  } catch {
    dashboard = null;
  }
  if (!dashboard || dashboard.hostname.toLowerCase() === url.hostname.toLowerCase()) {
    return {
      ok: false,
      error:
        'APPS_BASE_URL must be on another host than the dashboard (PUBLIC_APP_URL) — app code must never run on the dashboard origin',
    };
  }
  return { ok: true, origin: { domain: url.host.toLowerCase(), scheme, mode: 'path' } };
}

function resolve(env: NodeJS.ProcessEnv): Resolved {
  const mode = resolveMode(env);
  if (mode === null) return { ok: false, error: 'APPS_ROUTING_MODE must be subdomain or path' };
  if (mode === 'path') return resolvePath(env);
  const raw = env.APPS_DOMAIN?.trim().toLowerCase();
  let domain: string;
  if (!raw) {
    if (env.NODE_ENV === 'production') {
      return {
        ok: false,
        error: 'APPS_DOMAIN is not set (required in production) — e.g. APPS_DOMAIN=apps.example.com',
      };
    }
    domain = DEV_APPS_DOMAIN;
  } else {
    const m = DOMAIN_RE.exec(raw);
    const port = m?.[1] ? Number(m[1]) : null;
    if (!m || raw.length > 253 || (port !== null && (port < 1 || port > 65535))) {
      return {
        ok: false,
        error: `APPS_DOMAIN must be a bare host name with an optional :port (no scheme, no path), e.g. apps.example.com`,
      };
    }
    domain = raw;
  }

  // Empty counts as unset (docker-compose passes `${APPS_URL_SCHEME:-}` through as "").
  const rawScheme = env.APPS_URL_SCHEME?.trim().toLowerCase() || undefined;
  if (rawScheme && rawScheme !== 'http' && rawScheme !== 'https') {
    return { ok: false, error: 'APPS_URL_SCHEME must be http or https' };
  }
  const scheme = (rawScheme as 'http' | 'https' | undefined) ?? (isLocalhost(domain) ? 'http' : 'https');
  return { ok: true, origin: { domain, scheme, mode: 'subdomain' } };
}

/** Startup check: a human-readable error, or null when the apps origin config is valid. */
export function appsOriginConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  const r = resolve(env);
  return r.ok ? null : `drobek refuses to start: ${r.error}.`;
}

/** The configured apps origin. Throws on an invalid config (the server checks it at start). */
export function appsOrigin(env: NodeJS.ProcessEnv = process.env): AppsOrigin {
  const r = resolve(env);
  if (!r.ok) throw new Error(r.error);
  return r.origin;
}

/** True when apps are told apart by path under one APPS_BASE_URL (personal mode). */
export function pathRouting(env: NodeJS.ProcessEnv = process.env): boolean {
  return appsOrigin(env).mode === 'path';
}

/**
 * The URL of one app address, the single place that spells it out:
 * subdomain `https://<label>.<APPS_DOMAIN>`, path `<APPS_BASE_URL>/apps/<label>`
 * (no trailing slash; the server redirects it to `/apps/<label>/`, so a
 * `+ '/path'` suffix works in both modes).
 */
function appAddress(label: string, env: NodeJS.ProcessEnv): string {
  const { scheme, domain, mode } = appsOrigin(env);
  return mode === 'path' ? `${scheme}://${domain}${APPS_PATH_PREFIX}${label}` : `${scheme}://${label}.${domain}`;
}

/** The working copy (last version that compiled): `<slug>--preview`. */
export function previewUrl(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  return appAddress(`${slug}--preview`, env);
}

/** The published version: `<slug>`. */
export function publishedUrl(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  return appAddress(slug, env);
}

/** Exactly version N: `<slug>--v<N>`. */
export function versionUrl(slug: string, number: number, env: NodeJS.ProcessEnv = process.env): string {
  return appAddress(`${slug}--v${number}`, env);
}

/**
 * The dashboard origin (`PUBLIC_APP_URL`, falling back to `PUBLIC_ORIGIN`, then
 * the dev default) — the same resolution the OAuth issuer and the agent docs use.
 */
export function dashboardOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PUBLIC_APP_URL?.trim() || env.PUBLIC_ORIGIN?.trim() || 'http://localhost:3041';
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

/** What host dispatch needs: the apps host(s), the routing mode and the dashboard's host. Throws on a bad config. */
export function hostConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
  let dashboardHost: string | null = null;
  try {
    dashboardHost = new URL(dashboardOrigin(env)).host || null;
  } catch {
    dashboardHost = null;
  }
  const origin = appsOrigin(env);
  return { appsDomain: origin.domain, dashboardHost, ...(origin.mode === 'path' ? { mode: 'path' as const } : {}) };
}
