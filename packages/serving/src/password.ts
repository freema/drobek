/**
 * App password hashing + the stateless app-access cookie (U7, PHY-58; M0-06).
 *
 * Dependency-light on purpose (only `node:crypto`).
 *
 * - App passwords (`apps.password_hash`) are stored scrypt-hashed with a random
 *   per-password salt. The plaintext is NEVER stored, returned, or logged.
 * - The app-access cookie is a stateless HMAC token binding the appId + expiry.
 *   It is signed with a key derived (HKDF) from DROBEK_MASTER_KEY under its own
 *   label, and under a distinct `appaccess.` prefix, so it can never be confused
 *   with any other token. The cookie is `__Host-` prefixed: Secure, Path=/, NO
 *   Domain — it lives on exactly the one app host that set it (a sibling app on
 *   the same registrable domain can neither read nor overwrite it).
 */
import { createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { appsOrigin } from '@drobek/apps';

// ── App password hashing (scrypt) ────────────────────────────────────────────

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (err, dk) => (err ? reject(err) : resolve(dk))
    );
  });
}

/** Hash an app password. Format: `scrypt$<saltHex>$<hashHex>`. */
export async function hashAppPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scryptAsync(password, salt);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

/** Constant-time verify against a stored `scrypt$…` hash. Any malformed / null → false. */
export async function verifyAppPassword(
  password: string,
  stored: string | null | undefined
): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
  let dk: Buffer;
  try {
    dk = await scryptAsync(password, salt);
  } catch {
    return false;
  }
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}

// ── App-access cookie (stateless HMAC token) ─────────────────────────────────

/** The app-access cookie name on https app hosts (and always in production). */
export const APP_ACCESS_COOKIE = '__Host-drobek_app_access';
/** The name on plain-http dev app hosts (browsers refuse `__Host-` over http). */
export const APP_ACCESS_COOKIE_INSECURE = 'drobek_app_access';

/** The app-access cookie name for the given mode (see appCookiesSecure). */
export function appAccessCookieName(secure: boolean): string {
  return secure ? APP_ACCESS_COOKIE : APP_ACCESS_COOKIE_INSECURE;
}

/**
 * `__Host-` + Secure app cookies: always in production, and whenever the apps
 * origin is https. Plain-http dev (`http://*.apps.localhost:3041`) drops both —
 * browsers refuse `__Host-` / Secure cookies there. Host-only either way.
 */
export function appCookiesSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') return true;
  try {
    return appsOrigin(env).scheme === 'https';
  } catch {
    return true;
  }
}
/** Password unlock lasts this long before the visitor must re-enter it. */
export const APP_ACCESS_TTL_SEC = 60 * 60 * 12; // 12h

interface AppAccessPayload {
  /** App this grant is bound to — a token is never valid for another app. */
  appId: string;
  /** Expiry, unix seconds. */
  exp: number;
}

function accessSign(payloadB64: string, secret: string): Buffer {
  // Domain separation from any other token signed with the same secret.
  return createHmac('sha256', secret).update(`appaccess.${payloadB64}`).digest();
}

export function mintAppAccessToken(
  appId: string,
  secret: string,
  ttlSec: number = APP_ACCESS_TTL_SEC,
  nowMs: number = Date.now()
): string {
  if (!secret) throw new Error('app-access secret must be a non-empty string');
  const payload: AppAccessPayload = {
    appId,
    exp: Math.floor(nowMs / 1000) + ttlSec,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url'
  );
  const sig = accessSign(payloadB64, secret).toString('base64url');
  return `${payloadB64}.${sig}`;
}

/** Verify an app-access token: shape → signature (constant-time) → appId → expiry. */
export function verifyAppAccessToken(
  token: string,
  appId: string,
  secret: string,
  nowMs: number = Date.now()
): boolean {
  if (!token || !secret) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;

  const expected = accessSign(parts[0], secret);
  let presented: Buffer;
  try {
    presented = Buffer.from(parts[1], 'base64url');
  } catch {
    return false;
  }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return false;
  }

  let payload: AppAccessPayload;
  try {
    payload = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString('utf8')
    ) as AppAccessPayload;
  } catch {
    return false;
  }
  if (!payload || typeof payload.appId !== 'string' || typeof payload.exp !== 'number') {
    return false;
  }
  if (payload.appId !== appId) return false;
  if (Math.floor(nowMs / 1000) >= payload.exp) return false;
  return true;
}

/**
 * `Set-Cookie` for the app-access token: host-only (`__Host-`, no Domain),
 * Secure, Path=/, HttpOnly, SameSite=Lax. `secure: false` (plain-http dev
 * only) drops the prefix and Secure; still host-only.
 */
export function appAccessCookieHeader(
  token: string,
  opts: { maxAgeSec?: number; clear?: boolean; secure?: boolean } = {}
): string {
  const secure = opts.secure ?? true;
  return [
    `${appAccessCookieName(secure)}=${opts.clear ? '' : token}`,
    'Path=/',
    ...(secure ? ['Secure'] : []),
    'HttpOnly',
    'SameSite=Lax',
    opts.clear ? 'Max-Age=0' : `Max-Age=${opts.maxAgeSec ?? APP_ACCESS_TTL_SEC}`,
  ].join('; ');
}

/**
 * The app-access signing key: HKDF-SHA256 over DROBEK_MASTER_KEY (64 hex chars)
 * with its own label. null when the master key is missing or malformed — the
 * gate then fails closed (nobody gets in, the unlock POST answers 500).
 */
export function appAccessSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.DROBEK_MASTER_KEY ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  const key = hkdfSync('sha256', Buffer.from(raw, 'hex'), Buffer.alloc(0), 'drobek/app-access/v1', 32);
  return Buffer.from(key).toString('hex');
}
