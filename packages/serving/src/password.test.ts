import { describe, expect, it } from 'vitest';
import {
  APP_ACCESS_COOKIE,
  appAccessCookieHeader,
  appCookiesSecure,
  appAccessSecret,
  hashAppPassword,
  mintAppAccessToken,
  verifyAppAccessToken,
  verifyAppPassword,
} from './password.js';

const SECRET = 'test-secret-000';

describe('app password hashing', () => {
  it('verifies the correct password and rejects the wrong one', async () => {
    const hash = await hashAppPassword('correct horse');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyAppPassword('correct horse', hash)).toBe(true);
    expect(await verifyAppPassword('wrong', hash)).toBe(false);
  });

  it('uses a random salt (two hashes of the same password differ)', async () => {
    const a = await hashAppPassword('same');
    const b = await hashAppPassword('same');
    expect(a).not.toBe(b);
    expect(await verifyAppPassword('same', a)).toBe(true);
    expect(await verifyAppPassword('same', b)).toBe(true);
  });

  it('rejects malformed / null stored hashes', async () => {
    expect(await verifyAppPassword('x', null)).toBe(false);
    expect(await verifyAppPassword('x', '')).toBe(false);
    expect(await verifyAppPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyAppPassword('x', 'scrypt$zz$zz')).toBe(false);
  });
});

describe('app-access token', () => {
  it('round-trips for the bound app', () => {
    const token = mintAppAccessToken('app_1', SECRET);
    expect(verifyAppAccessToken(token, 'app_1', SECRET)).toBe(true);
  });

  it('is NOT valid for a different app', () => {
    const token = mintAppAccessToken('app_1', SECRET);
    expect(verifyAppAccessToken(token, 'app_2', SECRET)).toBe(false);
  });

  it('is rejected under a different secret (bad signature)', () => {
    const token = mintAppAccessToken('app_1', SECRET);
    expect(verifyAppAccessToken(token, 'app_1', 'other-secret')).toBe(false);
  });

  it('is rejected once expired', () => {
    const now = Date.now();
    const token = mintAppAccessToken('app_1', SECRET, 100, now);
    expect(verifyAppAccessToken(token, 'app_1', SECRET, now + 101_000)).toBe(false);
  });

  it('rejects garbage tokens', () => {
    expect(verifyAppAccessToken('', 'app_1', SECRET)).toBe(false);
    expect(verifyAppAccessToken('a.b.c', 'app_1', SECRET)).toBe(false);
    expect(verifyAppAccessToken('nope', 'app_1', SECRET)).toBe(false);
  });
});

describe('appAccessCookieHeader', () => {
  it('is a host-only __Host- cookie: Secure, Path=/, no Domain, HttpOnly, Lax', () => {
    const h = appAccessCookieHeader('tok');
    expect(APP_ACCESS_COOKIE).toBe('__Host-drobek_app_access');
    expect(h).toBe(`${APP_ACCESS_COOKIE}=tok; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200`);
    expect(h.toLowerCase()).not.toContain('domain=');
  });

  it('plain-http dev (secure: false) drops the prefix and Secure; still host-only', () => {
    expect(appAccessCookieHeader('tok', { secure: false })).toBe(
      'drobek_app_access=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200'
    );
  });

  it('appCookiesSecure: production always, otherwise only for an https apps origin', () => {
    const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;
    expect(appCookiesSecure(env({ NODE_ENV: 'production', APPS_DOMAIN: 'apps.localhost:3041' }))).toBe(true);
    expect(appCookiesSecure(env({ NODE_ENV: 'development', APPS_DOMAIN: 'apps.example.com' }))).toBe(true);
    expect(appCookiesSecure(env({ NODE_ENV: 'development', APPS_DOMAIN: 'apps.localhost:3041' }))).toBe(false);
    expect(appCookiesSecure(env({ NODE_ENV: 'development' }))).toBe(false);
  });

  it('clears with Max-Age=0', () => {
    const h = appAccessCookieHeader('', { clear: true });
    expect(h).toContain('Max-Age=0');
  });
});

describe('appAccessSecret', () => {
  it('derives a stable key from DROBEK_MASTER_KEY, distinct from the key itself', () => {
    const env = { DROBEK_MASTER_KEY: 'ab'.repeat(32) };
    const a = appAccessSecret(env);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(appAccessSecret(env)).toBe(a);
    expect(a).not.toBe('ab'.repeat(32));
    expect(appAccessSecret({ DROBEK_MASTER_KEY: 'cd'.repeat(32) })).not.toBe(a);
  });

  it('is null (fail closed) without a well-formed master key', () => {
    expect(appAccessSecret({})).toBeNull();
    expect(appAccessSecret({ DROBEK_MASTER_KEY: 'short' })).toBeNull();
  });
});
