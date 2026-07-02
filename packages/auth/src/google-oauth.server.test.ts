import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GOOGLE_OAUTH_STATE_COOKIE } from './constants.js';
import {
  buildGoogleAuthUrl,
  generateOAuthState,
  getGoogleOAuthConfig,
  GOOGLE_DEFAULT_AUTH_URL,
  GOOGLE_DEFAULT_TOKEN_URL,
  GOOGLE_DEFAULT_USERINFO_URL,
  isGoogleLoginEnabled,
  oauthStatesMatch,
  readStateCookie,
  stateCookieHeader,
} from './google-oauth.server.js';

describe('getGoogleOAuthConfig', () => {
  it('returns null when GOOGLE_CLIENT_ID is missing/empty (feature gated off)', () => {
    expect(getGoogleOAuthConfig({})).toBeNull();
    expect(
      getGoogleOAuthConfig({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: 's' })
    ).toBeNull();
    expect(
      getGoogleOAuthConfig({
        GOOGLE_CLIENT_ID: '   ',
        GOOGLE_CLIENT_SECRET: 's',
      })
    ).toBeNull();
    expect(isGoogleLoginEnabled({})).toBe(false);
  });

  it('returns null when the secret is missing (half-configured = off)', () => {
    expect(getGoogleOAuthConfig({ GOOGLE_CLIENT_ID: 'id' })).toBeNull();
  });

  it('defaults the three URLs to the real Google endpoints', () => {
    const cfg = getGoogleOAuthConfig({
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
    });
    expect(cfg).not.toBeNull();
    expect(cfg?.authUrl).toBe(GOOGLE_DEFAULT_AUTH_URL);
    expect(cfg?.tokenUrl).toBe(GOOGLE_DEFAULT_TOKEN_URL);
    expect(cfg?.userinfoUrl).toBe(GOOGLE_DEFAULT_USERINFO_URL);
  });

  it('builds redirectUri from PUBLIC_ORIGIN (default localhost:3041, trailing slash stripped)', () => {
    const base = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' };
    expect(getGoogleOAuthConfig(base)?.redirectUri).toBe(
      'http://localhost:3041/auth/google/callback'
    );
    expect(
      getGoogleOAuthConfig({ ...base, PUBLIC_ORIGIN: 'https://drobek.app/' })
        ?.redirectUri
    ).toBe('https://drobek.app/auth/google/callback');
  });

  it('honours env URL overrides (mock provider wiring)', () => {
    const cfg = getGoogleOAuthConfig({
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_AUTH_URL: 'http://localhost:3049/authorize',
      GOOGLE_TOKEN_URL: 'http://host.docker.internal:3049/token',
      GOOGLE_USERINFO_URL: 'http://host.docker.internal:3049/userinfo',
    });
    expect(cfg?.authUrl).toBe('http://localhost:3049/authorize');
    expect(cfg?.tokenUrl).toBe('http://host.docker.internal:3049/token');
    expect(cfg?.userinfoUrl).toBe('http://host.docker.internal:3049/userinfo');
  });
});

describe('oauth state generation + validation', () => {
  it('generates 48 lowercase hex chars, unique per call', () => {
    const a = generateOAuthState();
    const b = generateOAuthState();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(b).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });

  it('matches only the exact same well-formed state', () => {
    const s = generateOAuthState();
    expect(oauthStatesMatch(s, s)).toBe(true);
    expect(oauthStatesMatch(s, generateOAuthState())).toBe(false);
  });

  it('rejects missing or malformed values', () => {
    const s = generateOAuthState();
    expect(oauthStatesMatch(null, s)).toBe(false);
    expect(oauthStatesMatch(s, null)).toBe(false);
    expect(oauthStatesMatch(undefined, undefined)).toBe(false);
    expect(oauthStatesMatch('', '')).toBe(false);
    expect(oauthStatesMatch('nope', 'nope')).toBe(false); // not 48-hex
    expect(oauthStatesMatch('A'.repeat(48), 'A'.repeat(48))).toBe(false); // uppercase
  });
});

describe('state cookie helpers', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });
  afterEach(() => {
    process.env.NODE_ENV = prevNodeEnv;
  });

  it('sets a short-lived HttpOnly SameSite=Lax cookie', () => {
    const s = generateOAuthState();
    const header = stateCookieHeader(s);
    expect(header).toContain(`${GOOGLE_OAUTH_STATE_COOKIE}=${s}`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Max-Age=600');
    expect(header).not.toContain('Secure');
  });

  it('adds Secure in production', () => {
    process.env.NODE_ENV = 'production';
    expect(stateCookieHeader(generateOAuthState())).toContain('Secure');
  });

  it('clears with Max-Age=0 and an empty value', () => {
    const header = stateCookieHeader('', { clear: true });
    expect(header).toContain(`${GOOGLE_OAUTH_STATE_COOKIE}=;`);
    expect(header).toContain('Max-Age=0');
  });

  it('round-trips through readStateCookie', () => {
    const s = generateOAuthState();
    const req = new Request('http://localhost/auth/google/callback', {
      headers: { Cookie: `foo=bar; ${GOOGLE_OAUTH_STATE_COOKIE}=${s}; x=y` },
    });
    expect(readStateCookie(req)).toBe(s);
    expect(oauthStatesMatch(s, readStateCookie(req))).toBe(true);
  });

  it('returns null when the cookie is absent', () => {
    expect(readStateCookie(new Request('http://localhost/'))).toBeNull();
    const req = new Request('http://localhost/', {
      headers: { Cookie: 'foo=bar' },
    });
    expect(readStateCookie(req)).toBeNull();
  });
});

describe('buildGoogleAuthUrl', () => {
  it('carries client_id, redirect_uri, code flow, openid scopes, state and select_account', () => {
    const url = new URL(
      buildGoogleAuthUrl({
        authUrl: GOOGLE_DEFAULT_AUTH_URL,
        clientId: 'client-1',
        redirectUri: 'http://localhost:3041/auth/google/callback',
        state: 'f'.repeat(48),
      })
    );
    expect(url.origin + url.pathname).toBe(GOOGLE_DEFAULT_AUTH_URL);
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3041/auth/google/callback'
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe('f'.repeat(48));
    expect(url.searchParams.get('prompt')).toBe('select_account');
  });

  it('respects a custom (mock) authorize URL', () => {
    const url = buildGoogleAuthUrl({
      authUrl: 'http://localhost:3049/authorize',
      clientId: 'c',
      redirectUri: 'http://localhost:3041/auth/google/callback',
      state: 'a'.repeat(48),
    });
    expect(url.startsWith('http://localhost:3049/authorize?')).toBe(true);
  });
});
