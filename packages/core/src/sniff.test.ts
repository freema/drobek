import { describe, expect, it } from 'vitest';
import { hasControlBytes, looksLikeSvg, sniffSignature } from './sniff.js';

const pad = (b: Buffer, n = 64): Buffer => Buffer.concat([b, Buffer.alloc(Math.max(0, n - b.length))]);
const ftyp = (brand: string): Buffer => pad(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from(`ftyp${brand}`, 'latin1')]));

describe('sniffSignature (NSO-358: images, pdf, video, audio, fonts)', () => {
  it('images and pdf by magic bytes', () => {
    expect(sniffSignature(pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))).toBe('image/png');
    expect(sniffSignature(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0])))).toBe('image/jpeg');
    expect(sniffSignature(pad(Buffer.from('GIF89a')))).toBe('image/gif');
    expect(sniffSignature(pad(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')))).toBe('image/webp');
    expect(sniffSignature(pad(Buffer.from('%PDF-1.7')))).toBe('application/pdf');
  });

  it('MP4 by the ftyp box and an MP4 brand; M4A is audio; AVIF / HEIC / QuickTime are not video', () => {
    for (const brand of ['isom', 'mp42', 'avc1', 'M4V ', 'dash']) expect(sniffSignature(ftyp(brand)), brand).toBe('video/mp4');
    expect(sniffSignature(ftyp('M4A '))).toBe('audio/mp4');
    for (const brand of ['avif', 'heic', 'mif1', 'qt  ']) expect(sniffSignature(ftyp(brand)), brand).toBeNull();
  });

  it('WebM needs the webm DocType in the EBML header (Matroska is not WebM)', () => {
    const ebml = (doc: string) => pad(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from(doc)]));
    expect(sniffSignature(ebml('webm'))).toBe('video/webm');
    expect(sniffSignature(ebml('matroska'))).toBeNull();
  });

  it('audio: ID3 / MPEG Layer III frames, Ogg, WAV', () => {
    expect(sniffSignature(pad(Buffer.from('ID3\x04\0\0', 'latin1')))).toBe('audio/mpeg');
    expect(sniffSignature(pad(Buffer.from([0xff, 0xfb, 0x90, 0x64])))).toBe('audio/mpeg');
    expect(sniffSignature(pad(Buffer.from([0xff, 0xf3, 0x90, 0x64])))).toBe('audio/mpeg');
    expect(sniffSignature(pad(Buffer.from([0xff, 0xf1, 0x50, 0x80])))).toBeNull(); // AAC ADTS (layer 0)
    expect(sniffSignature(pad(Buffer.from('OggS\0\x02', 'latin1')))).toBe('audio/ogg');
    expect(sniffSignature(pad(Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1')))).toBe('audio/wav');
  });

  it('fonts: woff and woff2', () => {
    expect(sniffSignature(pad(Buffer.from('wOFF\0\x01\0\0')))).toBe('font/woff');
    expect(sniffSignature(pad(Buffer.from('wOF2\0\x01\0\0')))).toBe('font/woff2');
  });

  it('nothing else: HTML, a ZIP, an executable, empty', () => {
    expect(sniffSignature(pad(Buffer.from('<!doctype html><html>')))).toBeNull();
    expect(sniffSignature(pad(Buffer.from([0x50, 0x4b, 0x03, 0x04])))).toBeNull();
    expect(sniffSignature(pad(Buffer.from('MZ\x90\0', 'latin1')))).toBeNull();
    expect(sniffSignature(Buffer.alloc(0))).toBeNull();
  });
});

describe('looksLikeSvg / hasControlBytes (shared with the files module)', () => {
  it('an <svg> root after an optional prolog', () => {
    expect(looksLikeSvg('<?xml version="1.0"?>\n<!-- x -->\n<svg viewBox="0 0 1 1"/>')).toBe(true);
    expect(looksLikeSvg('<html><svg/></html>')).toBe(false);
  });

  it('control bytes other than tab / CR / LF', () => {
    expect(hasControlBytes(Buffer.from('a\tb\r\nc'))).toBe(false);
    expect(hasControlBytes(Buffer.from([0x61, 0x00]))).toBe(true);
  });
});
