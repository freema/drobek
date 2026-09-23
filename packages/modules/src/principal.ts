/**
 * The caller of a module route (§5.0): core resolves it ONCE per request from
 * the app host's end-user session cookie and hands it to the module — a module
 * never reads a cookie itself, and the dashboard session is never read here.
 *
 * Cookie: `__Host-drobek_eu` (HttpOnly, Secure, SameSite=Lax, Path=/, no
 * Domain → host-only: a session of `a.<APPS_DOMAIN>` is never sent to
 * `b.<APPS_DOMAIN>`); plain-http dev uses `drobek_eu` (browsers refuse
 * `__Host-` there). Value: 64 hex chars.
 *
 * Session record: Redis `drobek:eu:<app_id>:<token>` = JSON
 * `{ id, email, role: 'user'|'admin' }`. The key embeds the app id, so a token
 * is only ever valid on the app that issued it. The end-user auth module
 * (M1-02) creates, renews and revokes these records with the helpers below.
 */
import { appsOrigin } from '@drobek/apps';
import type { Principal } from './contract.js';

export const END_USER_COOKIE = '__Host-drobek_eu';
export const END_USER_COOKIE_INSECURE = 'drobek_eu';
export const END_USER_TOKEN_RE = /^[0-9a-f]{64}$/;

/** `__Host-` + Secure end-user cookies: production, and any https apps origin. */
export function endUserCookiesSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') return true;
  try {
    return appsOrigin(env).scheme === 'https';
  } catch {
    return true;
  }
}

export function endUserCookieName(secure: boolean): string {
  return secure ? END_USER_COOKIE : END_USER_COOKIE_INSECURE;
}

export function endUserSessionKey(appId: string, token: string): string {
  return `drobek:eu:${appId}:${token}`;
}

export interface EndUserSession {
  id: string;
  email: string;
  role: 'user' | 'admin';
}

type RedisGet = { get(key: string): Promise<string | null> };

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function parseEndUserSession(raw: string | null): EndUserSession | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<EndUserSession>;
    if (typeof v.id !== 'string' || !v.id || typeof v.email !== 'string' || !v.email) return null;
    if (v.role !== 'user' && v.role !== 'admin') return null;
    return { id: v.id, email: v.email, role: v.role };
  } catch {
    return null;
  }
}

/** Resolves the caller of one request on one app. */
export type PrincipalResolver = (input: { appId: string; cookieHeader: string | null }) => Promise<Principal>;

/**
 * The default resolver: `drobek_eu` cookie → Redis session of THIS app → user;
 * anything missing, malformed, foreign or unreadable → anon (fail closed).
 */
export function cookiePrincipalResolver(opts: { redis: () => RedisGet; secure: boolean }): PrincipalResolver {
  const name = endUserCookieName(opts.secure);
  return async ({ appId, cookieHeader }) => {
    const token = readCookie(cookieHeader, name);
    if (!token || !END_USER_TOKEN_RE.test(token)) return { kind: 'anon' };
    let raw: string | null;
    try {
      raw = await opts.redis().get(endUserSessionKey(appId, token));
    } catch {
      return { kind: 'anon' };
    }
    const s = parseEndUserSession(raw);
    return s ? { kind: 'user', id: s.id, email: s.email, role: s.role } : { kind: 'anon' };
  };
}
