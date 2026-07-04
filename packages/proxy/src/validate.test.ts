import { describe, expect, it } from 'vitest';
import { ProxyError } from './errors.js';
import {
  assertMethodAllowed,
  assertPathAllowed,
  buildTargetUrl,
  normalizeForwardPath,
  normalizeMethods,
  normalizePrefixes,
  pathMatchesPrefix,
  validateBaseUrl,
} from './validate.js';

describe('normalizeMethods', () => {
  it('upper-cases + dedupes', () => {
    expect(normalizeMethods(['get', 'GET', 'post'])).toEqual(['GET', 'POST']);
  });
  it('rejects unknown + empty', () => {
    expect(() => normalizeMethods(['FROB'])).toThrow(ProxyError);
    expect(() => normalizeMethods([])).toThrow(ProxyError);
  });
});

describe('normalizePrefixes', () => {
  it('adds a leading slash + strips trailing', () => {
    expect(normalizePrefixes(['api/', 'v1'])).toEqual(['/api', '/v1']);
  });
  it('rejects a prefix with ".." + empty list', () => {
    expect(() => normalizePrefixes(['/a/../b'])).toThrow(ProxyError);
    expect(() => normalizePrefixes([''])).toThrow(ProxyError);
  });
});

describe('assertMethodAllowed', () => {
  it('allows a listed method (case-insensitive)', () => {
    expect(() => assertMethodAllowed('get', ['GET'])).not.toThrow();
  });
  it('rejects an unlisted method (405)', () => {
    try {
      assertMethodAllowed('DELETE', ['GET', 'POST']);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ProxyError);
      expect((e as ProxyError).code).toBe('method_not_allowed');
    }
  });
});

describe('normalizeForwardPath — traversal proof', () => {
  it('normalizes a plain subpath', () => {
    expect(normalizeForwardPath('users/42')).toBe('/users/42');
    expect(normalizeForwardPath('')).toBe('/');
    expect(normalizeForwardPath('a//b/./c')).toBe('/a/b/c');
  });
  it('rejects raw ".." traversal', () => {
    expect(() => normalizeForwardPath('a/../../etc/passwd')).toThrow(ProxyError);
  });
  it('rejects percent-encoded ".." and encoded slashes', () => {
    expect(() => normalizeForwardPath('a/%2e%2e/b')).toThrow(ProxyError);
    expect(() => normalizeForwardPath('a%2Fb')).toThrow(ProxyError);
  });
  it('does not false-positive a legit dotted filename', () => {
    expect(normalizeForwardPath('assets/app.v2.min.js')).toBe('/assets/app.v2.min.js');
  });
});

describe('assertPathAllowed + pathMatchesPrefix', () => {
  it('matches at a segment boundary (/api ⊄ /apix)', () => {
    expect(pathMatchesPrefix('/api', '/api')).toBe(true);
    expect(pathMatchesPrefix('/api/users', '/api')).toBe(true);
    expect(pathMatchesPrefix('/apixyz', '/api')).toBe(false);
  });
  it('allows an in-prefix path, rejects an out-of-prefix one (403)', () => {
    expect(() => assertPathAllowed('/api/users', ['/api'])).not.toThrow();
    try {
      assertPathAllowed('/secret', ['/api']);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ProxyError).code).toBe('path_not_allowed');
    }
  });
  it('a normalized ".." cannot escape the prefix (rejected before matching)', () => {
    // The router splat "/api/../secret" is rejected at normalization, never
    // reaching a bypass of the /api prefix.
    expect(() => normalizeForwardPath('api/../secret')).toThrow(ProxyError);
  });
});

describe('validateBaseUrl', () => {
  it('accepts an https public host + normalizes', () => {
    expect(validateBaseUrl('https://api.example.com/v1/').normalized).toBe(
      'https://api.example.com/v1'
    );
  });
  it('rejects non-http(s)', () => {
    expect(() => validateBaseUrl('ftp://x.com')).toThrow(ProxyError);
    expect(() => validateBaseUrl('file:///etc/passwd')).toThrow(ProxyError);
  });
  it('rejects credentials in the URL', () => {
    expect(() => validateBaseUrl('https://u:p@example.com')).toThrow(ProxyError);
  });
  it('rejects localhost + private IP literals at registration', () => {
    expect(() => validateBaseUrl('http://localhost:8080')).toThrow(ProxyError);
    expect(() => validateBaseUrl('http://127.0.0.1')).toThrow(ProxyError);
    expect(() => validateBaseUrl('http://10.0.0.5')).toThrow(ProxyError);
    expect(() => validateBaseUrl('http://169.254.169.254')).toThrow(ProxyError);
    expect(() => validateBaseUrl('http://[::1]')).toThrow(ProxyError);
  });
  it('accepts a public IP literal', () => {
    expect(() => validateBaseUrl('http://8.8.8.8')).not.toThrow();
  });
});

describe('buildTargetUrl', () => {
  it('joins base path + subpath + query without doubling slashes', () => {
    expect(buildTargetUrl('https://api.example.com/v1', '/users/1', '?x=1').href).toBe(
      'https://api.example.com/v1/users/1?x=1'
    );
    expect(buildTargetUrl('https://api.example.com', '/', '').href).toBe(
      'https://api.example.com/'
    );
  });
});
