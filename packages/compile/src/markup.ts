/**
 * The pattern scans the reference and readiness checks run over HTML and
 * CSS, in linear time. Each reads the text once from left to right, so a
 * file full of unclosed comments, tags or elements costs what a well-formed
 * one does; on well-formed markup each finds exactly what the regular
 * expression in its comment finds.
 */

/** Every character but a newline as a space, so offsets and line numbers stay. */
export const blank = (s: string): string => s.replace(/[^\n]/g, ' ');

/**
 * `text` with every `open…close` span passed through `replace`
 * (`/open[\s\S]*?close/g`). An open without a close, and everything after
 * it, stays as it is.
 */
export function replaceSpans(text: string, open: string, close: string, replace: (span: string) => string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const start = text.indexOf(open, from);
    if (start === -1) break;
    const end = text.indexOf(close, start + open.length);
    if (end === -1) break;
    out += text.slice(from, start) + replace(text.slice(start, end + close.length));
    from = end + close.length;
  }
  return out + text.slice(from);
}

export interface ElementSpan {
  /** Lower-case tag name. */
  name: string;
  /** Index of the start tag's `<`. */
  start: number;
  /** Index after the start tag's `>`. */
  contentStart: number;
  /** Index of the end tag, or the text length when there is none. */
  contentEnd: number;
  /** Index after the end tag, or the text length when there is none. */
  end: number;
  closed: boolean;
}

/**
 * The elements named `names` with their raw content, left to right
 * (`/<(names)\b[^>]*>([\s\S]*?)(<\/\1\s*>|$)/gi`): the start tag runs to its
 * first `>`, the content to the first end tag of the same name in any case.
 * The last one yielded may be unclosed; its content runs to the end.
 */
export function* elements(text: string, names: readonly string[]): Generator<ElementSpan> {
  const open = new RegExp(`<(${names.join('|')})\\b`, 'gi');
  const closers = new Map<string, RegExp>();
  let from = 0;
  for (;;) {
    open.lastIndex = from;
    const m = open.exec(text);
    if (!m) return;
    const gt = text.indexOf('>', open.lastIndex);
    if (gt === -1) return;
    const name = m[1].toLowerCase();
    let close = closers.get(name);
    if (!close) closers.set(name, (close = new RegExp(`</${name}\\s*>`, 'gi')));
    close.lastIndex = gt + 1;
    const c = close.exec(text);
    if (!c) {
      yield { name, start: m.index, contentStart: gt + 1, contentEnd: text.length, end: text.length, closed: false };
      return;
    }
    from = close.lastIndex;
    yield { name, start: m.index, contentStart: gt + 1, contentEnd: c.index, end: from, closed: true };
  }
}

interface StartTagAttr {
  /** As written. */
  name: string;
  /** Raw (not entity-decoded); undefined for an attribute without `=`. */
  value: string | undefined;
  /** Index of the attribute name. */
  at: number;
}

export interface StartTag {
  /** As written. */
  name: string;
  /** Index of `<`. */
  start: number;
  /** Index after `>`. */
  end: number;
  attrs: StartTagAttr[];
}

const TAG_NAME = /[a-zA-Z][a-zA-Z0-9-]*/y;
const SPACE = /\s*/y;
const ATTR_NAME = /[^\s=>/]+/y;
const UNQUOTED = /[^\s"'>]+/y;

/** The index after what `re` (sticky) matches at `at`, else `at`. */
function past(re: RegExp, text: string, at: number): number {
  re.lastIndex = at;
  return re.test(text) ? re.lastIndex : at;
}

/** The start tag whose `<` is at `at`, or the index where the text stops being one. */
function startTagAt(text: string, at: number): StartTag | number {
  const nameEnd = past(TAG_NAME, text, at + 1);
  if (nameEnd === at + 1) return at + 1;
  const name = text.slice(at + 1, nameEnd);
  const attrs: StartTagAttr[] = [];
  let i = nameEnd;
  for (;;) {
    const s = past(SPACE, text, i);
    if (text[s] === '>') return { name, start: at, end: s + 1, attrs };
    if (text[s] === '/' && text[s + 1] === '>') return { name, start: at, end: s + 2, attrs };
    if (s === i) return s;
    const attrEnd = past(ATTR_NAME, text, s);
    if (attrEnd === s) return s;
    let value: string | undefined;
    i = attrEnd;
    const eq = past(SPACE, text, attrEnd);
    if (text[eq] === '=') {
      const v = past(SPACE, text, eq + 1);
      const quote = text[v];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, v + 1);
        if (close === -1) return v;
        value = text.slice(v + 1, close);
        i = close + 1;
      } else {
        const end = past(UNQUOTED, text, v);
        if (end === v) return v;
        value = text.slice(v, end);
        i = end;
      }
    }
    attrs.push({ name: text.slice(s, attrEnd), value, at: s });
  }
}

/**
 * The first start tag at or after `from`, as
 * `/<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g`
 * reads one. Where a `<` does not start a tag, the scan goes on from where
 * the tag broke off, as a browser's tokenizer does, not from the next
 * character: a `<` inside the broken tag is not tried again.
 */
export function nextStartTag(text: string, from: number): StartTag | null {
  for (let at = text.indexOf('<', from); at !== -1; ) {
    const tag = startTagAt(text, at);
    if (typeof tag !== 'number') return tag;
    at = text.indexOf('<', tag);
  }
  return null;
}
