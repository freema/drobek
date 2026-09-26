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
 *
 * The signatures and the SVG root check live in @drobek/core (shared with app
 * assets, NSO-358); this file narrows them to the module's types.
 */
import { hasControlBytes, looksLikeSvg, sniffSignature } from '@drobek/modules';

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

const FILE_TYPE_SET: ReadonlySet<string> = new Set(FILE_TYPES);

/** The binary type of a file from its first bytes, or null (the shared sniffer, narrowed to the files module's types). */
export function sniffBinary(head: Buffer): FileType | null {
  const type = sniffSignature(head);
  return type !== null && FILE_TYPE_SET.has(type) ? (type as FileType) : null;
}

/** Enough bytes to tell every binary signature apart. */
const MAGIC_BYTES = 12;

/** The SVG root check is shared with app assets (@drobek/core, NSO-358). */
export { looksLikeSvg };

const MARKUP_RE = /<!doctype|<html|<script|<\?xml|<svg|<body|<iframe/i;

const CSV_TYPES = new Set(['text/csv', 'application/csv', 'text/comma-separated-values', 'application/vnd.ms-excel', 'text/x-csv']);

/** Does the client call it CSV (type or `.csv` name)? */
export function claimsCsv(declaredType: string | null, filename: string): boolean {
  const t = (declaredType ?? '').split(';')[0].trim().toLowerCase();
  return CSV_TYPES.has(t) || /\.csv$/i.test(filename.trim());
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
