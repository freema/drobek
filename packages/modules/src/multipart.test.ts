import { describe, expect, it } from 'vitest';
import { multipartBoundary, parseMultipart, streamMultipartFile } from './multipart.js';

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

/** `raw` as a pull stream in `size`-byte chunks; `state` tells whether it was returned and how much was pulled. */
function chunks(raw: Buffer, size: number, state = { pulled: 0, returned: false }): AsyncIterableIterator<Buffer> {
  let offset = 0;
  const iter: AsyncIterableIterator<Buffer> = {
    [Symbol.asyncIterator]: () => iter,
    async next() {
      if (state.returned || offset >= raw.length) return { value: undefined, done: true };
      const c = raw.subarray(offset, offset + size);
      offset += c.length;
      state.pulled += c.length;
      return { value: c, done: false };
    },
    async return() {
      state.returned = true;
      return { value: undefined, done: true };
    },
  };
  return iter;
}

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const c of stream) out.push(c);
  return Buffer.concat(out);
}

function fileBody(content: Buffer, opts: { before?: string[]; after?: string[] } = {}): Buffer {
  const pre = (opts.before ?? []).map((p) => `--${B}\r\n${p}\r\n`).join('');
  const post = (opts.after ?? []).map((p) => `--${B}\r\n${p}\r\n`).join('');
  return Buffer.concat([
    Buffer.from(`${pre}--${B}\r\nContent-Disposition: form-data; name="file"; filename="a b.png"\r\nContent-Type: Image/PNG\r\n\r\n`),
    content,
    Buffer.from(`\r\n${post}--${B}--\r\n`),
  ]);
}

describe('one streamed file (bodyTypes: file)', () => {
  // Bytes that look like a delimiter prefix, CRLFs and dashes inside the file.
  const content = Buffer.concat([Buffer.from('\r\n--'), Buffer.from(B.slice(0, 10)), Buffer.alloc(300_000, 0xab), Buffer.from('\r\n-\r\n--')]);

  for (const size of [1, 7, 70, 4096, 1_000_000]) {
    it(`yields exactly the file bytes whatever the chunking (chunks of ${size})`, async () => {
      const state = { pulled: 0, returned: false };
      const f = await streamMultipartFile(
        chunks(fileBody(content, { before: ['Content-Disposition: form-data; name="note"\r\n\r\nhi\r\nthere'] }), size, state),
        CT
      );
      expect(f).toMatchObject({ field: 'file', filename: 'a b.png', declaredType: 'image/png', fields: { note: 'hi\r\nthere' } });
      expect((await collect(f.stream)).equals(content)).toBe(true);
      expect(state.returned).toBe(true);
    });
  }

  it('leaving the loop early returns the source without reading the rest', async () => {
    const state = { pulled: 0, returned: false };
    const f = await streamMultipartFile(chunks(fileBody(Buffer.alloc(5_000_000, 1)), 65_536, state), CT);
    let seen = 0;
    for await (const c of f.stream) {
      seen += c.length;
      if (seen > 100_000) break;
    }
    expect(state.returned).toBe(true);
    expect(state.pulled).toBeLessThan(300_000);
  });

  it('refuses a non-multipart body (415), no file part, a second part, a missing end, oversized headers (400)', async () => {
    await expect(streamMultipartFile(chunks(Buffer.from('x'), 10), 'application/json')).rejects.toMatchObject({
      code: 'unsupported_media_type',
      status: 415,
    });
    await expect(streamMultipartFile(chunks(body(['Content-Disposition: form-data; name="a"\r\n\r\nx']), 10), CT)).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('no file part'),
    });
    const two = await streamMultipartFile(chunks(fileBody(Buffer.from('abc'), { after: ['Content-Disposition: form-data; name="x"\r\n\r\ny'] }), 16), CT);
    await expect(collect(two.stream)).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('exactly one file') });
    const cut = fileBody(Buffer.from('abcdef'));
    const truncated = await streamMultipartFile(chunks(cut.subarray(0, cut.length - 20), 8), CT);
    await expect(collect(truncated.stream)).rejects.toMatchObject({ code: 'invalid_request' });
    const huge = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="x"\r\nX-Pad: ${'a'.repeat(70_000)}\r\n\r\nabc\r\n--${B}--\r\n`);
    await expect(streamMultipartFile(chunks(huge, 4096), CT)).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
