/**
 * The apps origin (M0-05): every app lives on its own host under
 * `APPS_DOMAIN` — the published version at `<slug>.<APPS_DOMAIN>`, the working
 * copy at `<slug>--preview.<APPS_DOMAIN>`, one version at
 * `<slug>--v<N>.<APPS_DOMAIN>`. This module computes the URLs the tools and the
 * dashboard hand out; host.ts parses them back (M0-06 serving).
 *
 * `APPS_DOMAIN` is a bare host (optionally `:port`), no scheme. It is required
 * in production (the server refuses to start without it); in dev it defaults
 * to `apps.localhost:3041` (`*.localhost` resolves to loopback in browsers).
 * `APPS_URL_SCHEME` (http | https) defaults to http for `localhost` /
 * `*.localhost` and https otherwise.
 */

import type { HostConfig } from './host.js';

export const DEV_APPS_DOMAIN = 'apps.localhost:3041';

export interface AppsOrigin {
  /** Host (+ optional port) the app hosts live under, e.g. `drobek.app`. */
  domain: string;
  scheme: 'http' | 'https';
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*(?::(\\d{1,5}))?$`);

function isLocalhost(domain: string): boolean {
  const host = domain.replace(/:\d+$/, '');
  return host === 'localhost' || host.endsWith('.localhost');
}

type Resolved = { ok: true; origin: AppsOrigin } | { ok: false; error: string };

function resolve(env: NodeJS.ProcessEnv): Resolved {
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
  return { ok: true, origin: { domain, scheme } };
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

/** `https://<slug>--preview.<APPS_DOMAIN>` — the working copy (last version that compiled). */
export function previewUrl(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  const { scheme, domain } = appsOrigin(env);
  return `${scheme}://${slug}--preview.${domain}`;
}

/** `https://<slug>.<APPS_DOMAIN>` — the published version. */
export function publishedUrl(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  const { scheme, domain } = appsOrigin(env);
  return `${scheme}://${slug}.${domain}`;
}

/** `https://<slug>--v<N>.<APPS_DOMAIN>` — exactly version N. */
export function versionUrl(slug: string, number: number, env: NodeJS.ProcessEnv = process.env): string {
  const { scheme, domain } = appsOrigin(env);
  return `${scheme}://${slug}--v${number}.${domain}`;
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

/** What host dispatch needs: APPS_DOMAIN and the dashboard's host. Throws on a bad APPS_DOMAIN. */
export function hostConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
  let dashboardHost: string | null = null;
  try {
    dashboardHost = new URL(dashboardOrigin(env)).host || null;
  } catch {
    dashboardHost = null;
  }
  return { appsDomain: appsOrigin(env).domain, dashboardHost };
}
