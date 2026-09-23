/**
 * Host dispatch for the apps origin (M0-06). Pure — no env, no I/O.
 *
 * Every app has its own hosts (= its own browser origins) under APPS_DOMAIN:
 *   <slug>.<APPS_DOMAIN>            → the published version
 *   <slug>--preview.<APPS_DOMAIN>   → the newest version that compiled
 *   <slug>--v<N>.<APPS_DOMAIN>      → exactly version N
 * The slug grammar forbids `--`, so the three forms never collide.
 *
 * `classifyHost` decides, from the Host header alone, whether a request belongs
 * to the dashboard or to the apps side. The rules are deliberately strict so a
 * crafted Host can never land an app request on the dashboard (or the other
 * way round):
 *  - the Host is lower-cased and trailing dots are stripped before matching
 *    (`X.Apps.Localhost.:3041` is the same host as `x.apps.localhost:3041`);
 *  - a syntactically invalid Host (bad characters, a non-numeric port such as
 *    `…:3041.attacker`) is `invalid` → 400, never the dashboard;
 *  - the port must match APPS_DOMAIN's port exactly (no port in APPS_DOMAIN →
 *    no port, :80 or :443 accepted); a mismatch under APPS_DOMAIN is a 404 on
 *    the apps side, not the dashboard;
 *  - the dashboard host (PUBLIC_APP_URL) wins first, so a dashboard that lives
 *    at the apex of APPS_DOMAIN (drobek.app + *.drobek.app) keeps working;
 *  - ANY other host at or under APPS_DOMAIN is the apps side — a malformed
 *    label (`a.b.<domain>`, `x--beta.<domain>`, a reserved slug) is still
 *    answered by the apps handler (404), never by the dashboard.
 */

export type AppHostTarget =
  | { kind: 'prod'; slug: string }
  | { kind: 'preview'; slug: string }
  | { kind: 'version'; slug: string; number: number };

export type HostClass =
  | { side: 'dashboard' }
  /** `target` null = a host under APPS_DOMAIN that names no valid app host → 404. */
  | { side: 'apps'; target: AppHostTarget | null }
  | { side: 'invalid' };

interface SplitHost {
  hostname: string;
  port: string | null;
}

// A hostname (letters, digits, dashes, underscores, dots) or a bracketed IPv6
// literal, then an optional numeric port. Nothing else is a Host we answer.
const HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)(?::(\d{1,5}))?$/;

/** Lower-case, strip trailing dots, split host/port. null → syntactically invalid. */
export function splitHost(raw: string | null | undefined): SplitHost | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > 260) return null;
  const m = HOST_RE.exec(value);
  if (!m) return null;
  const hostname = m[1].startsWith('[') ? m[1] : m[1].replace(/\.+$/, '');
  if (hostname.length === 0 || hostname.startsWith('.') || hostname.includes('..')) return null;
  const port = m[2] ?? null;
  if (port !== null && (Number(port) < 1 || Number(port) > 65535)) return null;
  return { hostname, port };
}

function portMatches(expected: string | null, actual: string | null): boolean {
  if (expected === null) return actual === null || actual === '80' || actual === '443';
  return actual === expected;
}

function sameHost(a: SplitHost, b: SplitHost): boolean {
  return a.hostname === b.hostname && portMatches(b.port, a.port);
}

/** Slug grammar (mirrors @drobek/apps APP_SLUG_RE + length limits). */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MIN = 3;
const SLUG_MAX = 40;
/** `--v<N>`: a positive integer without leading zeros, at most 9 digits. */
const LABEL_RE = /^([a-z0-9-]+?)(?:--(preview|v([1-9][0-9]{0,8})))?$/;

/**
 * Parse ONE host label into an app target. null for anything that is not a
 * well-formed `<slug>`, `<slug>--preview` or `<slug>--v<N>`. Reserved slugs are
 * NOT filtered here (no app can own one, so the lookup 404s anyway).
 */
export function parseAppLabel(label: string): AppHostTarget | null {
  const m = LABEL_RE.exec(label);
  if (!m) return null;
  const slug = m[1];
  if (slug.length < SLUG_MIN || slug.length > SLUG_MAX || !SLUG_RE.test(slug)) return null;
  if (m[2] === 'preview') return { kind: 'preview', slug };
  if (m[3] !== undefined) return { kind: 'version', slug, number: Number(m[3]) };
  return { kind: 'prod', slug };
}

export interface HostConfig {
  /** APPS_DOMAIN, e.g. `drobek.app` or `apps.localhost:3041`. */
  appsDomain: string;
  /** The dashboard's host (+ port), from PUBLIC_APP_URL, e.g. `drobek.app`. */
  dashboardHost: string | null;
}

/** Which side of drobek a Host header belongs to (see the module comment). */
export function classifyHost(rawHost: string | null | undefined, config: HostConfig): HostClass {
  const host = splitHost(rawHost);
  if (!host) return { side: 'invalid' };

  const dashboard = config.dashboardHost ? splitHost(config.dashboardHost) : null;
  if (dashboard && sameHost(host, dashboard)) return { side: 'dashboard' };

  const apps = splitHost(config.appsDomain);
  if (!apps) return { side: 'dashboard' };
  const suffix = `.${apps.hostname}`;
  const under = host.hostname === apps.hostname || host.hostname.endsWith(suffix);
  if (!under) return { side: 'dashboard' };
  // At or under APPS_DOMAIN: always the apps side, whatever else is wrong.
  if (!portMatches(apps.port, host.port) || host.hostname === apps.hostname) {
    return { side: 'apps', target: null };
  }
  const label = host.hostname.slice(0, -suffix.length);
  // Exactly one label in front of APPS_DOMAIN; deeper names are not app hosts.
  if (label.includes('.')) return { side: 'apps', target: null };
  return { side: 'apps', target: parseAppLabel(label) };
}

/**
 * True when an `Origin` header value names a host at or under APPS_DOMAIN
 * (the dashboard's own origin excluded) — used by the dashboard's CSRF check.
 */
export function isAppsOrigin(origin: string, config: HostConfig): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const cls = classifyHost(url.host, config);
  return cls.side === 'apps';
}

/** The canonical host string of a target, e.g. `x--v3.drobek.app`. */
export function appHostOf(target: AppHostTarget, appsDomain: string): string {
  const label =
    target.kind === 'prod'
      ? target.slug
      : target.kind === 'preview'
        ? `${target.slug}--preview`
        : `${target.slug}--v${target.number}`;
  return `${label}.${appsDomain}`;
}
