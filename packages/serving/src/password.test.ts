import { describe, expect, it } from 'vitest';
import {
  APP_ACCESS_COOKIE,
  appAccessCookieHeader,
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
  it('is HttpOnly and path-scoped to the app', () => {
    const h = appAccessCookieHeader('tok', { path: '/acme/app/site' });
    expect(h.startsWith(`${APP_ACCESS_COOKIE}=tok`)).toBe(true);
    expect(h).toContain('Path=/acme/app/site');
    expect(h).toContain('HttpOnly');
    expect(h).toContain('SameSite=Lax');
  });

  it('clears with Max-Age=0', () => {
    const h = appAccessCookieHeader('', { path: '/acme/app/site', clear: true });
    expect(h).toContain('Max-Age=0');
  });
});
