import { describe, expect, it } from 'vitest';
import {
  loginReturnCookieHeader,
  readLoginReturnCookie,
  safeReturnPath,
} from './return-to.server.js';

describe('safeReturnPath', () => {
  it('accepts same-origin relative paths', () => {
    expect(safeReturnPath('/me')).toBe('/me');
    expect(safeReturnPath('/oauth/authorize?client_id=abc&state=xyz')).toBe(
      '/oauth/authorize?client_id=abc&state=xyz'
    );
  });

  it('rejects absolute and protocol-relative URLs (open-redirect guard)', () => {
    expect(safeReturnPath('https://evil.example')).toBeNull();
    expect(safeReturnPath('//evil.example')).toBeNull();
    expect(safeReturnPath('/\\evil.example')).toBeNull();
    expect(safeReturnPath('javascript:alert(1)')).toBeNull();
  });

  it('rejects header-splitting control characters', () => {
    expect(safeReturnPath('/me\r\nSet-Cookie: x=1')).toBeNull();
  });

  it('rejects empty / missing', () => {
    expect(safeReturnPath('')).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
  });
});

describe('login return cookie round-trip', () => {
  it('encodes and reads back a validated path', () => {
    const setCookie = loginReturnCookieHeader('/oauth/authorize?a=1&b=2');
    const cookieName = setCookie.split(';')[0];
    const req = new Request('http://localhost/login/verify', {
      headers: { Cookie: cookieName },
    });
    expect(readLoginReturnCookie(req)).toBe('/oauth/authorize?a=1&b=2');
  });

  it('returns null for an unsafe cookie value', () => {
    const req = new Request('http://localhost/login/verify', {
      headers: { Cookie: 'drobek_login_return=https%3A%2F%2Fevil.example' },
    });
    expect(readLoginReturnCookie(req)).toBeNull();
  });
});
