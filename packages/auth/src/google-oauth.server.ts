/**
 * Google OIDC login (U3, PHY-53) — env-driven and config-gated:
 * - Empty GOOGLE_CLIENT_ID (or SECRET) disables the feature entirely — the
 *   login-page button is hidden and /auth/google bounces to /login. Prod is
 *   safe when unconfigured.
 * - The three provider URLs default to the REAL Google endpoints and are
 *   overridable via env so the e2e mock provider (tests-e2e/mock-google.mjs)
 *   can stand in. This is configuration, not a code seam — ROADMAP §4
 *   explicitly rejects compiled-in test bypasses.
 * - redirect_uri is built from PUBLIC_ORIGIN (dev default http://localhost:3041)
 *   + /auth/google/callback.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  GOOGLE_OAUTH_STATE_COOKIE,
  GOOGLE_OAUTH_STATE_MAX_AGE_SEC,
} from './constants.js';

export const GOOGLE_DEFAULT_AUTH_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_DEFAULT_USERINFO_URL =
  'https://www.googleapis.com/oauth2/v3/userinfo';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  /** PUBLIC_ORIGIN + /auth/google/callback (origin trailing slashes stripped). */
  redirectUri: string;
}

/** What the provider asserts about the signed-in Google account. */
export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
}

/**
 * Returns null when the feature is unconfigured (empty/missing client id or
 * secret) — callers MUST treat null as "Google login does not exist".
 */
export function getGoogleOAuthConfig(
  env: NodeJS.ProcessEnv = process.env
): GoogleOAuthConfig | null {
  const clientId = (env.GOOGLE_CLIENT_ID ?? '').trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;

  const origin = ((env.PUBLIC_ORIGIN ?? '').trim() || 'http://localhost:3041')
    // strip trailing slashes so redirectUri never gets a double slash
    .replace(/\/+$/, '');

  return {
    clientId,
    clientSecret,
    authUrl: (env.GOOGLE_AUTH_URL ?? '').trim() || GOOGLE_DEFAULT_AUTH_URL,
    tokenUrl: (env.GOOGLE_TOKEN_URL ?? '').trim() || GOOGLE_DEFAULT_TOKEN_URL,
    userinfoUrl:
      (env.GOOGLE_USERINFO_URL ?? '').trim() || GOOGLE_DEFAULT_USERINFO_URL,
    redirectUri: `${origin}/auth/google/callback`,
  };
}

export function isGoogleLoginEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return getGoogleOAuthConfig(env) !== null;
}

// ── CSRF state (cookie ↔ callback param exact match) ─────────────────────────

/** randomBytes(24).toString('hex') → exactly 48 lowercase hex chars. */
const STATE_RE = /^[0-9a-f]{48}$/;

export function generateOAuthState(): string {
  return randomBytes(24).toString('hex');
}

/**
 * Exact match of the callback `state` param against the cookie value.
 * Both must be well-formed (48 hex chars); compare is constant-time.
 */
export function oauthStatesMatch(
  param: string | null | undefined,
  cookie: string | null | undefined
): boolean {
  if (!param || !cookie) return false;
  if (!STATE_RE.test(param) || !STATE_RE.test(cookie)) return false;
  return timingSafeEqual(Buffer.from(param), Buffer.from(cookie));
}

export function stateCookieHeader(
  state: string,
  opts: { clear?: boolean } = {}
): string {
  const secure = process.env.NODE_ENV === 'production';
  const parts = [
    `${GOOGLE_OAUTH_STATE_COOKIE}=${opts.clear ? '' : encodeURIComponent(state)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    opts.clear ? 'Max-Age=0' : `Max-Age=${GOOGLE_OAUTH_STATE_MAX_AGE_SEC}`,
  ].filter(Boolean);
  return parts.join('; ');
}

export function readStateCookie(request: Request): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === GOOGLE_OAUTH_STATE_COOKIE && rest.length > 0) {
      return decodeURIComponent(rest.join('=').trim());
    }
  }
  return null;
}

// ── Provider round-trips ──────────────────────────────────────────────────────

export function buildGoogleAuthUrl(args: {
  authUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(args.authUrl);
  url.searchParams.set('client_id', args.clientId);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', args.state);
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export async function exchangeGoogleAuthCode(args: {
  tokenUrl: string;
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ accessToken: string }> {
  const body = new URLSearchParams({
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await fetch(args.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    // Status only — never echo the request (it carries the client secret).
    throw new Error(`google token exchange failed: ${res.status}`);
  }

  const j = (await res.json()) as { access_token?: string };
  if (!j.access_token) {
    throw new Error('google token response missing access_token');
  }
  return { accessToken: j.access_token };
}

export async function fetchGoogleUserInfo(args: {
  userinfoUrl: string;
  accessToken: string;
}): Promise<GoogleIdentity> {
  const res = await fetch(args.userinfoUrl, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`google userinfo failed: ${res.status}`);
  }

  const j = (await res.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean | string;
  };

  if (!j.sub || !j.email) {
    throw new Error('google userinfo missing sub/email');
  }

  return {
    sub: String(j.sub),
    email: String(j.email),
    // Some IdP-shaped providers stringify booleans — accept "true" only.
    emailVerified: j.email_verified === true || j.email_verified === 'true',
  };
}
