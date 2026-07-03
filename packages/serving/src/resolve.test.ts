import { describe, expect, it } from 'vitest';
import {
  ENTRY_HTML,
  IMMUTABLE_CACHE,
  REVALIDATE_CACHE,
  cacheControlFor,
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
  it('revalidates the entry document', () => {
    expect(cacheControlFor(true)).toEqual({
      cacheControl: REVALIDATE_CACHE,
      immutable: false,
    });
  });
  it('immutably caches every other asset', () => {
    expect(cacheControlFor(false)).toEqual({
      cacheControl: IMMUTABLE_CACHE,
      immutable: true,
    });
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
