import { describe, expect, it } from 'vitest';
import {
  DEV_APPS_DOMAIN,
  appsOrigin,
  appsOriginConfigError,
  hostConfig,
  pathRouting,
  previewUrl,
  publishedUrl,
  versionUrl,
} from './origin.js';

describe('apps origin (APPS_DOMAIN)', () => {
  it('builds https preview + published URLs for a real domain', () => {
    const env = { APPS_DOMAIN: 'drobek.app', NODE_ENV: 'production' };
    expect(previewUrl('todo', env)).toBe('https://todo--preview.drobek.app');
    expect(publishedUrl('todo', env)).toBe('https://todo.drobek.app');
    expect(appsOriginConfigError(env)).toBeNull();
  });

  it('defaults to apps.localhost:3041 over http outside production', () => {
    expect(appsOrigin({})).toEqual({ domain: DEV_APPS_DOMAIN, scheme: 'http', mode: 'subdomain' });
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

describe('apps origin (APPS_ROUTING_MODE=path)', () => {
  const PATH = {
    APPS_ROUTING_MODE: 'path',
    APPS_BASE_URL: 'https://apps-xyz.up.railway.app',
    PUBLIC_APP_URL: 'https://drobek-abc.up.railway.app',
    NODE_ENV: 'production',
  };

  it('builds every app address under /apps/<label> of APPS_BASE_URL', () => {
    expect(appsOriginConfigError(PATH)).toBeNull();
    expect(appsOrigin(PATH)).toEqual({ domain: 'apps-xyz.up.railway.app', scheme: 'https', mode: 'path' });
    expect(pathRouting(PATH)).toBe(true);
    expect(publishedUrl('notes', PATH)).toBe('https://apps-xyz.up.railway.app/apps/notes');
    expect(previewUrl('notes', PATH)).toBe('https://apps-xyz.up.railway.app/apps/notes--preview');
    expect(versionUrl('notes', 7, PATH)).toBe('https://apps-xyz.up.railway.app/apps/notes--v7');
    expect(hostConfig(PATH)).toMatchObject({ appsDomain: 'apps-xyz.up.railway.app', mode: 'path' });
  });

  it('stays subdomain routing by default', () => {
    const env = { APPS_DOMAIN: 'drobek.app', NODE_ENV: 'production' };
    expect(pathRouting(env)).toBe(false);
    expect(hostConfig(env)).not.toHaveProperty('mode');
  });

  it('refuses an unknown mode', () => {
    expect(appsOriginConfigError({ ...PATH, APPS_ROUTING_MODE: 'paths' })).toMatch(/APPS_ROUTING_MODE/);
  });

  it('refuses a missing, non-origin or insecure APPS_BASE_URL', () => {
    expect(appsOriginConfigError({ ...PATH, APPS_BASE_URL: '' })).toMatch(/APPS_BASE_URL is not set/);
    for (const bad of [
      'apps.example.com',
      'https://apps.example.com/x',
      'https://apps.example.com/?a=1',
      'https://user:pw@apps.example.com',
      'ftp://apps.example.com',
      'javascript:alert(1)',
    ]) {
      expect(appsOriginConfigError({ ...PATH, APPS_BASE_URL: bad }), bad).toMatch(/APPS_BASE_URL/);
    }
    expect(appsOriginConfigError({ ...PATH, APPS_BASE_URL: 'http://apps.example.com' })).toMatch(/https in production/);
    expect(appsOriginConfigError({ ...PATH, NODE_ENV: 'development', APPS_BASE_URL: 'http://apps.localhost:3041', PUBLIC_APP_URL: 'http://localhost:3041' })).toBeNull();
  });

  it('refuses the dashboard host as the apps host (any port)', () => {
    expect(appsOriginConfigError({ ...PATH, APPS_BASE_URL: 'https://drobek-abc.up.railway.app' })).toMatch(/another host than the dashboard/);
    expect(appsOriginConfigError({ ...PATH, APPS_BASE_URL: 'https://drobek-abc.up.railway.app:8443' })).toMatch(/another host than the dashboard/);
    expect(appsOriginConfigError({ ...PATH, APPS_BASE_URL: 'https://DROBEK-ABC.up.railway.app' })).toMatch(/another host than the dashboard/);
  });

  it('refuses the subdomain-only variables', () => {
    expect(appsOriginConfigError({ ...PATH, APPS_DOMAIN: 'apps.example.com' })).toMatch(/APPS_DOMAIN does not apply/);
    expect(appsOriginConfigError({ ...PATH, APPS_URL_SCHEME: 'https' })).toMatch(/APPS_URL_SCHEME does not apply/);
  });
});
