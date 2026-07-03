import { describe, expect, it } from 'vitest';
import { APP_CSP, appResponseHeaders, baseSecurityHeaders } from './csp.js';

describe('APP_CSP', () => {
  it('locks default/connect to self and blocks the dangerous primitives', () => {
    expect(APP_CSP).toContain("default-src 'self'");
    expect(APP_CSP).toContain("connect-src 'self'");
    expect(APP_CSP).toContain("object-src 'none'");
    expect(APP_CSP).toContain("base-uri 'self'");
    expect(APP_CSP).toContain("frame-ancestors 'self'");
  });

  it('allows inline scripts/styles (static vibecoded apps need it)', () => {
    expect(APP_CSP).toContain("script-src 'self' 'unsafe-inline'");
    expect(APP_CSP).toContain("style-src 'self' 'unsafe-inline'");
  });
});

describe('baseSecurityHeaders', () => {
  it('always sets nosniff + CSP', () => {
    const h = baseSecurityHeaders();
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Content-Security-Policy']).toBe(APP_CSP);
  });
});

describe('appResponseHeaders', () => {
  it('carries the content type, etag, cache-control and length', () => {
    const h = appResponseHeaders({
      contentType: 'text/html; charset=utf-8',
      etag: '"deadbeef"',
      cacheControl: 'no-cache',
      contentLength: 42,
    });
    expect(h['Content-Type']).toBe('text/html; charset=utf-8');
    expect(h['ETag']).toBe('"deadbeef"');
    expect(h['Cache-Control']).toBe('no-cache');
    expect(h['Content-Length']).toBe('42');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
  });

  it('omits Content-Length when not given', () => {
    const h = appResponseHeaders({
      contentType: 'text/css',
      etag: '"x"',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    expect(h['Content-Length']).toBeUndefined();
  });
});
