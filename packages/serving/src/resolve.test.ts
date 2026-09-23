import { describe, expect, it } from 'vitest';
import {
  ENTRY_HTML,
  IMMUTABLE_CACHE,
  REVALIDATE_CACHE,
  cacheControlFor,
  decodeRequestPath,
  etagFor,
  isNotModified,
  normalizeRequestPath,
  resolveServePath,
  type RoutingMode,
} from './resolve.js';

const MANIFEST = new Set([
  'index.html',
  'assets/app-abc123.js',
  'assets/style.css',
  'nested/index.html',
]);
const has = (p: string) => MANIFEST.has(p);

describe('normalizeRequestPath', () => {
  it('maps the bare / trailing-slash form to a directory index.html', () => {
    expect(normalizeRequestPath('')).toBe('index.html');
    expect(normalizeRequestPath('/')).toBe('index.html');
    expect(normalizeRequestPath('nested/')).toBe('nested/index.html');
  });

  it('strips a leading slash and collapses doubles', () => {
    expect(normalizeRequestPath('/assets/app.js')).toBe('assets/app.js');
    expect(normalizeRequestPath('assets//app.js')).toBe('assets/app.js');
  });

  it('rejects traversal', () => {
    expect(normalizeRequestPath('../secret')).toBeNull();
    expect(normalizeRequestPath('a/../../b')).toBeNull();
    expect(normalizeRequestPath('a/./b')).toBeNull();
  });
});

describe('resolveServePath — exact hits', () => {
  const base = { has, routingMode: 'exact' as RoutingMode };

  it('serves the entry for the bare app path', () => {
    expect(resolveServePath({ ...base, requestPath: '' })).toEqual({
      kind: 'file',
      path: 'index.html',
      isEntry: true,
    });
  });

  it('serves an exact asset (not an entry)', () => {
    expect(
      resolveServePath({ ...base, requestPath: 'assets/app-abc123.js' })
    ).toEqual({ kind: 'file', path: 'assets/app-abc123.js', isEntry: false });
  });

  it('marks a non-root index.html as an entry too', () => {
    expect(resolveServePath({ ...base, requestPath: 'nested/' })).toEqual({
      kind: 'file',
      path: 'nested/index.html',
      isEntry: true,
    });
  });
});

describe('resolveServePath — exact mode misses → 404', () => {
  it('404s an unknown extensionless route', () => {
    expect(
      resolveServePath({ has, routingMode: 'exact', requestPath: 'dashboard' })
    ).toEqual({ kind: 'not-found' });
  });
  it('404s a missing asset', () => {
    expect(
      resolveServePath({ has, routingMode: 'exact', requestPath: 'missing.js' })
    ).toEqual({ kind: 'not-found' });
  });
});

describe('resolveServePath — spa fallback', () => {
  it('falls back to index.html for an extensionless client route', () => {
    expect(
      resolveServePath({ has, routingMode: 'spa', requestPath: 'dashboard' })
    ).toEqual({ kind: 'file', path: ENTRY_HTML, isEntry: true });
    expect(
      resolveServePath({ has, routingMode: 'spa', requestPath: 'users/42' })
    ).toEqual({ kind: 'file', path: ENTRY_HTML, isEntry: true });
  });

  it('does NOT fall back for a missing ASSET (has an extension) → 404', () => {
    expect(
      resolveServePath({ has, routingMode: 'spa', requestPath: 'missing.js' })
    ).toEqual({ kind: 'not-found' });
    expect(
      resolveServePath({ has, routingMode: 'spa', requestPath: 'img/gone.png' })
    ).toEqual({ kind: 'not-found' });
  });

  it('404s a traversal attempt', () => {
    expect(
      resolveServePath({ has, routingMode: 'spa', requestPath: '../../etc/passwd' })
    ).toEqual({ kind: 'not-found' });
  });
});

describe('cacheControlFor', () => {
  const cc = (path: string, query = '', isPrivate = false) => cacheControlFor({ path, query, isPrivate });

  it('HTML always revalidates: public, max-age=0, must-revalidate', () => {
    expect(REVALIDATE_CACHE).toBe('public, max-age=0, must-revalidate');
    expect(cc('index.html')).toBe(REVALIDATE_CACHE);
    expect(cc('index.html', 'v=0123456789abcdef')).toBe(REVALIDATE_CACHE);
  });

  it('JS/CSS without a hash query revalidate (the name is stable across versions)', () => {
    expect(cc('main.js')).toBe(REVALIDATE_CACHE);
    expect(cc('main.css')).toBe(REVALIDATE_CACHE);
    expect(cc('main.js', 'v=2')).toBe(REVALIDATE_CACHE);
    expect(cc('main.js', 'a=1&b=2')).toBe(REVALIDATE_CACHE);
  });

  it('JS/CSS with a hash query are immutable', () => {
    expect(IMMUTABLE_CACHE).toBe('public, max-age=31536000, immutable');
    expect(cc('main.js', 'v=3f9a0c1d')).toBe(IMMUTABLE_CACHE);
    expect(cc('main.css', 'h=3f9a0c1d2e')).toBe(IMMUTABLE_CACHE);
    expect(cc('app.mjs', '3f9a0c1d2e4b')).toBe(IMMUTABLE_CACHE);
  });

  it('other assets revalidate even with a hash query', () => {
    expect(cc('logo.png', 'v=3f9a0c1d')).toBe(REVALIDATE_CACHE);
  });

  it('a password-protected app is never publicly cacheable', () => {
    expect(cc('index.html', '', true)).toBe('private, max-age=0, must-revalidate');
    expect(cc('main.js', 'v=3f9a0c1d', true)).toBe('private, max-age=31536000, immutable');
  });
});

describe('decodeRequestPath', () => {
  it('percent-decodes each segment', () => {
    expect(decodeRequestPath('/img/my%20photo.png')).toBe('/img/my photo.png');
  });

  it('rejects encoded separators, NUL and malformed escapes', () => {
    expect(decodeRequestPath('/a%2f..%2fetc')).toBeNull();
    expect(decodeRequestPath('/a%5c..')).toBeNull();
    expect(decodeRequestPath('/a%00')).toBeNull();
    expect(decodeRequestPath('/%E0%A4%A')).toBeNull();
  });

  it('decoded dot segments are still refused by normalizeRequestPath', () => {
    expect(normalizeRequestPath(decodeRequestPath('/%2e%2e/secret')!)).toBeNull();
  });
});

describe('etag / conditional GET', () => {
  const etag = etagFor('a'.repeat(64));

  it('quotes the sha256 as a strong validator', () => {
    expect(etag).toBe(`"${'a'.repeat(64)}"`);
  });

  it('304s on an exact / weak / wildcard match', () => {
    expect(isNotModified(etag, etag)).toBe(true);
    expect(isNotModified(`W/${etag}`, etag)).toBe(true);
    expect(isNotModified('*', etag)).toBe(true);
    expect(isNotModified(`"other", ${etag}`, etag)).toBe(true);
  });

  it('does not 304 on a mismatch or absent header', () => {
    expect(isNotModified(null, etag)).toBe(false);
    expect(isNotModified('"nope"', etag)).toBe(false);
  });
});
