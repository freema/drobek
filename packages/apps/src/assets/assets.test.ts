import { describe, expect, it } from 'vitest';
import {
  AssetSniffer,
  assetFileName,
  assetNameProblem,
  assetPath,
  assetTypesForName,
  contentRange,
  declaredTypeFits,
  parseRange,
  sniffAsset,
  unsatisfiedRange,
} from '../index.js';
import { fakeMp4 } from '../test/assets.js';

describe('asset paths (NSO-358)', () => {
  it('accepts a relative path of up to 4 segments with an allowed extension (the page keeps its own paths)', () => {
    for (const ok of ['film.mp4', 'poster.JPG', 'img/s1.jpg', 'media/Film-1.mp4', 'a/b/c/d.png', 'hero-2x.webp', 'logo_v1.svg', 'track.01.mp3', 'fonts/x.woff2', '0.m4a']) {
      expect(assetNameProblem(ok), ok).toBeNull();
    }
    expect(assetPath('img/s1.jpg')).toBe('/img/s1.jpg');
    expect(assetFileName('img/s1.jpg')).toBe('s1.jpg');
  });

  it('refuses traversal, absolute or empty segments, hidden / __drobek segments, > 4 segments, > 200 chars, no / an unknown extension', () => {
    for (const bad of [
      '',
      '../x.png',
      'a/../x.png',
      '/x.png',
      'a//b.png',
      'a/b/',
      './x.png',
      '.hidden.png',
      'img/.x.png',
      '.well-known/x.png',
      '__drobek/x.png',
      '-x.png',
      'a/b/c/d/e.png',
      `${'a'.repeat(97)}/${'b'.repeat(99)}.png`,
      'film',
      'img/film',
      'page.html',
      'x.exe',
      'x.pdf',
      'a b.png',
      'a%2f.png',
      'a\\b.png',
    ]) {
      expect(assetNameProblem(bad), bad).not.toBeNull();
    }
    expect(assetNameProblem(undefined)).toMatch(/missing/);
  });

  it('the extension narrows the types; mp4 may hold video or audio', () => {
    expect(assetTypesForName('film.mp4')).toEqual(['video/mp4', 'audio/mp4']);
    expect(assetTypesForName('song.m4a')).toEqual(['audio/mp4']);
    expect(assetTypesForName('x.jpeg')).toEqual(['image/jpeg']);
    expect(assetTypesForName('x.txt')).toBeNull();
  });

  it('a declared Content-Type must fit the name (family), empty or octet-stream is fine', () => {
    expect(declaredTypeFits('film.mp4', 'video/mp4')).toBe(true);
    expect(declaredTypeFits('film.mp4', 'video/quicktime; codecs=x')).toBe(true);
    expect(declaredTypeFits('film.mp4', '')).toBe(true);
    expect(declaredTypeFits('film.mp4', 'application/octet-stream')).toBe(true);
    expect(declaredTypeFits('film.mp4', 'image/png')).toBe(false);
    expect(declaredTypeFits('film.mp4', 'text/html')).toBe(false);
  });
});

describe('AssetSniffer (the bytes decide)', () => {
  it('video, audio, images and fonts by signature', () => {
    expect(sniffAsset(fakeMp4())).toBe('video/mp4');
    expect(sniffAsset(Buffer.concat([Buffer.from('ID3\x04\0\0', 'latin1'), Buffer.alloc(100, 1)]))).toBe('audio/mpeg');
    expect(sniffAsset(Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(100, 1)]))).toBe('font/woff2');
    expect(sniffAsset(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80)]))).toBe('image/png');
  });

  it('SVG is the one text type (UTF-8, no control bytes, an <svg> root)', () => {
    expect(sniffAsset(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml');
    expect(sniffAsset(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffAsset(Buffer.from('<svg>\0</svg>'))).toBeNull();
  });

  it('a short file under the signature window is still sniffed at finish', () => {
    expect(sniffAsset(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]))).toBe('image/jpeg');
    expect(sniffAsset(Buffer.alloc(0))).toBeNull();
  });

  it('rejects early: an unknown binary stops the stream before its end', () => {
    const s = new AssetSniffer();
    s.update(Buffer.from([0x4d, 0x5a, 0x90, 0x00, ...new Array(100).fill(0)])); // an executable
    expect(s.rejected).toBe(true);
    const html = new AssetSniffer();
    html.update(Buffer.from('<!doctype html><html><body>'.padEnd(100, ' ')));
    expect(html.rejected).toBe(false); // still valid text: only finish() can tell it is no SVG
    expect(html.finish()).toBeNull();
  });
});

describe('parseRange (RFC 9110, one range)', () => {
  const size = 1000;

  it('no header, another unit or a multi-range list → the whole file (null)', () => {
    expect(parseRange(null, size)).toBeNull();
    expect(parseRange('', size)).toBeNull();
    expect(parseRange('items=0-5', size)).toBeNull();
    expect(parseRange('bytes=0-10, 20-30', size)).toBeNull();
  });

  it('a header without `=` is not a range at all → ignored, the whole file (RFC 9110, NSO-362)', () => {
    for (const invalid of ['bytes', '0-99', 'bytes 0-99', 'garbage']) expect(parseRange(invalid, size), invalid).toBeNull();
  });

  it('closed, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=0-99', size)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=500-', size)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=-100', size)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-5000', size)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=990-5000', size)).toEqual({ start: 990, end: 999 });
    expect(parseRange(' BYTES=0-0 ', size)).toEqual({ start: 0, end: 0 });
  });

  it('malformed or unsatisfiable → 416', () => {
    for (const bad of ['bytes=abc', 'bytes=-', 'bytes=', 'bytes=5-2', 'bytes=1000-', 'bytes=1000-1001', 'bytes=-0', 'bytes=1.5-2', 'bytes=0-10, x']) {
      expect(parseRange(bad, size), bad).toBe('unsatisfiable');
    }
    expect(parseRange('bytes=0-10', 0)).toBe('unsatisfiable');
  });

  it('Content-Range values', () => {
    expect(contentRange({ start: 0, end: 99 }, 1000)).toBe('bytes 0-99/1000');
    expect(unsatisfiedRange(1000)).toBe('bytes */1000');
  });
});
