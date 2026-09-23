/**
 * The caller of a module route (§5.0): core resolves it ONCE per request from
 * the app host's end-user session cookie and hands it to the module — a module
 * never reads a cookie itself, and the dashboard session is never read here.
 * The platform module `auth` (M1-02) is the only writer: it creates, renews
 * and ends these sessions with the helpers below, so every other module gets
 * `user` / `admin` principals from `ctx.principal` without importing auth.
 *
 * Cookie: `__Host-drobek_eu` (HttpOnly, Secure, SameSite=Lax, Path=/, no
 * Domain → host-only: a session of `a.<APPS_DOMAIN>` is never sent to
 * `b.<APPS_DOMAIN>`, and the preview host `<slug>--preview.…` has its own
 * sign-in); plain-http dev uses `drobek_eu` (browsers refuse `__Host-` and
 * even `Secure` there). Value: 64 hex chars.
 *
 * Session record: Redis `drobek:eu:<app_id>:<token>` = JSON
 * `{ id, email, role: 'user'|'admin', epoch }`, TTL 30 days, rolled forward
 * by the auth module on every `me`. The key embeds the app id, so a token is
 * only ever valid on the app that issued it.
 *
 * Mass revocation (PHY-76 #9): `drobek:eu-epoch:<app_id>` (absent = 0). A
 * session is valid only while its `epoch` equals the app's current epoch;
 * `revokeEndUserSessions()` increments it, which signs every end user of the
 * app out at once (the owner's dashboard API, M1-02).
 *
 * The Redis record alone is NEVER trusted as the principal: core asks the
 * module that owns end-user sessions (`endUsers.current`, the auth module)
 * who the user is NOW on every module request that carries a live session.
 * Disabled / deleted / no longer allowed → anonymous and the session is
 * deleted; a changed role applies to that same request. No cache: a change
 * takes effect on the next request.
 */
import { randomBytes } from 'node:crypto';
import { appsOrigin } from '@drobek/apps';
import type { EndUser, HookApp, Principal } from './contract.js';

export const END_USER_COOKIE = '__Host-drobek_eu';
export const END_USER_COOKIE_INSECURE = 'drobek_eu';
export const END_USER_TOKEN_RE = /^[0-9a-f]{64}$/;
/** Session lifetime: 30 days, rolling. */
export const END_USER_SESSION_TTL_SEC = 30 * 24 * 60 * 60;

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

/**
 * The end-user Set-Cookie value: host-only (no Domain), Path=/, HttpOnly,
 * SameSite=Lax; `__Host-` + Secure when `secure`. `clear` expires it.
 */
export function endUserCookieHeader(token: string, opts: { maxAgeSec: number; clear?: boolean }, secure: boolean): string {
  return [
    `${endUserCookieName(secure)}=${opts.clear ? '' : token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    opts.clear ? 'Max-Age=0' : `Max-Age=${opts.maxAgeSec}`,
  ].join('; ');
}

export function endUserSessionKey(appId: string, token: string): string {
  return `drobek:eu:${appId}:${token}`;
}

export function endUserEpochKey(appId: string): string {
  return `drobek:eu-epoch:${appId}`;
}

export interface EndUserSession {
  id: string;
  email: string;
  role: 'user' | 'admin';
  /** The app's epoch when the session was issued. */
  epoch: number;
}

/** The Redis subset the session helpers use (ioredis-compatible). */
export interface EndUserRedis {
  mget(...keys: string[]): Promise<(string | null)[]>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The end-user token of a Cookie header, or null (never a malformed value). */
export function readEndUserToken(cookieHeader: string | null, secure: boolean): string | null {
  const token = readCookie(cookieHeader, endUserCookieName(secure));
  return token && END_USER_TOKEN_RE.test(token) ? token : null;
}

export function parseEndUserSession(raw: string | null): EndUserSession | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<EndUserSession>;
    if (typeof v.id !== 'string' || !v.id || typeof v.email !== 'string' || !v.email) return null;
    if (v.role !== 'user' && v.role !== 'admin') return null;
    if (typeof v.epoch !== 'number' || !Number.isInteger(v.epoch) || v.epoch < 0) return null;
    return { id: v.id, email: v.email, role: v.role, epoch: v.epoch };
  } catch {
    return null;
  }
}

function epochOf(raw: string | null): number {
  const n = Number(raw ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** The live session of `token` on `appId`: present, well-formed and of the current epoch — else null. */
export async function loadEndUserSession(redis: Pick<EndUserRedis, 'mget'>, appId: string, token: string): Promise<EndUserSession | null> {
  if (!END_USER_TOKEN_RE.test(token)) return null;
  const [raw, epoch] = await redis.mget(endUserSessionKey(appId, token), endUserEpochKey(appId));
  const s = parseEndUserSession(raw);
  return s && s.epoch === epochOf(epoch) ? s : null;
}

/** Start a session for a verified end user of `appId` (current epoch, 30 days) → the token. */
export async function createEndUserSession(
  redis: Pick<EndUserRedis, 'get' | 'set'>,
  appId: string,
  user: { id: string; email: string; role: 'user' | 'admin' }
): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const epoch = epochOf(await redis.get(endUserEpochKey(appId)));
  const record: EndUserSession = { id: user.id, email: user.email, role: user.role, epoch };
  await redis.set(endUserSessionKey(appId, token), JSON.stringify(record), 'EX', END_USER_SESSION_TTL_SEC);
  return token;
}

/** Roll a live session forward another 30 days (and store a changed role). */
export async function renewEndUserSession(
  redis: Pick<EndUserRedis, 'set'>,
  appId: string,
  token: string,
  session: EndUserSession
): Promise<void> {
  await redis.set(endUserSessionKey(appId, token), JSON.stringify(session), 'EX', END_USER_SESSION_TTL_SEC);
}

export async function destroyEndUserSession(redis: Pick<EndUserRedis, 'del'>, appId: string, token: string): Promise<void> {
  if (END_USER_TOKEN_RE.test(token)) await redis.del(endUserSessionKey(appId, token));
}

/** Sign every end user of `appId` out (PHY-76 #9) → the new epoch. */
export async function revokeEndUserSessions(redis: Pick<EndUserRedis, 'incr'>, appId: string): Promise<number> {
  return redis.incr(endUserEpochKey(appId));
}

/** Resolves the caller of one request on one app. */
export type PrincipalResolver = (input: { app: HookApp; cookieHeader: string | null }) => Promise<Principal>;

/** Who the user of a live session is NOW (null → the session ends). See EndUserAuthority. */
export type CurrentEndUser = (app: HookApp, user: EndUser) => Promise<EndUser | null>;

/**
 * The default resolver: end-user cookie → a live session of THIS app (current
 * epoch) → `current(app, user)` → user with the CURRENT role. Anything
 * missing, malformed, foreign, revoked or unreadable → anon (fail closed); no
 * `current` (no module owns sessions) → anon. `current` answering null ends
 * the session (deleted from Redis); `current` throwing → anon for this
 * request only.
 */
export function cookiePrincipalResolver(opts: {
  redis: () => Pick<EndUserRedis, 'mget' | 'del'>;
  secure: boolean;
  current: CurrentEndUser | null;
}): PrincipalResolver {
  return async ({ app, cookieHeader }) => {
    const token = readEndUserToken(cookieHeader, opts.secure);
    if (!token || !opts.current) return { kind: 'anon' };
    let s: EndUserSession | null;
    try {
      s = await loadEndUserSession(opts.redis(), app.id, token);
    } catch {
      return { kind: 'anon' };
    }
    if (!s) return { kind: 'anon' };
    let now: EndUser | null;
    try {
      now = await opts.current(app, { id: s.id, email: s.email, role: s.role });
    } catch {
      return { kind: 'anon' };
    }
    if (!now || now.id !== s.id) {
      try {
        await destroyEndUserSession(opts.redis(), app.id, token);
      } catch {
        // the session is refused either way
      }
      return { kind: 'anon' };
    }
    return { kind: 'user', id: now.id, email: now.email, role: now.role };
  };
}
