/**
 * Caddy's on-demand TLS `ask` endpoint (M0-07). Before Caddy obtains a
 * certificate for a host it has never seen, it asks
 * `GET <ask URL>?domain=<host>` and proceeds ONLY on a 2xx. drobek answers:
 *
 *   404  TLS_ASK_TOKEN unset/invalid (fail closed — no certificate for anyone)
 *   404  the request arrived on the PUBLIC dashboard host (the endpoint is for
 *        Caddy on the internal network: `http://drobek:3000/…`)
 *   401  missing or wrong token (`?token=` — Caddy's ask is a bare GET, so the
 *        token rides in the ask URL — or the `X-Drobek-Tls-Ask-Token` header)
 *   200  `domain` is `<slug>`, `<slug>--preview` or `<slug>--v<N>` directly
 *        under APPS_DOMAIN and a live, non-deleted app owns `<slug>`
 *   404  everything else: hosts outside APPS_DOMAIN, the dashboard host,
 *        APPS_DOMAIN itself, deeper names, malformed labels, unknown slugs.
 *        (Verified custom domains join the 200 set in M3-01.)
 *
 * `--v<N>` only checks that the app exists, not that version N does — a
 * certificate for a host that then 404s is harmless, and it keeps this a
 * single indexed slug lookup.
 *
 * Pure — the app lookup is injected (the Postgres one lives in
 * tls-ask.server.ts), so every branch is unit-tested without a database.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { classifyHost, splitHost, type HostConfig } from '@drobek/apps';
import { TLS_ASK_PATH, TLS_ASK_TOKEN_MIN_LENGTH, isValidTlsAskToken } from '@drobek/core';

export { TLS_ASK_PATH, TLS_ASK_TOKEN_MIN_LENGTH };
export const TLS_ASK_TOKEN_HEADER = 'x-drobek-tls-ask-token';

type TokenState = { ok: true; token: string } | { ok: false; error: string | null };

function readToken(env: NodeJS.ProcessEnv): TokenState {
  const raw = env.TLS_ASK_TOKEN?.trim();
  if (!raw) return { ok: false, error: null };
  if (!isValidTlsAskToken(raw)) {
    return {
      ok: false,
      error: `TLS_ASK_TOKEN must be at least ${TLS_ASK_TOKEN_MIN_LENGTH} URL-safe characters ([A-Za-z0-9_-]) — generate one with \`openssl rand -hex 32\``,
    };
  }
  return { ok: true, token: raw };
}

/** The configured ask token, or null (unset or invalid → the endpoint fails closed). */
export function tlsAskToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = readToken(env);
  return t.ok ? t.token : null;
}

/** Startup check: an error when TLS_ASK_TOKEN is SET but unusable; unset is fine. */
export function tlsAskConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = readToken(env);
  return !t.ok && t.error ? `drobek refuses to start: ${t.error}.` : null;
}

/** Constant-time token comparison (hashing first makes it length-independent too). */
export function tlsAskTokenMatches(expected: string, given: string | null | undefined): boolean {
  if (typeof given !== 'string' || given.length === 0) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(given).digest();
  return timingSafeEqual(a, b);
}

function withoutPort(host: string | null): string | null {
  if (!host) return null;
  const h = splitHost(host);
  return h ? h.hostname : null;
}

/**
 * The app slug an ask `domain` would serve, or null. Ports are ignored on both
 * sides: Caddy asks with the bare SNI name, while APPS_DOMAIN may carry a port
 * (e.g. `apps.localhost:8443` when the TLS port is not 443).
 */
export function tlsAskSlug(domain: string | null | undefined, hosts: HostConfig): string | null {
  if (typeof domain !== 'string') return null;
  const host = splitHost(domain);
  // The SNI name Caddy asks about never carries a port or an IPv6 literal.
  if (!host || host.port !== null || host.hostname.startsWith('[')) return null;
  const appsDomain = withoutPort(hosts.appsDomain);
  if (!appsDomain) return null;
  const cls = classifyHost(host.hostname, {
    appsDomain,
    dashboardHost: withoutPort(hosts.dashboardHost),
  });
  if (cls.side !== 'apps' || cls.target === null) return null;
  return cls.target.slug;
}

export interface TlsAskInput {
  /** The `domain` query parameter. */
  domain: string | null;
  /** `?token=` or the X-Drobek-Tls-Ask-Token header. */
  token: string | null;
  /** The Host the ask request arrived on. */
  requestHost: string | null;
}

export interface TlsAskDeps {
  /** From TLS_ASK_TOKEN; null → fail closed. */
  expectedToken: string | null;
  hosts: HostConfig;
  /** True when a live, non-deleted app owns this slug. */
  appExists: (slug: string) => Promise<boolean>;
}

export type TlsAskStatus = 200 | 401 | 404;

export async function decideTlsAsk(input: TlsAskInput, deps: TlsAskDeps): Promise<TlsAskStatus> {
  if (!deps.expectedToken) return 404;
  // Never answered on the public dashboard host (Caddy also blocks
  // /api/internal/* on every public site).
  const reqHost = splitHost(input.requestHost);
  const dashboard = splitHost(deps.hosts.dashboardHost);
  if (!reqHost) return 404;
  if (dashboard && reqHost.hostname === dashboard.hostname) return 404;
  if (!tlsAskTokenMatches(deps.expectedToken, input.token)) return 401;
  const slug = tlsAskSlug(input.domain, deps.hosts);
  if (!slug) return 404;
  return (await deps.appExists(slug)) ? 200 : 404;
}
