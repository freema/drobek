/**
 * Sessions live in REDIS, not Postgres (ratified U2 + PHY-70 — the `sessions`
 * table in docs/TECHNICAL_DESIGN.md §1 is stale drift; do NOT create it).
 *
 * Key `drobek:session:<token>`, value JSON {userId, email, createdAt},
 * token = randomBytes(48) hex. Rolling 30-day TTL — refreshed (GETEX) on
 * every authenticated access. Cookie `drobek_session`: HttpOnly; Path=/;
 * SameSite=Lax (always — drobek has no iframe embedding); Secure only when
 * NODE_ENV=production; Max-Age 30 days.
 */
import { randomBytes } from 'node:crypto';
import { redirect } from 'react-router';
import { getRedis } from '@drobek/core';
import { SESSION_COOKIE, SESSION_MAX_AGE_SEC } from './constants.js';

export type SessionUser = {
  id: string;
  email: string;
};

interface SessionRecord {
  userId: string;
  email: string;
  createdAt: string;
}

/** randomBytes(48).toString('hex') → exactly 96 lowercase hex chars. */
const TOKEN_RE = /^[0-9a-f]{96}$/;

function sessionKey(token: string): string {
  return `drobek:session:${token}`;
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k || rest.length === 0) continue;
    out[k] = decodeURIComponent(rest.join('=').trim());
  }
  return out;
}

export function readSessionToken(request: Request): string | null {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const token = cookies[SESSION_COOKIE] ?? null;
  // Never build Redis keys from arbitrary cookie payloads.
  return token && TOKEN_RE.test(token) ? token : null;
}

export function sessionCookieHeader(
  token: string,
  opts: { maxAgeSec: number; clear?: boolean }
): string {
  const secure = process.env.NODE_ENV === 'production';
  const parts = [
    `${SESSION_COOKIE}=${opts.clear ? '' : encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    // Always Lax — drobek has no third-party iframe embedding (unlike puls).
    'SameSite=Lax',
    secure ? 'Secure' : '',
    opts.clear ? 'Max-Age=0' : `Max-Age=${opts.maxAgeSec}`,
  ].filter(Boolean);
  return parts.join('; ');
}

export async function getSessionUser(
  request: Request
): Promise<SessionUser | null> {
  const token = readSessionToken(request);
  if (!token) return null;

  // GETEX refreshes the rolling 30-day TTL atomically with the read.
  const raw = await getRedis().getex(
    sessionKey(token),
    'EX',
    SESSION_MAX_AGE_SEC
  );
  if (!raw) return null;

  let rec: SessionRecord;
  try {
    rec = JSON.parse(raw) as SessionRecord;
  } catch {
    await getRedis().del(sessionKey(token));
    return null;
  }
  if (!rec.userId || !rec.email) return null;
  return { id: rec.userId, email: rec.email };
}

export async function requireSessionUser(
  request: Request
): Promise<SessionUser> {
  const user = await getSessionUser(request);
  if (!user) throw redirect('/login');
  return user;
}

export async function createUserSession(
  userId: string,
  email: string
): Promise<{ token: string; setCookie: string }> {
  const token = randomBytes(48).toString('hex');
  const rec: SessionRecord = {
    userId,
    email,
    createdAt: new Date().toISOString(),
  };
  await getRedis().set(
    sessionKey(token),
    JSON.stringify(rec),
    'EX',
    SESSION_MAX_AGE_SEC
  );
  return {
    token,
    setCookie: sessionCookieHeader(token, { maxAgeSec: SESSION_MAX_AGE_SEC }),
  };
}

export async function destroySession(request: Request): Promise<string> {
  const token = readSessionToken(request);
  if (token) {
    await getRedis().del(sessionKey(token));
  }
  return sessionCookieHeader('', { maxAgeSec: 0, clear: true });
}
