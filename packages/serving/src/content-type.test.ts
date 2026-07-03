import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTENT_TYPE,
  contentTypeForPath,
  extensionOf,
  hasExtension,
} from './content-type.js';

describe('extensionOf', () => {
  it('returns the lowercase extension', () => {
    expect(extensionOf('index.html')).toBe('html');
    expect(extensionOf('assets/App.CSS')).toBe('css');
    expect(extensionOf('a/b/c.min.js')).toBe('js');
  });

  it('strips query and hash', () => {
    expect(extensionOf('app.js?v=2')).toBe('js');
    expect(extensionOf('app.css#top')).toBe('css');
  });

  it('is empty for extensionless paths and dotfiles', () => {
    expect(extensionOf('dashboard')).toBe('');
    expect(extensionOf('a/b/route')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('')).toBe('');
  });
});

describe('hasExtension', () => {
  it('distinguishes assets from client routes', () => {
    expect(hasExtension('logo.png')).toBe(true);
    expect(hasExtension('dashboard')).toBe(false);
    expect(hasExtension('users/42')).toBe(false);
  });
});

describe('contentTypeForPath', () => {
  it('maps known extensions from the PATH, not the upload', () => {
    expect(contentTypeForPath('index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeForPath('a/app.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeForPath('a/style.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeForPath('img/logo.svg')).toBe('image/svg+xml');
    expect(contentTypeForPath('img/photo.png')).toBe('image/png');
    expect(contentTypeForPath('f/font.woff2')).toBe('font/woff2');
    expect(contentTypeForPath('m/mod.wasm')).toBe('application/wasm');
    expect(contentTypeForPath('data.json')).toBe('application/json; charset=utf-8');
  });

  it('falls back to octet-stream for unknown/no extension', () => {
    expect(contentTypeForPath('weird.xyz')).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeForPath('noext')).toBe(DEFAULT_CONTENT_TYPE);
  });
});
