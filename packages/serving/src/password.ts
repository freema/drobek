/**
 * App password hashing + the stateless app-access cookie (U7, PHY-58).
 *
 * Dependency-light on purpose (only `node:crypto`) so it can be imported from a
 * thin react-router route with no db/redis pulled in.
 *
 * - App passwords (`apps.password_hash`) are stored scrypt-hashed with a random
 *   per-password salt. The plaintext is NEVER stored, returned, or logged.
 * - The app-access cookie is a stateless HMAC token binding the appId + expiry.
 *   It is signed with UPLOAD_SIGNING_SECRET (already required stack-wide) under
 *   a distinct `appaccess.` domain-separation prefix so it can never be confused
 *   with an upload token. The cookie is HttpOnly and PATH-SCOPED to the app so
 *   it is not sent to the dashboard or to other apps.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

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

export const APP_ACCESS_COOKIE = 'drobek_app_access';
/** Password unlock lasts this long before the visitor must re-enter it. */
export const APP_ACCESS_TTL_SEC = 60 * 60 * 12; // 12h

interface AppAccessPayload {
  /** App this grant is bound to — a token is never valid for another app. */
  appId: string;
  /** Expiry, unix seconds. */
  exp: number;
}

function accessSign(payloadB64: string, secret: string): Buffer {
  // Domain separation from upload tokens which reuse the same HMAC secret.
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
 * Path-scoped `Set-Cookie` for the app-access token. `path` MUST be the app
 * root (`/:ws/app/:slug`) so the browser only replays it on that app's paths —
 * never the dashboard and never a sibling app.
 */
export function appAccessCookieHeader(
  token: string,
  opts: { path: string; maxAgeSec?: number; clear?: boolean }
): string {
  const secure = process.env.NODE_ENV === 'production';
  const parts = [
    `${APP_ACCESS_COOKIE}=${opts.clear ? '' : token}`,
    `Path=${opts.path}`,
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    opts.clear ? 'Max-Age=0' : `Max-Age=${opts.maxAgeSec ?? APP_ACCESS_TTL_SEC}`,
  ].filter(Boolean);
  return parts.join('; ');
}
