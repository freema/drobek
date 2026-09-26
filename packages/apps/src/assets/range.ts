/**
 * HTTP byte ranges for serving assets (NSO-358; RFC 9110 §14). PURE.
 *
 * Safari will not play — or seek in — a `<video>` whose server ignores
 * `Range`, so every asset answers `Accept-Ranges: bytes` and honours ONE
 * range per request:
 *
 *   bytes=0-99     the first 100 bytes
 *   bytes=100-     from byte 100 to the end
 *   bytes=-500     the last 500 bytes (the whole file when it is shorter)
 *
 * A malformed `bytes=` value, a start past the end, an end before the start
 * and a zero-length suffix are unsatisfiable (416 with `Content-Range:
 * bytes * /<size>`). A header that is not a range at all (no `=`), another
 * unit (`items=…`) and a multi-range list are ignored: the whole file is
 * served (200) — RFC 9110 §14.2 lets a server ignore an invalid Range.
 */

export interface ByteRange {
  /** First byte, inclusive. */
  start: number;
  /** Last byte, inclusive. */
  end: number;
}

export type RangeDecision = ByteRange | 'unsatisfiable' | null;

const SPEC_RE = /^(\d*)-(\d*)$/;

/** The range to serve of a `size`-byte file: a range, 'unsatisfiable' (416), or null (serve all, 200). */
export function parseRange(header: string | null | undefined, size: number): RangeDecision {
  if (typeof header !== 'string') return null;
  const raw = header.trim();
  if (raw === '') return null;
  const eq = raw.indexOf('=');
  if (eq === -1) return null;
  if (raw.slice(0, eq).trim().toLowerCase() !== 'bytes') return null;
  const specs = raw.slice(eq + 1).split(',').map((s) => s.trim());
  if (specs.length !== 1) return specs.every((s) => SPEC_RE.test(s) && s !== '-') ? null : 'unsatisfiable';
  const m = SPEC_RE.exec(specs[0]);
  if (!m || (m[1] === '' && m[2] === '')) return 'unsatisfiable';
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable';
  if (m[2] === '') return { start, end: size - 1 };
  const end = Number(m[2]);
  if (!Number.isSafeInteger(end) || end < start) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

/** `Content-Range` of a 206 answer. */
export function contentRange(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`;
}

/** `Content-Range` of a 416 answer. */
export function unsatisfiedRange(size: number): string {
  return `bytes */${size}`;
}
