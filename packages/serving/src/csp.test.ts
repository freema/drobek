import { describe, expect, it } from 'vitest';
import {
  APP_CSP,
  DEFAULT_FRAME_SRC,
  appCsp,
  appSecurityHeaders,
  frameSrcConfigError,
  frameSrcFromEnv,
  galleryFrameAncestorsConfigError,
  galleryFrameAncestorsFromEnv,
  parseFrameAncestors,
  parseFrameSrcExtra,
  parseGalleryFrameAncestors,
  withFrameAncestors,
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

describe('withFrameAncestors (NSO-342 dashboard thumbnail, GALLERY_FRAME_ANCESTORS)', () => {
  const dash = 'https://drobek.example.com';
  const gallery = 'https://www.example.com';

  it("replaces 'none' / no override with the added origin(s)", () => {
    expect(withFrameAncestors(null, [dash])).toBe(dash);
    expect(withFrameAncestors("'none'", [dash])).toBe(dash);
    expect(withFrameAncestors(undefined, ['http://localhost:3041/'])).toBe('http://localhost:3041');
    expect(withFrameAncestors(null, [dash, gallery])).toBe(`${dash} ${gallery}`);
  });

  it("appends to the owner's override, each origin once", () => {
    expect(withFrameAncestors("'self' https://intranet.example.com", [dash])).toBe(`'self' https://intranet.example.com ${dash}`);
    expect(withFrameAncestors(`https://a.example.com ${dash}`, [dash])).toBe(`https://a.example.com ${dash}`);
    expect(withFrameAncestors('https://a.example.com', [dash, gallery, gallery.toUpperCase()])).toBe(
      `https://a.example.com ${dash} ${gallery}`
    );
  });

  it('ignores a missing or unsafe origin (the value stays as it was)', () => {
    for (const bad of [
      null,
      undefined,
      '',
      "'self'",
      '*',
      'https:',
      'https://*.example.com',
      'https://a.example.com/path',
      'https://a.example.com; x',
      'https://a.example.com:99999',
    ]) {
      expect(withFrameAncestors(null, [bad]), String(bad)).toBeNull();
      expect(withFrameAncestors("'none'", [bad]), String(bad)).toBe("'none'");
      expect(withFrameAncestors('https://a.example.com', [bad]), String(bad)).toBe('https://a.example.com');
      expect(withFrameAncestors(null, [bad, gallery]), String(bad)).toBe(gallery);
    }
    expect(withFrameAncestors('https://a.example.com', [])).toBe('https://a.example.com');
  });

  it('ends up in the CSP as the only extra ancestors', () => {
    const h = appSecurityHeaders({ noindex: false, frameAncestors: withFrameAncestors(parseFrameAncestors(null), [dash, gallery]) });
    expect(h['Content-Security-Policy']).toContain(`frame-ancestors ${dash} ${gallery};`);
  });
});

describe('GALLERY_FRAME_ANCESTORS', () => {
  it('accepts space-separated bare http(s) origins, lower-cased, de-duplicated', () => {
    expect(parseGalleryFrameAncestors(' https://WWW.Example.com  http://localhost:3042/ https://www.example.com ')).toEqual({
      origins: ['https://www.example.com', 'http://localhost:3042'],
    });
    expect(parseGalleryFrameAncestors(undefined)).toEqual({ origins: [] });
    expect(parseGalleryFrameAncestors('  ')).toEqual({ origins: [] });
  });

  it('refuses anything that is not a bare http(s) origin', () => {
    for (const bad of [
      'https://*.example.com',
      'https:',
      '*',
      "'self'",
      "'none'",
      'https://www.example.com/gallery',
      'https://www.example.com?x=1',
      'https://a.example.com,https://b.example.com',
      "https://a.example.com;script-src 'unsafe-eval'",
      'https://a.example.com:99999',
      'javascript:alert(1)',
      'ftp://a.example.com',
      Array.from({ length: 11 }, (_, i) => `https://a${i}.example.com`).join(' '),
    ]) {
      expect(parseGalleryFrameAncestors(bad), bad).toHaveProperty('error');
    }
  });

  it('an invalid value is a startup error; unset or valid is not', () => {
    expect(galleryFrameAncestorsConfigError({ GALLERY_FRAME_ANCESTORS: 'https://*.example.com' })).toMatch(
      /refuses to start: GALLERY_FRAME_ANCESTORS "https:\/\/\*\.example\.com" is not a bare http\(s\) origin/
    );
    expect(galleryFrameAncestorsConfigError({ GALLERY_FRAME_ANCESTORS: 'https://www.example.com' })).toBeNull();
    expect(galleryFrameAncestorsConfigError({})).toBeNull();
    expect(galleryFrameAncestorsFromEnv({ GALLERY_FRAME_ANCESTORS: 'https://www.example.com' })).toEqual(['https://www.example.com']);
    expect(galleryFrameAncestorsFromEnv({ GALLERY_FRAME_ANCESTORS: 'https://www.example.com/x' })).toEqual([]);
    expect(galleryFrameAncestorsFromEnv({})).toEqual([]);
  });
});
