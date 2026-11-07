import { describe, expect, it } from 'vitest';
import { appHostOf, appTargetOfUrl, classifyHost, isAppsOrigin, parseAppLabel, parseAppPath, splitHost } from './host.js';

const DEV = { appsDomain: 'apps.localhost:3041', dashboardHost: 'localhost:3041' };
/** The owner's production shape: dashboard on the apex, apps on its subdomains. */
const PROD = { appsDomain: 'drobek.app', dashboardHost: 'drobek.app' };

describe('parseAppLabel', () => {
  it('parses the three host forms', () => {
    expect(parseAppLabel('shift-planner')).toEqual({ kind: 'prod', slug: 'shift-planner' });
    expect(parseAppLabel('shift-planner--preview')).toEqual({ kind: 'preview', slug: 'shift-planner' });
    expect(parseAppLabel('shift-planner--v12')).toEqual({ kind: 'version', slug: 'shift-planner', number: 12 });
  });

  it('rejects malformed labels', () => {
    for (const bad of [
      'ab', // too short
      'a'.repeat(41),
      'x--beta',
      'abc--v0',
      'abc--v01',
      'abc--v1234567890',
      'abc--',
      '-abc',
      'abc-',
      'a--b--preview',
      'abc--preview--v1',
      'abc_def',
      '',
    ]) {
      expect(parseAppLabel(bad), bad).toBeNull();
    }
  });
});

describe('splitHost', () => {
  it('lower-cases, strips trailing dots, splits the port', () => {
    expect(splitHost('X.Apps.Localhost.:3041')).toEqual({ hostname: 'x.apps.localhost', port: '3041' });
    expect(splitHost('drobek.app')).toEqual({ hostname: 'drobek.app', port: null });
  });

  it('rejects junk', () => {
    for (const bad of [null, undefined, '', ' ', 'a b', 'x.app:3041.attacker', 'x.app:99999', 'x..app', '.x.app', 'x.app/evil', 'user@x.app']) {
      expect(splitHost(bad as string | null), String(bad)).toBeNull();
    }
  });
});

describe('classifyHost (dev: apps.localhost:3041, dashboard localhost:3041)', () => {
  it('dispatches the three app host forms, port included', () => {
    expect(classifyHost('shop--preview.apps.localhost:3041', DEV)).toEqual({
      side: 'apps',
      target: { kind: 'preview', slug: 'shop' },
    });
    expect(classifyHost('shop.apps.localhost:3041', DEV)).toEqual({ side: 'apps', target: { kind: 'prod', slug: 'shop' } });
    expect(classifyHost('shop--v1.apps.localhost:3041', DEV)).toEqual({
      side: 'apps',
      target: { kind: 'version', slug: 'shop', number: 1 },
    });
  });

  it('is case- and trailing-dot-insensitive', () => {
    expect(classifyHost('SHOP--Preview.Apps.LOCALHOST.:3041', DEV)).toEqual({
      side: 'apps',
      target: { kind: 'preview', slug: 'shop' },
    });
  });

  it('the dashboard host is the dashboard', () => {
    expect(classifyHost('localhost:3041', DEV)).toEqual({ side: 'dashboard' });
    expect(classifyHost('LOCALHOST:3041', DEV)).toEqual({ side: 'dashboard' });
  });

  it('anything under APPS_DOMAIN that is not a valid app host is a 404 on the APPS side, never the dashboard', () => {
    for (const host of [
      'apps.localhost:3041', // the apex of APPS_DOMAIN
      'a.b.apps.localhost:3041', // two labels deep
      'x--beta.apps.localhost:3041',
      'ab.apps.localhost:3041', // slug too short
      'shop.apps.localhost:9999', // wrong port
      'shop.apps.localhost', // no port where APPS_DOMAIN has one
    ]) {
      expect(classifyHost(host, DEV), host).toEqual({ side: 'apps', target: null });
    }
  });

  it('a crafted Host never becomes an app host of drobek', () => {
    expect(classifyHost('shop--preview.apps.localhost:3041.attacker', DEV)).toEqual({ side: 'invalid' });
    // Not ours: at most a custom-domain CANDIDATE, which serving resolves through
    // the domains table (unknown → the dashboard, as before).
    expect(classifyHost('shop--preview.apps.localhost.attacker.com:3041', DEV)).toEqual({
      side: 'custom',
      hostname: 'shop--preview.apps.localhost.attacker.com',
    });
    expect(classifyHost('evilapps.localhost:3041', DEV)).toEqual({ side: 'dashboard' });
    expect(classifyHost(null, DEV)).toEqual({ side: 'invalid' });
    expect(classifyHost('', DEV)).toEqual({ side: 'invalid' });
  });

  it('internal hosts (health checks) are the dashboard', () => {
    expect(classifyHost('127.0.0.1:3000', DEV)).toEqual({ side: 'dashboard' });
    expect(classifyHost('[::1]:3000', DEV)).toEqual({ side: 'dashboard' });
  });

  it('a dotted public name on the apps port is a custom-domain candidate', () => {
    expect(classifyHost('firma.test:3041', DEV)).toEqual({ side: 'custom', hostname: 'firma.test' });
    expect(classifyHost('Shop.Firma.CZ.:3041', DEV)).toEqual({ side: 'custom', hostname: 'shop.firma.cz' });
  });

  it('internal names, loopback, IPs and other ports are never candidates', () => {
    for (const host of ['drobek:3000', 'localhost:3000', 'x.localhost:3041', '10.0.0.7:3041', '[::1]:3041', 'firma.test:3000', 'firma.test']) {
      expect(classifyHost(host, DEV), host).toEqual({ side: 'dashboard' });
    }
  });
});

describe('classifyHost (prod: dashboard on the apex of APPS_DOMAIN)', () => {
  it('the apex is the dashboard, every subdomain is an app host', () => {
    expect(classifyHost('drobek.app', PROD)).toEqual({ side: 'dashboard' });
    expect(classifyHost('drobek.app.', PROD)).toEqual({ side: 'dashboard' });
    expect(classifyHost('drobek.app:443', PROD)).toEqual({ side: 'dashboard' });
    expect(classifyHost('shop.drobek.app', PROD)).toEqual({ side: 'apps', target: { kind: 'prod', slug: 'shop' } });
    expect(classifyHost('shop.drobek.app:443', PROD)).toEqual({ side: 'apps', target: { kind: 'prod', slug: 'shop' } });
    expect(classifyHost('shop.drobek.app.', PROD)).toEqual({ side: 'apps', target: { kind: 'prod', slug: 'shop' } });
  });

  it('reserved-looking subdomains are still the apps side (404), never the dashboard', () => {
    expect(classifyHost('www.drobek.app', PROD)).toEqual({ side: 'apps', target: { kind: 'prod', slug: 'www' } });
    expect(classifyHost('drobek.app:8443', PROD)).toEqual({ side: 'apps', target: null });
  });

  it('a foreign domain that merely ends in the same letters is not ours (at most a custom-domain candidate)', () => {
    expect(classifyHost('shopdrobek.app', PROD)).toEqual({ side: 'custom', hostname: 'shopdrobek.app' });
    expect(classifyHost('firma.cz:443', PROD)).toEqual({ side: 'custom', hostname: 'firma.cz' });
    expect(classifyHost('firma.cz:8080', PROD)).toEqual({ side: 'dashboard' });
    expect(classifyHost('drobek:3000', PROD)).toEqual({ side: 'dashboard' });
  });
});

describe('isAppsOrigin', () => {
  it('true for app origins, false for the dashboard and foreign origins', () => {
    expect(isAppsOrigin('https://shop.drobek.app', PROD)).toBe(true);
    expect(isAppsOrigin('https://evil.drobek.app', PROD)).toBe(true);
    expect(isAppsOrigin('https://a.b.drobek.app', PROD)).toBe(true);
    expect(isAppsOrigin('https://drobek.app', PROD)).toBe(false);
    expect(isAppsOrigin('https://example.com', PROD)).toBe(false);
    expect(isAppsOrigin('http://shop--preview.apps.localhost:3041', DEV)).toBe(true);
    expect(isAppsOrigin('http://localhost:3041', DEV)).toBe(false);
    expect(isAppsOrigin('null', PROD)).toBe(false);
    expect(isAppsOrigin('not a url', PROD)).toBe(false);
  });
});

describe('appHostOf', () => {
  it('round-trips with classifyHost', () => {
    for (const target of [
      { kind: 'prod' as const, slug: 'shop' },
      { kind: 'preview' as const, slug: 'shop' },
      { kind: 'version' as const, slug: 'shop', number: 7 },
    ]) {
      expect(classifyHost(appHostOf(target, DEV.appsDomain), DEV)).toEqual({ side: 'apps', target });
    }
  });

  it('a custom-domain target is its own hostname', () => {
    expect(appHostOf({ kind: 'custom', slug: 'shop', hostname: 'shop.firma.cz' }, DEV.appsDomain)).toBe('shop.firma.cz');
  });
});

describe('path routing (APPS_ROUTING_MODE=path)', () => {
  const PATH = { appsDomain: 'apps-xyz.up.railway.app', dashboardHost: 'drobek-abc.up.railway.app', mode: 'path' as const };
  const LOCAL = { appsDomain: 'apps.localhost:3041', dashboardHost: 'localhost:3041', mode: 'path' as const };

  it('classifies only the apps host itself as the apps side', () => {
    expect(classifyHost('apps-xyz.up.railway.app', PATH)).toEqual({ side: 'apps', target: null, pathRouted: true });
    expect(classifyHost('APPS-XYZ.up.railway.app:443', PATH)).toEqual({ side: 'apps', target: null, pathRouted: true });
    expect(classifyHost('apps.localhost:3041', LOCAL)).toEqual({ side: 'apps', target: null, pathRouted: true });
    // A port mismatch is still the apps side, but never routed: a 404, never the dashboard.
    expect(classifyHost('apps.localhost:9999', LOCAL)).toEqual({ side: 'apps', target: null });
    expect(classifyHost('drobek-abc.up.railway.app', PATH)).toEqual({ side: 'dashboard' });
  });

  it('never treats a subdomain of the apps host as an app host', () => {
    const cls = classifyHost('notes.apps-xyz.up.railway.app', PATH);
    expect(cls.side === 'apps' && cls.target).toBeFalsy();
  });

  it('parses /apps/<label>/… into a server-decided target', () => {
    expect(parseAppPath('/apps/notes/')).toEqual({ kind: 'app', app: { target: { kind: 'prod', slug: 'notes' }, base: '/apps/notes', path: '/' } });
    expect(parseAppPath('/apps/notes--preview/a/b.js?x=1')).toEqual({
      kind: 'app',
      app: { target: { kind: 'preview', slug: 'notes' }, base: '/apps/notes--preview', path: '/a/b.js?x=1' },
    });
    expect(parseAppPath('/apps/notes--v3/')).toMatchObject({ kind: 'app', app: { target: { kind: 'version', slug: 'notes', number: 3 } } });
    expect(parseAppPath('/apps/notes')).toEqual({ kind: 'slash', location: '/apps/notes/' });
  });

  it('refuses everything that is not exactly one valid literal label', () => {
    for (const bad of [
      '/',
      '/mcp',
      '/api/apps',
      '/login',
      '/oauth/authorize',
      '/admin',
      '/apps',
      '/apps/',
      '/apps//notes/',
      '/apps/../mcp',
      '/apps/%2e%2e/mcp',
      '/apps/notes%2F..%2Fother/',
      '/apps/Notes/',
      '/apps/notes--beta/',
      '/apps/notes--v0/',
      '/apps/no%74es/',
      '/APPS/notes/',
      '//apps/notes/',
      '/./apps/notes/',
    ]) {
      expect(parseAppPath(bad), bad).toEqual({ kind: 'none' });
    }
  });

  it('keeps the rest of the path raw — traversal is the serving handler\'s confinement', () => {
    expect(parseAppPath('/apps/notes/%2e%2e/%2e%2e/mcp')).toMatchObject({ kind: 'app', app: { base: '/apps/notes', path: '/%2e%2e/%2e%2e/mcp' } });
  });

  it('reads an app URL of either mode', () => {
    expect(appTargetOfUrl(new URL('https://apps-xyz.up.railway.app/apps/notes--v2/x'), PATH)).toEqual({ kind: 'version', slug: 'notes', number: 2 });
    expect(appTargetOfUrl(new URL('https://apps-xyz.up.railway.app/apps/notes'), PATH)).toEqual({ kind: 'prod', slug: 'notes' });
    expect(appTargetOfUrl(new URL('https://apps-xyz.up.railway.app/'), PATH)).toBeNull();
    expect(appTargetOfUrl(new URL('https://drobek-abc.up.railway.app/apps/notes/'), PATH)).toBeNull();
    expect(appTargetOfUrl(new URL('https://notes--preview.drobek.app/'), PROD)).toEqual({ kind: 'preview', slug: 'notes' });
  });

  it('treats an Origin on the apps host as an apps origin (dashboard CSRF refuses it)', () => {
    expect(isAppsOrigin('https://apps-xyz.up.railway.app', PATH)).toBe(true);
    expect(isAppsOrigin('https://drobek-abc.up.railway.app', PATH)).toBe(false);
  });
});
