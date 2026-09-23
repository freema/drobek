/**
 * `multipart/form-data` with TEXT fields only (M1-04) — what a plain
 * `fetch(url, { body: new FormData(form) })` sends. The result is a plain
 * object `{ name: value }`; a repeated name becomes an array of its values.
 * A part with a `filename` (a file) is refused: modules take files through
 * the files module, never inside another request.
 *
 * The body is already size-capped by the router before it gets here.
 */
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
