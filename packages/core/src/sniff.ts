/**
 * What stored bytes ARE, decided from their first bytes — never from a
 * client's Content-Type or a file name. PURE, shared by the files module
 * (end-user uploads) and app assets (@drobek/apps, NSO-358), so both refuse
 * the same disguised HTML page named `.png`.
 *
 *   image/png         89 50 4E 47 0D 0A 1A 0A
 *   image/jpeg        FF D8 FF
 *   image/gif         "GIF87a" | "GIF89a"
 *   image/webp        "RIFF" …… "WEBP"
 *   application/pdf   "%PDF-"
 *   video/mp4         …… "ftyp" + an MP4 brand (isom, mp41, mp42, avc1, M4V …)
 *   audio/mp4         …… "ftyp" + the "M4A " / "M4B " brand
 *   video/webm        1A 45 DF A3 (EBML) with the "webm" DocType in the header
 *   audio/mpeg        "ID3" | an MPEG audio Layer III frame sync (FF Ex/Fx)
 *   audio/ogg         "OggS"
 *   audio/wav         "RIFF" …… "WAVE"
 *   font/woff         "wOFF"
 *   font/woff2        "wOF2"
 *
 * `ftyp` boxes of image formats (AVIF, HEIC) and QuickTime are NOT MP4 video
 * here: their brands are not on the list, so they sniff as nothing.
 *
 * SVG has no magic bytes: `looksLikeSvg` recognises an `<svg` root after an
 * optional prolog. The caller checks that the whole stream is text.
 */

export type SniffedType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'application/pdf'
  | 'video/mp4'
  | 'audio/mp4'
  | 'video/webm'
  | 'audio/mpeg'
  | 'audio/ogg'
  | 'audio/wav'
  | 'font/woff'
  | 'font/woff2';

/** How many leading bytes `sniffSignature` needs to tell every type apart (the EBML header of WebM). */
export const SIGNATURE_HEAD_BYTES = 64;

const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'mp71',
  'avc1',
  'M4V ',
  'M4VH',
  'M4VP',
  'MSNV',
  'dash',
  'f4v ',
  'mmp4',
]);
const M4A_BRANDS = new Set(['M4A ', 'M4B ']);

const startsWith = (b: Buffer, sig: number[] | string, at = 0): boolean => {
  const bytes = typeof sig === 'string' ? Buffer.from(sig, 'latin1') : Buffer.from(sig);
  return b.length >= at + bytes.length && b.subarray(at, at + bytes.length).equals(bytes);
};

/** An MPEG audio frame header whose layer is III (and whose version is not reserved). */
function mp3FrameSync(b: Buffer): boolean {
  if (b.length < 2 || b[0] !== 0xff || (b[1] & 0xe0) !== 0xe0) return false;
  const version = (b[1] >> 3) & 0x03;
  const layer = (b[1] >> 1) & 0x03;
  return version !== 0x01 && layer === 0x01;
}

/** The type of some stored bytes from their first bytes (≥ SIGNATURE_HEAD_BYTES when there are that many), or null. */
export function sniffSignature(head: Buffer): SniffedType | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, 'GIF87a') || startsWith(head, 'GIF89a')) return 'image/gif';
  if (startsWith(head, 'RIFF') && startsWith(head, 'WEBP', 8)) return 'image/webp';
  if (startsWith(head, 'RIFF') && startsWith(head, 'WAVE', 8)) return 'audio/wav';
  if (startsWith(head, '%PDF-')) return 'application/pdf';
  if (startsWith(head, 'ftyp', 4) && head.length >= 12) {
    const brand = head.subarray(8, 12).toString('latin1');
    if (MP4_BRANDS.has(brand)) return 'video/mp4';
    if (M4A_BRANDS.has(brand)) return 'audio/mp4';
    return null;
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    return head.subarray(4, SIGNATURE_HEAD_BYTES).includes('webm', 0, 'latin1') ? 'video/webm' : null;
  }
  if (startsWith(head, 'OggS')) return 'audio/ogg';
  if (startsWith(head, 'wOFF')) return 'font/woff';
  if (startsWith(head, 'wOF2')) return 'font/woff2';
  if (startsWith(head, 'ID3') || mp3FrameSync(head)) return 'audio/mpeg';
  return null;
}

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

/** A C0 control character other than tab, LF, CR (never in a text file drobek accepts). */
export function hasControlBytes(chunk: Buffer): boolean {
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
  }
  return false;
}
