/**
 * Source maps on the production hosts. The compiler writes every
 * JS/CSS bundle with an INLINE source map (a base64 `data:` URL at the end of
 * the file) — the preview host serves the bundle exactly as stored. On the
 * production host and custom domains that trailer made a bundle several times
 * its code size, so the handler serves the bundle WITHOUT it and a
 * `sourceMappingURL` comment pointing at `<file>.map`, where the same map is
 * served. Browsers fetch the map only when devtools opens, so a visitor
 * downloads just the code; debugging a published app works as before.
 * Pure: the stored version is never rewritten, so every version published
 * before this change is served the same way.
 */
import { extensionOf } from './content-type.js';

export interface SplitSourceMap {
  /** The bundle without its inline map, ending in a `sourceMappingURL` comment naming `<file>.map`. */
  code: Buffer;
  /** The decoded source map JSON. */
  map: Buffer;
}

const JS_EXTS = new Set(['js', 'mjs']);
const JS_MARKER = Buffer.from('\n//# sourceMappingURL=data:');
const CSS_MARKER = Buffer.from('\n/*# sourceMappingURL=data:');
const DATA_HEADER_RE = /^application\/json(?:;charset=utf-8)?;base64$/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Can the file at `path` carry an inline map this module splits (a JS or CSS bundle)? */
export function mayCarryInlineSourceMap(path: string): boolean {
  const ext = extensionOf(path);
  return JS_EXTS.has(ext) || ext === 'css';
}

/**
 * Split the inline source map off a JS/CSS bundle. null when the file has
 * none — or anything about the trailer is not the compiler's exact shape
 * (then the file is served unchanged).
 */
export function splitInlineSourceMap(bytes: Buffer, path: string): SplitSourceMap | null {
  const ext = extensionOf(path);
  const css = ext === 'css';
  if (!css && !JS_EXTS.has(ext)) return null;
  const marker = css ? CSS_MARKER : JS_MARKER;
  const at = bytes.lastIndexOf(marker);
  if (at === -1) return null;

  let rest = bytes.subarray(at + marker.length).toString('latin1').trimEnd();
  if (css) {
    if (!rest.endsWith('*/')) return null;
    rest = rest.slice(0, -2).trimEnd();
  }
  const comma = rest.indexOf(',');
  if (comma === -1 || !DATA_HEADER_RE.test(rest.slice(0, comma))) return null;
  const b64 = rest.slice(comma + 1);
  if (!BASE64_RE.test(b64)) return null;
  const map = Buffer.from(b64, 'base64');
  if (map.length === 0 || map.toString('utf8', 0, Math.min(map.length, 64)).trimStart()[0] !== '{') return null;

  const name = encodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
  const comment = css ? `/*# sourceMappingURL=${name}.map */\n` : `//# sourceMappingURL=${name}.map\n`;
  return { code: Buffer.concat([bytes.subarray(0, at + 1), Buffer.from(comment)]), map };
}
