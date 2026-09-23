import { describe, expect, it } from 'vitest';
import { SNIFF_HEAD_BYTES, TypeSniffer, claimsCsv, looksLikeSvg, sniffBinary, sniffType, typeAllowed } from './sniff.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n', 'latin1');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><html><body><script>alert(document.cookie)</script></body></html>');
const CSV = Buffer.from('name,city\r\nAna,Brno\r\n"Bob, Jr.",Praha\r\n');

describe('sniffing (the bytes decide, never the name or the declared type)', () => {
  it('binary types by magic bytes, whatever the client says', () => {
    expect(sniffType(PNG, 'text/html', 'x.html')).toBe('image/png');
    expect(sniffType(JPEG)).toBe('image/jpeg');
    expect(sniffType(GIF)).toBe('image/gif');
    expect(sniffType(WEBP)).toBe('image/webp');
    expect(sniffType(PDF, 'image/png', 'x.png')).toBe('application/pdf');
    expect(sniffBinary(Buffer.from('RIFF\0\0\0\0WAVE'))).toBeNull();
  });

  it('an HTML page named .png is refused; so are binaries without a known signature', () => {
    expect(sniffType(HTML, 'image/png', 'cat.png')).toBeNull();
    expect(sniffType(HTML, 'text/csv', 'cat.csv')).toBeNull();
    expect(sniffType(Buffer.from('<p>hi</p>'), 'text/csv', 'x.csv')).toBeNull();
    expect(sniffType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 'application/pdf', 'x.pdf')).toBeNull(); // a ZIP
    expect(sniffType(Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00', 'latin1'), 'image/png', 'x.png')).toBeNull();
    expect(sniffType(Buffer.alloc(0), 'image/png', 'x.png')).toBeNull();
  });

  it('SVG: an <svg> root after an optional BOM, XML declaration, comments, DOCTYPE', () => {
    expect(sniffType(SVG)).toBe('image/svg+xml');
    const decorated = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: x -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg viewBox="0 0 1 1"/>'),
    ]);
    expect(sniffType(decorated)).toBe('image/svg+xml');
    expect(sniffType(Buffer.from('<html><svg></svg></html>'))).toBeNull();
    expect(sniffType(Buffer.from('<svgx></svgx>'))).toBeNull();
  });

  it('SVG: a DOCTYPE with an internal subset; unterminated prolog items are not SVG', () => {
    expect(looksLikeSvg('<!DOCTYPE svg [ <!ENTITY a "b"> ]>\n<svg/>')).toBe(true);
    expect(looksLikeSvg('<!doctype svg><!-- c --><?pi x?>\n\t<SVG>')).toBe(true);
    expect(looksLikeSvg('<!DOCTYPE html><svg>')).toBe(false);
    expect(looksLikeSvg('<!DOCTYPE svg><!DOCTYPE svg><svg>')).toBe(false); // one DOCTYPE only
    expect(looksLikeSvg('<?xml version="1.0"')).toBe(false);
    expect(looksLikeSvg('<!-- never closed <svg>')).toBe(false);
    expect(looksLikeSvg('<!DOCTYPE svg [ <!ENTITY a "b"> <svg>')).toBe(false);
    expect(looksLikeSvg('<!---->'.repeat(65) + '<svg>')).toBe(false); // over the prolog cap
    expect(looksLikeSvg('<!---->'.repeat(10) + '<svg>')).toBe(true);
  });

  it('SVG sniffing is linear: pathological 16 KiB heads answer fast (NSO-322 R1)', () => {
    const fill = (unit: string, tail = 'a'): Buffer => Buffer.from(unit.repeat(Math.floor((SNIFF_HEAD_BYTES - tail.length) / unit.length)) + tail);
    const inputs = [
      fill('<?xml?>'), // overlapping `<?xml…?>` / `<?…?>` alternatives in the old regex
      fill('<!---->'),
      fill('<?xml?>', '<svg>'),
      Buffer.from('<?' + ' '.repeat(SNIFF_HEAD_BYTES - 2)), // unterminated `<?`
      Buffer.from('<!--' + '-'.repeat(SNIFF_HEAD_BYTES - 4)),
      Buffer.from('<!DOCTYPE svg [' + '<'.repeat(SNIFF_HEAD_BYTES - 15)),
    ];
    for (const input of inputs) {
      const started = performance.now();
      expect(sniffType(input)).toBeNull();
      expect(performance.now() - started).toBeLessThan(50);
    }
  });

  it('CSV only when the client calls it CSV, it is UTF-8 text and holds no markup', () => {
    expect(sniffType(CSV, 'text/csv', 'people.csv')).toBe('text/csv');
    expect(sniffType(CSV, 'application/octet-stream', 'people.csv')).toBe('text/csv');
    expect(sniffType(CSV, 'application/vnd.ms-excel', 'people')).toBe('text/csv');
    expect(sniffType(CSV, 'image/png', 'people.png')).toBeNull();
    expect(sniffType(Buffer.from('a,b\n<script>x</script>,1\n'), 'text/csv', 'x.csv')).toBeNull();
    expect(sniffType(Buffer.from('a,b\n\u0001,1\n'), 'text/csv', 'x.csv')).toBeNull();
    expect(sniffType(Buffer.from([0x61, 0x2c, 0xc3, 0x28, 0x0a]), 'text/csv', 'x.csv')).toBeNull(); // invalid UTF-8
    expect(sniffType(Buffer.from([0x61, 0x2c, 0xc3]), 'text/csv', 'x.csv')).toBeNull(); // truncated sequence
    expect(sniffType(Buffer.from('jméno,město\nAna,Brno\n'), 'text/csv', 'x.csv')).toBe('text/csv');
    expect(claimsCsv('Text/CSV; charset=utf-8', '')).toBe(true);
    expect(claimsCsv(null, 'EXPORT.CSV ')).toBe(true);
  });

  it('chunked input gives the same answer; `rejected` flips as soon as nothing can match', () => {
    const utf8 = Buffer.from('jméno,město\nŽofie,Brno\n');
    const s = new TypeSniffer();
    for (let i = 0; i < utf8.length; i++) s.update(utf8.subarray(i, i + 1)); // splits multi-byte characters
    expect(s.rejected).toBe(false);
    expect(s.finish('text/csv', 'a.csv')).toBe('text/csv');

    const png = new TypeSniffer();
    for (let i = 0; i < PNG.length; i += 3) png.update(PNG.subarray(i, i + 3));
    png.update(Buffer.from([0, 1, 2, 0xff, 0xfe])); // binary body after the signature
    expect(png.rejected).toBe(false);
    expect(png.finish(null, '')).toBe('image/png');

    const junk = new TypeSniffer();
    junk.update(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c]));
    expect(junk.rejected).toBe(true);
  });

  it('allowedTypes: exact types and image/*', () => {
    expect(typeAllowed('image/webp', ['image/*'])).toBe(true);
    expect(typeAllowed('image/svg+xml', ['image/png', 'application/pdf'])).toBe(false);
    expect(typeAllowed('application/pdf', ['image/*'])).toBe(false);
    expect(typeAllowed('text/csv', ['text/csv'])).toBe(true);
  });
});
