import { describe, expect, it } from 'vitest';
import { cookieName, hostCookieHeader, readCookieValue, secureCookies } from './cookies.js';

const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

describe('dashboard cookie mode', () => {
  it('__Host- + Secure in production (whatever the origin) and whenever the dashboard is https', () => {
    expect(secureCookies(env({ NODE_ENV: 'production', PUBLIC_APP_URL: 'https://drobek.app' }))).toBe(true);
    expect(secureCookies(env({ NODE_ENV: 'production', PUBLIC_APP_URL: 'http://10.0.0.5:3041' }))).toBe(true);
    expect(secureCookies(env({ NODE_ENV: 'production' }))).toBe(true);
    expect(secureCookies(env({ NODE_ENV: 'development', PUBLIC_APP_URL: 'https://drobek.test' }))).toBe(true);
    expect(secureCookies(env({ NODE_ENV: 'development', PUBLIC_ORIGIN: 'https://drobek.test' }))).toBe(true);
  });

  it('plain-http dev drops the prefix (browsers refuse __Host- on http://localhost)', () => {
    expect(secureCookies(env({ NODE_ENV: 'development', PUBLIC_APP_URL: 'http://localhost:3041' }))).toBe(false);
    expect(secureCookies(env({ NODE_ENV: 'test' }))).toBe(false);
    expect(cookieName('drobek_session', env({ NODE_ENV: 'test' }))).toBe('drobek_session');
    expect(cookieName('drobek_session', env({ NODE_ENV: 'production' }))).toBe('__Host-drobek_session');
  });

  it('refuses an already-prefixed base name', () => {
    expect(() => cookieName('__Host-drobek_session')).toThrow();
  });

  it('builds the header: never a Domain, Secure only in secure mode', () => {
    const prod = hostCookieHeader('drobek_x', 'v', { maxAgeSec: 60 }, env({ NODE_ENV: 'production' }));
    expect(prod).toBe('__Host-drobek_x=v; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=60');
    const dev = hostCookieHeader('drobek_x', 'v', { maxAgeSec: 60 }, env({ NODE_ENV: 'development' }));
    expect(dev).toBe('drobek_x=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60');
    const cleared = hostCookieHeader('drobek_x', 'v', { maxAgeSec: 60, clear: true }, env({ NODE_ENV: 'production' }));
    expect(cleared).toBe('__Host-drobek_x=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0');
    for (const h of [prod, dev, cleared]) expect(h.toLowerCase()).not.toContain('domain=');
  });

  it('readCookieValue matches the exact name only', () => {
    expect(readCookieValue('a=1; __Host-a=2; b=3', '__Host-a')).toBe('2');
    expect(readCookieValue('a=1; __Host-a=2', 'a')).toBe('1');
    expect(readCookieValue(null, 'a')).toBeNull();
  });
});
