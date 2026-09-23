/**
 * What a stored file IS, decided from its bytes — never from the client's
 * Content-Type or file name (§5.5). PURE, unit tested.
 *
 *   image/png   89 50 4E 47 0D 0A 1A 0A
 *   image/jpeg  FF D8 FF
 *   image/gif   "GIF87a" | "GIF89a"
 *   image/webp  "RIFF" …… "WEBP"
 *   application/pdf  "%PDF-"
 *
 * The two text types have no magic bytes, so they are recognised
 * conservatively, over the WHOLE stream: the bytes must be valid UTF-8 with no
 * control characters other than tab / CR / LF (checked chunk by chunk), and
 *
 *   image/svg+xml  the document starts (after an optional BOM, XML
 *                  declaration, comments and an `<!DOCTYPE svg …>`) with an
 *                  `<svg` root element;
 *   text/csv       the client says it is CSV (`text/csv`-ish type or a `.csv`
 *                  name — a restriction, never a promotion: anything binary
 *                  or markup-like is refused whatever the client says) and it
 *                  holds no markup: its first character is not `<` and its
 *                  head has no `<!doctype` / `<html` / `<script`.
 *
 * Anything else — an HTML page named `.png`, an executable, a ZIP — is
 * `unsupported_type`. SVG and CSV are served as attachments only (serve.ts).
 */

export const FILE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'application/pdf', 'text/csv'] as const;
export type FileType = (typeof FILE_TYPES)[number];

/** What `allowedTypes` may list: a type, or `image/*` for every image type. */
export const TYPE_PATTERNS = ['image/*', ...FILE_TYPES] as const;
export type TypePattern = (typeof TYPE_PATTERNS)[number];

/** Does `allowed` (config `allowedTypes`) admit `type`? */
export function typeAllowed(type: FileType, allowed: readonly string[]): boolean {
  return allowed.includes(type) || (type.startsWith('image/') && allowed.includes('image/*'));
}

/** Bytes of the head the markup checks look at. */
export const SNIFF_HEAD_BYTES = 16 * 1024;

const startsWith = (b: Buffer, sig: number[] | string, at = 0): boolean => {
  const bytes = typeof sig === 'string' ? Buffer.from(sig, 'latin1') : Buffer.from(sig);
  return b.length >= at + bytes.length && b.subarray(at, at + bytes.length).equals(bytes);
};

/** The binary type of a file from its first bytes, or null. */
export function sniffBinary(head: Buffer): FileType | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, 'GIF87a') || startsWith(head, 'GIF89a')) return 'image/gif';
  if (startsWith(head, 'RIFF') && startsWith(head, 'WEBP', 8)) return 'image/webp';
  if (startsWith(head, '%PDF-')) return 'application/pdf';
  return null;
}

/** Enough bytes to tell every binary signature apart. */
const MAGIC_BYTES = 12;

/** Most prolog items (declaration, PIs, comments) looked past before `<svg`. */
const SVG_PROLOG_MAX_ITEMS = 64;
// Sticky (`y`): matched at `lastIndex`, never scanning ahead.
const SVG_ROOT_RE = /<svg[\s>/]/iy;
const DOCTYPE_SVG_RE = /<!DOCTYPE[ \t\r\n]+svg(?=[ \t\r\n>[])/iy;

const matchesAt = (re: RegExp, s: string, at: number): boolean => {
  re.lastIndex = at;
  return re.test(s);
};

const isXmlSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/**
 * Does the (BOM-stripped) head start with an `<svg` root? Whitespace, then any
 * mix of XML declarations / processing instructions (`<?…?>`) and comments
 * (`<!--…-->`) — at most SVG_PROLOG_MAX_ITEMS — and one `<!DOCTYPE svg …>`
 * (with an optional `[…]` internal subset), then `<svg`.
 *
 * A linear scanner on purpose: the regex it replaces backtracked
 * exponentially on repeated `<?xml?>` (NSO-322 R1). Every step moves `i`
 * forward through `indexOf`, so the cost is O(head length). An unterminated
 * item is not an SVG.
 */
export function looksLikeSvg(head: string): boolean {
  let i = 0;
  const skipSpace = (): void => {
    while (i < head.length && isXmlSpace(head[i])) i++;
  };
  let doctype = false;
  for (let items = 0; items <= SVG_PROLOG_MAX_ITEMS; items++) {
    skipSpace();
    if (head.startsWith('<?', i)) {
      const end = head.indexOf('?>', i + 2);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    if (head.startsWith('<!--', i)) {
      const end = head.indexOf('-->', i + 4);
      if (end < 0) return false;
      i = end + 3;
      continue;
    }
    if (!doctype && matchesAt(DOCTYPE_SVG_RE, head, i)) {
      doctype = true;
      const gt = head.indexOf('>', i);
      const bracket = head.indexOf('[', i);
      if (gt < 0) return false;
      if (bracket < 0 || gt < bracket) {
        i = gt + 1;
        continue;
      }
      // An internal subset: `[` … `]`, optional whitespace, `>`.
      const close = head.indexOf(']', bracket + 1);
      if (close < 0) return false;
      i = close + 1;
      skipSpace();
      if (head[i] !== '>') return false;
      i++;
      continue;
    }
    return matchesAt(SVG_ROOT_RE, head, i);
  }
  return false;
}
const MARKUP_RE = /<!doctype|<html|<script|<\?xml|<svg|<body|<iframe/i;

const CSV_TYPES = new Set(['text/csv', 'application/csv', 'text/comma-separated-values', 'application/vnd.ms-excel', 'text/x-csv']);

/** Does the client call it CSV (type or `.csv` name)? */
export function claimsCsv(declaredType: string | null, filename: string): boolean {
  const t = (declaredType ?? '').split(';')[0].trim().toLowerCase();
  return CSV_TYPES.has(t) || /\.csv$/i.test(filename.trim());
}

/** A C0 control character other than tab, LF, CR (never in a text file we accept). */
function hasControlBytes(chunk: Buffer): boolean {
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
  }
  return false;
}

/**
 * Streaming sniffer: `update()` every chunk, then `finish()`. `rejected`
 * turns true as soon as the bytes can be neither a binary type nor text
 * (the upload can stop early).
 */
export class TypeSniffer {
  private head = Buffer.alloc(0);
  private binary: FileType | null | undefined = undefined;
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private text = true;
  private bytes = 0;

  update(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.head.length < SNIFF_HEAD_BYTES) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, SNIFF_HEAD_BYTES - this.head.length)]);
    }
    if (this.binary === undefined && this.head.length >= MAGIC_BYTES) this.binary = sniffBinary(this.head);
    if (this.binary) return;
    if (this.text) {
      if (hasControlBytes(chunk)) {
        this.text = false;
        return;
      }
      try {
        this.decoder.decode(chunk, { stream: true });
      } catch {
        this.text = false;
      }
    }
  }

  /** True once the bytes can no longer be any accepted type. */
  get rejected(): boolean {
    return this.binary === null && !this.text;
  }

  /** The type of the whole file, or null (unsupported). */
  finish(declaredType: string | null, filename: string): FileType | null {
    if (this.bytes === 0) return null;
    if (this.binary === undefined) this.binary = sniffBinary(this.head);
    if (this.binary) return this.binary;
    if (!this.text) return null;
    try {
      this.decoder.decode(); // a truncated multi-byte sequence at the end throws
    } catch {
      return null;
    }
    let head = this.head.toString('utf8');
    if (head.charCodeAt(0) === 0xfeff) head = head.slice(1); // a UTF-8 BOM
    if (looksLikeSvg(head)) return 'image/svg+xml';
    const first = head.trimStart()[0];
    if (claimsCsv(declaredType, filename) && first !== '<' && !MARKUP_RE.test(head)) return 'text/csv';
    return null;
  }
}

/** Sniff a whole buffer (tests, small inputs). */
export function sniffType(bytes: Buffer, declaredType: string | null = null, filename = ''): FileType | null {
  const s = new TypeSniffer();
  s.update(bytes);
  return s.finish(declaredType, filename);
}

/** A file extension for a type (download names). */
export function extensionOf(type: FileType): string {
  switch (type) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/svg+xml':
      return 'svg';
    case 'application/pdf':
      return 'pdf';
    case 'text/csv':
      return 'csv';
  }
}
