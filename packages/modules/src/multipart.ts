/**
 * `multipart/form-data` with TEXT fields only (M1-04) — what a plain
 * `fetch(url, { body: new FormData(form) })` sends. The result is a plain
 * object `{ name: value }`; a repeated name becomes an array of its values.
 * A part with a `filename` (a file) is refused: modules take files through
 * the files module, never inside another request.
 *
 * The body is already size-capped by the router before it gets here.
 *
 * `streamMultipartFile` is the other half: ONE file part, streamed (the
 * `bodyTypes: ['file']` routes, i.e. the files module).
 */
import type { UploadedFile } from './contract.js';
import { ModuleError } from './errors.js';

const MAX_PARTS = 200;
const MAX_NAME = 200;

/** The `boundary` parameter of a multipart Content-Type, or null. */
export function multipartBoundary(contentType: string | null): string | null {
  const m = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(contentType ?? '');
  return m ? (m[1] ?? m[2]) : null;
}

function headerParam(header: string, name: string): string | null {
  const re = new RegExp(`;\\s*${name}\\*?=(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]*))`, 'i');
  const m = re.exec(header);
  if (!m) return null;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? '');
}

function bad(message: string): ModuleError {
  return new ModuleError('invalid_request', message);
}

/** Parse a text-only multipart body into `{ name: value | value[] }`. */
export function parseMultipart(body: Buffer, contentType: string | null): Record<string, string | string[]> {
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw bad('The multipart body has no boundary.');
  const delimiter = Buffer.from(`--${boundary}`);
  const entries: [string, string][] = [];

  let pos = body.indexOf(delimiter);
  if (pos === -1) throw bad('The multipart body is malformed.');
  for (;;) {
    pos += delimiter.length;
    // `--` after a delimiter closes the body.
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else throw bad('The multipart body is malformed.');

    const headEnd = body.indexOf('\r\n\r\n', pos);
    if (headEnd === -1) throw bad('The multipart body is malformed.');
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delimiter]), headEnd + 4);
    if (next === -1) throw bad('The multipart body is malformed (no closing boundary).');

    const headers = body.subarray(pos, headEnd).toString('utf8').split('\r\n');
    const disposition = headers.find((h) => /^content-disposition\s*:/i.test(h)) ?? '';
    if (!/^content-disposition\s*:\s*form-data\s*(;|$)/i.test(disposition)) throw bad('Every multipart part needs Content-Disposition: form-data.');
    if (headerParam(disposition, 'filename') !== null) {
      throw new ModuleError('unsupported_media_type', 'Files are not accepted here — send text fields only.');
    }
    const name = headerParam(disposition, 'name');
    if (!name || name.length > MAX_NAME) throw bad('A multipart part has no field name (or a name over 200 characters).');
    entries.push([name, body.subarray(headEnd + 4, next).toString('utf8')]);
    if (entries.length > MAX_PARTS) throw bad(`At most ${MAX_PARTS} fields.`);
    pos = next + 2;
  }

  const grouped = new Map<string, string[]>();
  for (const [k, v] of entries) grouped.set(k, [...(grouped.get(k) ?? []), v]);
  // Object.fromEntries defines own properties: a field named `__proto__` cannot touch the prototype.
  return Object.fromEntries([...grouped].map(([k, v]) => [k, v.length === 1 ? v[0] : v]));
}

// ── one streamed file (`bodyTypes: ['file']`) ────────────────────────────────

/** Bytes before the first boundary + all part headers + the text fields before the file. */
export const MAX_FILE_HEAD_BYTES = 64 * 1024;
const MAX_FILE_TEXT_FIELDS = 20;
const CRLFCRLF = Buffer.from('\r\n\r\n');

/**
 * Parse a `multipart/form-data` body that carries ONE file part WITHOUT
 * buffering the file: the part headers (and any text fields before the file,
 * at most 64 KiB together) are read up front, then `stream` yields the file's
 * bytes as they arrive. A delimiter split across chunks is handled by holding
 * back the last `boundary.length + 6` bytes. After the file only the closing
 * delimiter may follow (a second part → `invalid_request` from the stream).
 * Leaving the stream early — or finishing it — returns the source iterator,
 * which lets the adapter discard the rest of the request.
 */
export async function streamMultipartFile(source: AsyncIterable<Buffer>, contentType: string | null): Promise<UploadedFile> {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'multipart/form-data') {
    throw new ModuleError('unsupported_media_type', 'Send the file as multipart/form-data (a FormData with one file) — the SDK does.');
  }
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw bad('The multipart body has no boundary.');
  const delimiter = Buffer.from(`--${boundary}`);
  const closing = Buffer.from(`\r\n--${boundary}`);
  const it = source[Symbol.asyncIterator]();
  let buf: Buffer = Buffer.alloc(0);
  let ended = false;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await it.return?.();
  };
  const pull = async (): Promise<boolean> => {
    if (ended) return false;
    const r = await it.next();
    if (r.done) {
      ended = true;
      return false;
    }
    buf = buf.length === 0 ? r.value : Buffer.concat([buf, r.value]);
    return true;
  };
  const early = () => bad('The multipart body is malformed (it ended early).');
  /** Wait until `needle` is in `buf` at or after `from` (within the head budget); its index. */
  const find = async (needle: Buffer, from: number): Promise<number> => {
    for (;;) {
      const i = buf.indexOf(needle, from);
      if (i !== -1) return i;
      if (buf.length > MAX_FILE_HEAD_BYTES) throw bad(`At most ${MAX_FILE_HEAD_BYTES} bytes of multipart headers and text fields may precede the file.`);
      if (!(await pull())) throw early();
    }
  };

  try {
    let pos = await find(delimiter, 0);
    const fields: Record<string, string> = {};
    let textFields = 0;
    for (;;) {
      pos += delimiter.length;
      while (buf.length < pos + 2) if (!(await pull())) throw early();
      if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) throw bad('The multipart body has no file part — send one file.');
      if (buf[pos] !== 0x0d || buf[pos + 1] !== 0x0a) throw bad('The multipart body is malformed.');
      pos += 2;
      const headEnd = await find(CRLFCRLF, pos);
      const headers = buf.subarray(pos, headEnd).toString('utf8').split('\r\n');
      const disposition = headers.find((h) => /^content-disposition\s*:/i.test(h)) ?? '';
      if (!/^content-disposition\s*:\s*form-data\s*(;|$)/i.test(disposition)) throw bad('Every multipart part needs Content-Disposition: form-data.');
      const name = headerParam(disposition, 'name');
      if (!name || name.length > MAX_NAME) throw bad('A multipart part has no field name (or a name over 200 characters).');
      const filename = headerParam(disposition, 'filename');
      if (filename === null) {
        const next = await find(closing, headEnd + 4);
        if (++textFields > MAX_FILE_TEXT_FIELDS) throw bad(`At most ${MAX_FILE_TEXT_FIELDS} text fields may precede the file.`);
        // defineProperty: a field named `__proto__` cannot touch the prototype.
        if (!Object.prototype.hasOwnProperty.call(fields, name)) {
          Object.defineProperty(fields, name, {
            value: buf.subarray(headEnd + 4, next).toString('utf8'),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        pos = next + 2;
        continue;
      }
      const typeHeader = headers.find((h) => /^content-type\s*:/i.test(h));
      const declared = typeHeader ? typeHeader.slice(typeHeader.indexOf(':') + 1).trim().toLowerCase().slice(0, 200) : '';
      buf = buf.subarray(headEnd + 4);
      const keep = closing.length + 4;
      const fileBytes = async function* (): AsyncGenerator<Buffer> {
        try {
          for (;;) {
            const i = buf.indexOf(closing);
            if (i !== -1) {
              if (i > 0) yield buf.subarray(0, i);
              buf = buf.subarray(i + closing.length);
              while (buf.length < 2 && (await pull()));
              if (buf[0] === 0x2d && buf[1] === 0x2d) return;
              throw bad('Send exactly one file per request (nothing may follow the file part).');
            }
            if (buf.length > keep) {
              const out = buf.subarray(0, buf.length - keep);
              buf = buf.subarray(buf.length - keep);
              yield out;
            }
            if (!(await pull())) throw bad('The multipart body ended before the file did (no closing boundary).');
          }
        } finally {
          await release();
        }
      };
      return { field: name, filename: filename.slice(0, 1000), declaredType: declared || null, fields, stream: fileBytes() };
    }
  } catch (err) {
    await release();
    throw err;
  }
}
