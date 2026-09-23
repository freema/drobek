/**
 * Dashboard cookies (M0-06). The apps live on sibling hosts of the SAME
 * registrable domain (`<slug>.drobek.app` next to `drobek.app`), so in
 * production every dashboard cookie is a `__Host-` cookie: the browser only
 * accepts it with Secure, Path=/ and NO Domain attribute — it lives on exactly
 * the dashboard host, is never sent to an app host, and an app host cannot
 * overwrite or shadow it with a Domain cookie ("cookie tossing").
 *
 * Plain-http development (NODE_ENV ≠ production AND an http dashboard origin,
 * e.g. http://localhost:3041) drops the prefix and Secure: browsers refuse a
 * `__Host-` cookie on http://localhost, so the dev stack could not sign in
 * otherwise. The cookie stays host-only (no Domain) in both modes.
 */
import { dashboardOrigin } from '@drobek/apps';

const HOST_PREFIX = '__Host-';

/** `__Host-` + Secure cookies: always in production, and whenever the dashboard is https. */
export function secureCookies(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') return true;
  return dashboardOrigin(env).startsWith('https:');
}

/** The on-the-wire name of dashboard cookie `base` (`__Host-<base>` when secure). */
export function cookieName(base: string, env: NodeJS.ProcessEnv = process.env): string {
  if (base.startsWith(HOST_PREFIX)) throw new Error(`pass the base cookie name, not ${base}`);
  return secureCookies(env) ? `${HOST_PREFIX}${base}` : base;
}

/**
 * Build a dashboard Set-Cookie value for cookie `base`: HttpOnly, SameSite=Lax,
 * Path=/, no Domain; `__Host-` + Secure when `secureCookies(env)`.
 */
export function hostCookieHeader(
  base: string,
  value: string,
  opts: { maxAgeSec: number; clear?: boolean },
  env: NodeJS.ProcessEnv = process.env
): string {
  const secure = secureCookies(env);
  return [
    `${cookieName(base, env)}=${opts.clear ? '' : value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    opts.clear ? 'Max-Age=0' : `Max-Age=${opts.maxAgeSec}`,
  ].join('; ');
}

/** The raw value of cookie `name` from a Cookie header, or null. */
export function readCookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
