import { describe, expect, it } from 'vitest';
import { ProxyError } from './errors.js';
import {
  assertMethodAllowed,
  assertPathAllowed,
  buildTargetUrl,
  normalizeForwardPath,
  resolveForwardTarget,
  normalizeMethods,
  normalizePrefixes,
  pathMatchesPrefix,
  validateBaseUrl,
  effectivePort,
  proxyAllowedPorts,
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

describe('backslashes never escape the upstream (NSO-322 R2)', () => {
  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (err) {
      return err instanceof ProxyError ? err.code : 'not-a-proxy-error';
    }
    return undefined;
  };
  const BASE = 'https://api.example.com/v1';

  it('rejects a raw or encoded backslash in any segment', () => {
    for (const raw of ['\\evil.com/x', '/\\evil.com/x', 'a/..\\..\\admin', 'a\\b', 'a%5cb', 'a%5Cb', '%5C%5Cevil.com/x', 'x/%5c..%5C/admin', 'ok/..%5c']) {
      expect(codeOf(() => normalizeForwardPath(raw)), raw).toBe('path_not_allowed');
      expect(codeOf(() => resolveForwardTarget(BASE, raw, '', ['/'])), raw).toBe('path_not_allowed');
    }
  });

  it('rejects raw control characters (the URL parser drops tab / CR / LF)', () => {
    expect(codeOf(() => normalizeForwardPath('a/.\t./admin'))).toBe('path_not_allowed');
    expect(codeOf(() => normalizeForwardPath('a/b\nc'))).toBe('path_not_allowed');
  });

  it('buildTargetUrl refuses a result off the base origin or base path', () => {
    // What the old join produced for these (the WHATWG parser reads `\` as `/`):
    expect(new URL('/\\evil.com/x', 'https://api.example.com').origin).toBe('https://evil.com');
    expect(codeOf(() => buildTargetUrl('https://api.example.com', '/\\evil.com/x', ''))).toBe('path_not_allowed');
    expect(codeOf(() => buildTargetUrl(BASE, '/..\\..\\admin', ''))).toBe('path_not_allowed');
    expect(codeOf(() => buildTargetUrl(BASE, '/../admin', ''))).toBe('path_not_allowed');
    expect(codeOf(() => buildTargetUrl('https://api.example.com/v1', '/', ''))).toBeUndefined();
  });

  it('checks the allowed prefixes against the parsed target path', () => {
    expect(resolveForwardTarget(BASE, 'users/1', '?q=1', ['/users']).href).toBe('https://api.example.com/v1/users/1?q=1');
    expect(codeOf(() => resolveForwardTarget(BASE, 'admin', '', ['/users']))).toBe('path_not_allowed');
    expect(resolveForwardTarget(BASE, '', '', ['/']).href).toBe('https://api.example.com/v1/');
  });

  it('legitimate encoded characters still pass', () => {
    expect(resolveForwardTarget(BASE, 'search/hello%20world', '', ['/search']).pathname).toBe('/v1/search/hello%20world');
    expect(resolveForwardTarget(BASE, 'files/a%2Bb%40c.txt', '', ['/files']).pathname).toBe('/v1/files/a%2Bb%40c.txt');
    expect(resolveForwardTarget(BASE, 'names/%C4%8Dau', '', ['/names']).pathname).toBe('/v1/names/%C4%8Dau');
    expect(resolveForwardTarget('https://api.example.com', 'a/b', '', ['/a']).href).toBe('https://api.example.com/a/b');
  });
});

describe('port allow-list (PHY-76 #8, NSO-297)', () => {
  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (err) {
      return err instanceof ProxyError ? err.code : 'not-a-proxy-error';
    }
    return undefined;
  };

  it('accepts the default ports 80 and 443 (implicit or explicit)', () => {
    expect(validateBaseUrl('https://api.example.com').normalized).toBe('https://api.example.com');
    expect(validateBaseUrl('http://api.example.com:80/v1').normalized).toBe('http://api.example.com/v1');
    expect(validateBaseUrl('https://api.example.com:443').normalized).toBe('https://api.example.com');
    expect(validateBaseUrl('http://api.example.com:443').normalized).toBe('http://api.example.com:443');
  });

  it('rejects any other port at registration with invalid_request', () => {
    for (const url of [
      'https://api.example.com:8080',
      'http://scan-target.example:6379',
      'http://x.example:22',
      'https://x.example:8443',
    ]) {
      expect(codeOf(() => validateBaseUrl(url)), url).toBe('invalid_request');
    }
    expect(() => validateBaseUrl('https://api.example.com:8080')).toThrow(
      /port 8080 is not allowed \(allowed: 80, 443\)/
    );
  });

  it('PROXY_ALLOWED_PORTS replaces the list; junk falls back to 80/443, never "any"', () => {
    const env = { PROXY_ALLOWED_PORTS: '443, 8443' } as NodeJS.ProcessEnv;
    expect(validateBaseUrl('https://x.example:8443', env).normalized).toBe('https://x.example:8443');
    expect(codeOf(() => validateBaseUrl('http://x.example', env))).toBe('invalid_request');
    const junk = proxyAllowedPorts({ PROXY_ALLOWED_PORTS: 'x, 0, 70000' } as NodeJS.ProcessEnv);
    expect([...junk].sort((a, b) => a - b)).toEqual([80, 443]);
    expect([...proxyAllowedPorts({} as NodeJS.ProcessEnv)].sort((a, b) => a - b)).toEqual([80, 443]);
  });

  it('effectivePort: explicit port, else the scheme default', () => {
    expect(effectivePort(new URL('https://x.example'))).toBe(443);
    expect(effectivePort(new URL('http://x.example'))).toBe(80);
    expect(effectivePort(new URL('http://x.example:8099'))).toBe(8099);
  });
});
