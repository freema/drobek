import { describe, expect, it } from 'vitest';
import {
  DEV_APPS_DOMAIN,
  appsOrigin,
  appsOriginConfigError,
  previewUrl,
  publishedUrl,
} from './origin.js';

describe('apps origin (APPS_DOMAIN)', () => {
  it('builds https preview + published URLs for a real domain', () => {
    const env = { APPS_DOMAIN: 'drobek.app', NODE_ENV: 'production' };
    expect(previewUrl('todo', env)).toBe('https://todo--preview.drobek.app');
    expect(publishedUrl('todo', env)).toBe('https://todo.drobek.app');
    expect(appsOriginConfigError(env)).toBeNull();
  });

  it('defaults to apps.localhost:3041 over http outside production', () => {
    expect(appsOrigin({})).toEqual({ domain: DEV_APPS_DOMAIN, scheme: 'http' });
    expect(previewUrl('todo', {})).toBe('http://todo--preview.apps.localhost:3041');
  });

  it('refuses to start in production without APPS_DOMAIN', () => {
    expect(appsOriginConfigError({ NODE_ENV: 'production' })).toMatch(/APPS_DOMAIN is not set/);
  });

  it.each(['https://drobek.app', 'drobek.app/x', '-bad.app', 'a..b', 'x.app:99999', 'x y'])(
    'rejects APPS_DOMAIN=%s',
    (value) => {
      expect(appsOriginConfigError({ APPS_DOMAIN: value })).toMatch(/APPS_DOMAIN must be/);
      expect(() => appsOrigin({ APPS_DOMAIN: value })).toThrow();
    }
  );

  it('APPS_URL_SCHEME overrides the default, and must be http or https', () => {
    expect(previewUrl('a1b', { APPS_DOMAIN: 'apps.localhost', APPS_URL_SCHEME: 'https' })).toBe(
      'https://a1b--preview.apps.localhost'
    );
    expect(previewUrl('a1b', { APPS_DOMAIN: 'Apps.Example.COM' })).toBe(
      'https://a1b--preview.apps.example.com'
    );
    expect(appsOriginConfigError({ APPS_URL_SCHEME: 'ftp' })).toMatch(/APPS_URL_SCHEME/);
  });

  it('an empty APPS_URL_SCHEME / APPS_DOMAIN counts as unset (compose passes `${X:-}` as "")', () => {
    expect(appsOriginConfigError({ APPS_DOMAIN: 'apps.localhost:3041', APPS_URL_SCHEME: '' })).toBeNull();
    expect(previewUrl('a1b', { APPS_DOMAIN: 'apps.localhost:3041', APPS_URL_SCHEME: '' })).toBe(
      'http://a1b--preview.apps.localhost:3041'
    );
    expect(previewUrl('a1b', { APPS_DOMAIN: 'drobek.app', APPS_URL_SCHEME: '  ' })).toBe(
      'https://a1b--preview.drobek.app'
    );
    expect(previewUrl('a1b', { APPS_DOMAIN: '' })).toBe('http://a1b--preview.apps.localhost:3041');
  });
});
