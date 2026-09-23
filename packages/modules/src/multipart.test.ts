import { describe, expect, it } from 'vitest';
import { multipartBoundary, parseMultipart } from './multipart.js';

const B = '----drobekBoundary7MA4YWxk';
const CT = `multipart/form-data; boundary=${B}`;

function body(parts: string[]): Buffer {
  return Buffer.from(parts.map((p) => `--${B}\r\n${p}\r\n`).join('') + `--${B}--\r\n`);
}

describe('text-only multipart/form-data', () => {
  it('boundary from the Content-Type (quoted or not)', () => {
    expect(multipartBoundary(CT)).toBe(B);
    expect(multipartBoundary('multipart/form-data; boundary="a b"')).toBe('a b');
    expect(multipartBoundary('multipart/form-data')).toBeNull();
  });

  it('fields → an object; repeated names → arrays; values keep newlines and UTF-8', () => {
    const b = body([
      'Content-Disposition: form-data; name="name"\r\n\r\nAna Nováková',
      'Content-Disposition: form-data; name="message"\r\n\r\nline 1\r\nline 2 <script>',
      'Content-Disposition: form-data; name="topic"\r\n\r\na',
      'Content-Disposition: form-data; name="topic"\r\n\r\nb',
      'Content-Disposition: form-data; name="empty"\r\n\r\n',
    ]);
    expect(parseMultipart(b, CT)).toEqual({ name: 'Ana Nováková', message: 'line 1\r\nline 2 <script>', topic: ['a', 'b'], empty: '' });
  });

  it('a __proto__ field is an own property, not a prototype', () => {
    const out = parseMultipart(body(['Content-Disposition: form-data; name="__proto__"\r\n\r\nx']), CT);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
  });

  it('files are refused (415); malformed bodies are 400', () => {
    const file = body(['Content-Disposition: form-data; name="cv"; filename="cv.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF']);
    expect(() => parseMultipart(file, CT)).toThrow(expect.objectContaining({ code: 'unsupported_media_type', status: 415 }));
    expect(() => parseMultipart(Buffer.from('garbage'), CT)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => parseMultipart(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="a"\r\n\r\nno end`), CT)).toThrow(
      expect.objectContaining({ code: 'invalid_request' })
    );
    expect(() => parseMultipart(body(['Content-Disposition: form-data\r\n\r\nx']), CT)).toThrow(/field name/);
    expect(() => parseMultipart(body(['X: y\r\n\r\nx']), CT)).toThrow(/form-data/);
    expect(() => parseMultipart(body(['Content-Disposition: form-data; name="a"\r\n\r\nx']), 'multipart/form-data')).toThrow(/boundary/);
  });
});
