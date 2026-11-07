/**
 * Path routing (APPS_ROUTING_MODE=path): an app is served under a base path
 * of the one apps origin, `/apps/<label>` (host.ts `parseAppPath`), instead of
 * at the root of its own host. Its HTML is made to work under that base at
 * serve time, explicitly and only in this mode:
 *
 *  - `<base href="<base>/">` and `<meta name="drobek-base" content="<base>/">`
 *    are inserted at the start of `<head>` (else after `<html>`, else after the
 *    doctype, else at the start), so relative URLs — also those the bundle's
 *    code builds, and the bundler's relative asset URLs — resolve under the
 *    app on every nested route, and the SDK and the beacon find their base;
 *  - a root-absolute URL (`/main.js`, not `//host`) in a URL attribute of a
 *    start tag (`src`, `href`, `action`, `formaction`, `poster`, `srcset`) is
 *    prefixed with the base. Tags are read with the compiler's start-tag
 *    reader; the raw text of `<script>`, `<style>` and `<textarea>` is left as
 *    it is.
 *
 * Nothing else is rewritten: a root-absolute URL the app's JavaScript or CSS
 * builds itself stays as written and misses the app — the skills tell agents
 * to use relative URLs (or `document.baseURI`) for that reason.
 */
import { elements, startTagReader } from '@drobek/compile';

const URL_ATTRS = new Set(['src', 'href', 'action', 'formaction', 'poster']);
const RAW_TEXT = ['script', 'style', 'textarea'];

/** `<base>`-safe: only the characters a label path can have. */
function assertBase(base: string): void {
  if (!/^\/apps\/[a-z0-9-]+$/.test(base)) throw new Error(`invalid app base path: ${base}`);
}

function rootAbsolute(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\');
}

/** Each comma-separated candidate URL of a `srcset`, prefixed when root-absolute. */
function prefixSrcset(value: string, base: string): string {
  return value
    .split(',')
    .map((part) => {
      const lead = part.length - part.trimStart().length;
      const url = part.trimStart();
      return rootAbsolute(url) ? `${part.slice(0, lead)}${base}${url}` : part;
    })
    .join(',');
}

/** The index of the value's first character for attribute `at` of a tag ending at `end`; -1 for no value. */
function valueStart(text: string, at: number, end: number): number {
  let i = at;
  while (i < end && !/[\s=>/]/.test(text[i])) i++;
  while (i < end && /\s/.test(text[i])) i++;
  if (text[i] !== '=') return -1;
  i++;
  while (i < end && /\s/.test(text[i])) i++;
  return text[i] === '"' || text[i] === "'" ? i + 1 : i;
}

/** The HTML document `html` made to work under `base` (see the module comment). */
export function withAppBase(html: Buffer, base: string): Buffer {
  assertBase(base);
  // latin1 keeps every byte as one character: the edits are ASCII, the rest stays byte for byte.
  const text = html.toString('latin1');
  const raw: Array<[number, number]> = [];
  for (const el of elements(text, RAW_TEXT)) raw.push([el.contentStart, el.contentEnd]);
  const inRaw = (i: number) => raw.some(([a, b]) => i >= a && i < b);

  const edits: Array<{ at: number; remove: number; insert: string }> = [];
  let head: number | null = null;
  let htmlEnd: number | null = null;
  const next = startTagReader(text);
  for (let tag = next(0); tag; tag = next(tag.end)) {
    if (inRaw(tag.start)) continue;
    const name = tag.name.toLowerCase();
    if (name === 'head' && head === null) head = tag.end;
    if (name === 'html' && htmlEnd === null) htmlEnd = tag.end;
    for (const attr of tag.attrs) {
      const attrName = attr.name.toLowerCase();
      if (attr.value === undefined || (!URL_ATTRS.has(attrName) && attrName !== 'srcset')) continue;
      const out = attrName === 'srcset' ? prefixSrcset(attr.value, base) : rootAbsolute(attr.value) ? `${base}${attr.value}` : attr.value;
      if (out === attr.value) continue;
      const at = valueStart(text, attr.at, tag.end);
      if (at === -1 || text.slice(at, at + attr.value.length) !== attr.value) continue;
      edits.push({ at, remove: attr.value.length, insert: out });
    }
  }
  let insertAt = head ?? htmlEnd;
  if (insertAt === null) {
    const doctype = /^\s*<!doctype[^>]*>/i.exec(text);
    insertAt = doctype ? doctype[0].length : 0;
  }
  edits.push({ at: insertAt, remove: 0, insert: `<base href="${base}/"><meta name="drobek-base" content="${base}/">` });
  edits.sort((a, b) => a.at - b.at);

  let out = '';
  let from = 0;
  for (const e of edits) {
    out += text.slice(from, e.at) + e.insert;
    from = e.at + e.remove;
  }
  return Buffer.from(out + text.slice(from), 'latin1');
}
