import { describe, expect, it } from 'vitest';
import {
  APP_CSP,
  DEFAULT_FRAME_SRC,
  appCsp,
  appSecurityHeaders,
  frameSrcConfigError,
  frameSrcFromEnv,
  parseFrameAncestors,
  parseFrameSrcExtra,
  withDashboardAncestor,
} from './csp.js';

describe('app CSP (plan §3.3)', () => {
  it('is exactly the documented policy', () => {
    expect(APP_CSP).toBe(
      "default-src 'self'; script-src 'self' https://esm.sh 'unsafe-inline'; style-src 'self' 'unsafe-inline' https:; " +
        "img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https://esm.sh; " +
        "media-src 'self' blob: https:; " +
        "frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://drive.google.com; " +
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
    );
  });

  it('takes a frame-ancestors override', () => {
    expect(appCsp('https://intranet.example.com')).toContain('frame-ancestors https://intranet.example.com;');
  });

  it('takes a frame-src list (NSO-358)', () => {
    expect(appCsp(undefined, `${DEFAULT_FRAME_SRC} https://embed.example.com`)).toContain(
      `frame-src ${DEFAULT_FRAME_SRC} https://embed.example.com;`
    );
  });
});

describe('APP_FRAME_SRC_EXTRA (NSO-358)', () => {
  it('accepts comma / space separated https origins, lower-cased, de-duplicated', () => {
    expect(parseFrameSrcExtra('https://Embed.Example.com, https://tube.example.org:8443  https://embed.example.com/')).toEqual({
      sources: ['https://embed.example.com', 'https://tube.example.org:8443'],
    });
    expect(parseFrameSrcExtra(undefined)).toEqual({ sources: [] });
    expect(parseFrameSrcExtra('  ')).toEqual({ sources: [] });
  });

  it('refuses anything that is not a bare https origin', () => {
    for (const bad of [
      'http://embed.example.com',
      'https://*.example.com',
      'https:',
      '*',
      "'self'",
      'https://embed.example.com/player',
      'https://embed.example.com?x=1',
      "https://a.example.com;script-src 'unsafe-eval'",
      'https://a.example.com:99999',
      'javascript:alert(1)',
      Array.from({ length: 21 }, (_, i) => `https://a${i}.example.com`).join(','),
    ]) {
      expect(parseFrameSrcExtra(bad), bad).toHaveProperty('error');
    }
  });

  it('an invalid value is a startup error; a valid one extends the curated list', () => {
    expect(frameSrcConfigError({ APP_FRAME_SRC_EXTRA: 'http://x.example.com' })).toMatch(/refuses to start: APP_FRAME_SRC_EXTRA/);
    expect(frameSrcConfigError({ APP_FRAME_SRC_EXTRA: 'https://x.example.com' })).toBeNull();
    expect(frameSrcConfigError({})).toBeNull();
    expect(frameSrcFromEnv({})).toBe(DEFAULT_FRAME_SRC);
    expect(frameSrcFromEnv({ APP_FRAME_SRC_EXTRA: 'https://x.example.com https://player.vimeo.com' })).toBe(
      `${DEFAULT_FRAME_SRC} https://x.example.com`
    );
  });
});

describe('parseFrameAncestors', () => {
  it('accepts self and http(s) origins (optionally *.wildcard, port)', () => {
    expect(parseFrameAncestors("'self' https://intranet.example.com")).toBe("'self' https://intranet.example.com");
    expect(parseFrameAncestors('https://*.example.com http://localhost:8080')).toBe(
      'https://*.example.com http://localhost:8080'
    );
    expect(parseFrameAncestors("'none'")).toBe("'none'");
    expect(parseFrameAncestors('HTTPS://Intranet.Example.com')).toBe('https://intranet.example.com');
  });

  it('is null (→ none) when absent or unsafe — no directive or header injection', () => {
    for (const bad of [
      null,
      undefined,
      '',
      '   ',
      '*',
      'https:',
      "https://a.example.com; script-src 'unsafe-eval'",
      'https://a.example.com/path',
      "'unsafe-inline'",
      'https://a.example.com\r\nSet-Cookie: x=1',
      'javascript:alert(1)',
      "'none' https://a.example.com",
      Array.from({ length: 11 }, (_, i) => `https://a${i}.example.com`).join(' '),
    ]) {
      expect(parseFrameAncestors(bad as string | null), String(bad)).toBeNull();
    }
  });
});

describe('appSecurityHeaders (snapshot)', () => {
  it('production host: CSP + nosniff + no-referrer, indexable', () => {
    expect(appSecurityHeaders({ noindex: false })).toEqual({
      'Content-Security-Policy': APP_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
  });

  it('preview / version hosts add X-Robots-Tag: noindex', () => {
    expect(appSecurityHeaders({ noindex: true })).toEqual({
      'Content-Security-Policy': APP_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
    });
  });

  it('carries a validated frame-ancestors override', () => {
    const h = appSecurityHeaders({ noindex: false, frameAncestors: 'https://intranet.example.com' });
    expect(h['Content-Security-Policy']).toBe(appCsp('https://intranet.example.com'));
  });
});

describe('withDashboardAncestor (NSO-342, the app-list thumbnail)', () => {
  const dash = 'https://drobek.example.com';

  it("replaces 'none' / no override with the dashboard origin alone", () => {
    expect(withDashboardAncestor(null, dash)).toBe(dash);
    expect(withDashboardAncestor("'none'", dash)).toBe(dash);
    expect(withDashboardAncestor(undefined, 'http://localhost:3041/')).toBe('http://localhost:3041');
  });

  it("appends it to the owner's override once", () => {
    expect(withDashboardAncestor("'self' https://intranet.example.com", dash)).toBe(
      `'self' https://intranet.example.com ${dash}`
    );
    expect(withDashboardAncestor(`https://a.example.com ${dash}`, dash)).toBe(`https://a.example.com ${dash}`);
  });

  it('ignores a missing or unsafe dashboard origin (the value stays as it was)', () => {
    for (const bad of [null, undefined, '', "'self'", '*', 'https:', 'https://*.example.com', 'https://a.example.com/path', 'https://a.example.com; x']) {
      expect(withDashboardAncestor(null, bad), String(bad)).toBeNull();
      expect(withDashboardAncestor('https://a.example.com', bad), String(bad)).toBe('https://a.example.com');
    }
  });

  it('ends up in the CSP as the only extra ancestor', () => {
    const h = appSecurityHeaders({ noindex: false, frameAncestors: withDashboardAncestor(parseFrameAncestors(null), dash) });
    expect(h['Content-Security-Policy']).toContain(`frame-ancestors ${dash};`);
  });
});
