import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QrCode, QrDetails } from './app-qr.js';
import { appQrView, qrMatrix, qrSymbol } from './qr.js';

const PREVIEW = 'https://notes--preview.apps.example.com';
const LIVE = 'https://notes.apps.example.com';

const rows = (m: boolean[][]) => m.map((r) => r.map((d) => (d ? '#' : '.')).join(''));

/** The 15 format bits of the first copy, unmasked: [level (2 bits), mask (3 bits), BCH (10 bits)]. */
function formatInfo(m: boolean[][]): { level: number; mask: number } {
  const at = (x: number, y: number) => (m[y][x] ? 1 : 0);
  const bits: number[] = [];
  for (let i = 0; i <= 5; i++) bits.push(at(8, i));
  bits.push(at(8, 7), at(8, 8), at(7, 8));
  for (let i = 9; i < 15; i++) bits.push(at(14 - i, 8));
  const value = bits.reduce((acc, b, i) => acc | (b << i), 0) ^ 0x5412;
  return { level: value >>> 13, mask: (value >>> 10) & 7 };
}

describe('qrMatrix', () => {
  it('picks the smallest version that holds the text at level M', () => {
    expect(qrMatrix('https://drobek.app')).toHaveLength(25);
    expect(qrMatrix(PREVIEW)).toHaveLength(29);
    expect(qrMatrix(`https://${'a'.repeat(193)}.example.com`)).toHaveLength(4 * 10 + 17);
    expect(qrMatrix(`https://${'a'.repeat(194)}.example.com`)).toHaveLength(4 * 11 + 17);
  });

  it('draws the three finder patterns and writes level M into the format information', () => {
    const m = qrMatrix(PREVIEW);
    const finder = ['#######', '#.....#', '#.###.#', '#.###.#', '#.###.#', '#.....#', '#######'];
    const n = m.length;
    for (const [x, y] of [
      [0, 0],
      [n - 7, 0],
      [0, n - 7],
    ]) {
      expect(rows(m.slice(y, y + 7).map((r) => r.slice(x, x + 7)))).toEqual(finder);
    }
    expect(formatInfo(m).level).toBe(0);
    expect(m[n - 8][8]).toBe(true);
  });

  it('is deterministic and matches the reviewed symbol (decoded by a scanner)', () => {
    expect(rows(qrMatrix('https://drobek.app'))).toEqual(rows(qrMatrix('https://drobek.app')));
    expect(rows(qrMatrix('https://drobek.app')).join('\n')).toMatchSnapshot();
  });

  it('encodes non-ASCII text as UTF-8 bytes', () => {
    expect(qrMatrix('https://žluťoučký.example.cz/')).toHaveLength(29);
  });

  it('refuses text no QR version can hold', () => {
    expect(() => qrMatrix('x'.repeat(2400))).toThrow(RangeError);
  });
});

describe('<QrCode>', () => {
  it('renders an SVG image with the encoded URL and an accessible name', () => {
    const html = renderToStaticMarkup(<QrCode symbol={qrSymbol(PREVIEW)} label="QR code of the preview" />);
    expect(html).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 37 37"/);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="QR code of the preview"');
    expect(html).toContain(`data-url="${PREVIEW}"`);
    expect(html).toMatchSnapshot();
  });

  it('escapes the URL in its attributes', () => {
    const html = renderToStaticMarkup(<QrCode symbol={qrSymbol('https://x.example.com/?a="b"&c')} label="x" />);
    expect(html).toContain('data-url="https://x.example.com/?a=&quot;b&quot;&amp;c"');
  });
});

describe('appQrView + <QrDetails>', () => {
  it('an unpublished app has only the preview QR and says how to get a live address', () => {
    const qr = appQrView({ previewUrl: PREVIEW, liveUrl: null, visibility: 'public' });
    expect(qr.live).toBeNull();
    expect(renderToStaticMarkup(<QrDetails qr={qr} kind="live" />)).toBe('');
    const html = renderToStaticMarkup(<QrDetails qr={qr} kind="preview" />);
    expect(html).toContain('<summary');
    expect(html).toContain('Show QR');
    expect(html).toContain(`data-url="${PREVIEW}"`);
    expect(html).toContain('Publish to get a live address.');
    expect(html).not.toContain('password page');
  });

  it('a published app gets the live address QR too; a password app says it opens the password page', () => {
    const qr = appQrView({ previewUrl: PREVIEW, liveUrl: LIVE, visibility: 'password' });
    expect(qr.live?.url).toBe(LIVE);
    const live = renderToStaticMarkup(<QrDetails qr={qr} kind="live" />);
    expect(live).toContain(`data-url="${LIVE}"`);
    expect(live).toContain('Opens the password page first.');
    expect(renderToStaticMarkup(<QrDetails qr={qr} kind="preview" />)).not.toContain('Publish to get a live address');
  });
});
