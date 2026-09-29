import { tokenize, type Token } from '../lexer.js';
import type { CheckFinding, ReadinessCheck } from '../types.js';

/**
 * Client-side XSS patterns (NSO-387). An app has no backend of its own, so its
 * attack surface is text other visitors wrote — data/forms records, a gallery
 * copy — rendered in the browser. The app CSP allows inline script, so HTML
 * built from that text runs; it forbids eval, so eval-like calls also fail.
 *
 * A token-level heuristic over the sources (never executed): a sink is
 * reported only when its value is not a literal. Literals, templates without
 * `${}`, and templates whose every `${}` is an escaping call are fine.
 */

const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const JSX_FILE = /\.[jt]sx$/i;
const SKIPPED_FILE = /(?:^|\/)(?:vendor|node_modules)\/|\.min\.[cm]?js$/i;
const MAX_FILE_CHARS = 512 * 1024;

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const JS_TYPE = /\btype\s*=\s*["']?(?:module|text\/javascript|application\/javascript)["']?/i;
const ANY_TYPE = /\btype\s*=/i;
const SRC_ATTR = /\bsrc\s*=/i;

const HTML_PROPS = new Set(['innerHTML', 'outerHTML']);
const URL_PROPS = new Set(['href', 'src']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href']);
const GLOBALS = new Set(['window', 'globalThis', 'self']);
const TIMERS = new Set(['setTimeout', 'setInterval']);
const LITERAL_NAMES = new Set(['null', 'undefined', 'true', 'false']);
/** JSX `src` matters only where it loads a document or script; `<img src={…}>` runs nothing. */
const JSX_SRC_TAGS = new Set(['iframe', 'frame', 'embed', 'object', 'script']);
/** DOM `.src` on an image/media element runs nothing either. */
const MEDIA_OBJECT = /img|image|video|audio|media|avatar|thumb|photo|pic|poster|logo|icon/i;

const ESCAPER = /^esc|escape|sanitiz|encode|purify/i;
const URL_GUARD = /safe|sanit|allow|createObjectURL/i;
const NUMERIC_CALL = /^(?:toFixed|toPrecision|toLocale\w*String|Number|parseInt|parseFloat)$/;
const SAFE_URL_PREFIX = /^(?:\/|\.\.?\/|#|\?|https?:\/\/|mailto:|tel:)/i;

type Kind = 'html' | 'url';

const isP = (t: Token | undefined, v: string): boolean => t?.type === 'punct' && t.value === v;
const isN = (t: Token | undefined, v?: string): boolean => t?.type === 'name' && (v === undefined || t.value === v);

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Index of the bracket that closes the one at `i`, or toks.length. */
function closing(toks: Token[], i: number): number {
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    const t = toks[j];
    if (t.type !== 'punct') continue;
    if (OPEN[t.value]) depth++;
    else if (t.value === ')' || t.value === ']' || t.value === '}') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return toks.length;
}

/**
 * The tokens of the expression starting at `i`: up to a depth-0 `;` `,` or
 * closing bracket, or a line break that is not inside an open expression.
 */
function expression(toks: Token[], i: number): Token[] {
  let depth = 0;
  let j = i;
  for (; j < toks.length; j++) {
    const t = toks[j];
    if (t.type === 'punct') {
      if (OPEN[t.value]) depth++;
      else if (t.value === ')' || t.value === ']' || t.value === '}') {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (t.value === ';' || t.value === ',')) break;
    }
    const next = toks[j + 1];
    if (depth === 0 && next && next.line > t.line && !continues(t, next)) {
      j++;
      break;
    }
  }
  return toks.slice(i, j);
}

function continues(t: Token, next: Token): boolean {
  if (t.type === 'punct' && t.value !== ')' && t.value !== ']' && t.value !== '}' && t.value !== '++' && t.value !== '--') return true;
  return next.type === 'punct' && next.value !== '(' && next.value !== '[' && next.value !== '!' && next.value !== '++' && next.value !== '--';
}

/** Split at depth-0 occurrences of any of `ops`. */
function split(toks: Token[], ops: ReadonlySet<string>): Token[][] {
  const parts: Token[][] = [[]];
  let depth = 0;
  for (const t of toks) {
    if (t.type === 'punct') {
      if (OPEN[t.value]) depth++;
      else if (t.value === ')' || t.value === ']' || t.value === '}') depth--;
      else if (depth === 0 && ops.has(t.value)) {
        parts.push([]);
        continue;
      }
    }
    parts[parts.length - 1].push(t);
  }
  return parts;
}

const PLUS = new Set(['+']);
const OR = new Set(['||', '??']);

/** `(a ? b : c)` → the two branches, or undefined when there is no depth-0 `?`. */
function ternary(toks: Token[]): [Token[], Token[]] | undefined {
  let depth = 0;
  let q = -1;
  let nested = 0;
  for (let j = 0; j < toks.length; j++) {
    const t = toks[j];
    if (t.type !== 'punct') continue;
    if (OPEN[t.value]) depth++;
    else if (t.value === ')' || t.value === ']' || t.value === '}') depth--;
    else if (depth !== 0) continue;
    else if (t.value === '?') {
      if (q === -1) q = j;
      else nested++;
    } else if (t.value === ':' && q !== -1) {
      if (nested > 0) nested--;
      else return [toks.slice(q + 1, j), toks.slice(j + 1)];
    }
  }
  return undefined;
}

function unwrap(toks: Token[]): Token[] {
  while (toks.length >= 2 && isP(toks[0], '(') && closing(toks, 0) === toks.length - 1) toks = toks.slice(1, -1);
  if (isN(toks[0], 'await')) toks = toks.slice(1);
  const as = toks.findIndex((t, j) => isN(t, 'as') && j > 0);
  return as > 0 ? toks.slice(0, as) : toks;
}

/** The last name before the call's `(` when `toks` is exactly one call `a.b.c(…)`. */
function callee(toks: Token[]): string | undefined {
  let j = 0;
  if (isN(toks[0], 'new')) j++;
  if (!isN(toks[j])) return undefined;
  while (isP(toks[j + 1], '.') && isN(toks[j + 2])) j += 2;
  if (!isP(toks[j + 1], '(') || closing(toks, j + 1) !== toks.length - 1) return undefined;
  return toks[j].value;
}

function literal(toks: Token[]): boolean {
  if (toks.length !== 1) return false;
  const t = toks[0];
  return t.type === 'str' || t.type === 'num' || t.type === 'regex' || (t.type === 'tpl' && t.subs?.length === 0) || (t.type === 'name' && LITERAL_NAMES.has(t.value));
}

/** A value that cannot carry markup: a number, a length, a numeric formatter. */
function numeric(toks: Token[]): boolean {
  if (toks.length >= 3 && isP(toks[toks.length - 2], '.') && isN(toks[toks.length - 1], 'length')) return true;
  const name = callee(toks);
  if (name && NUMERIC_CALL.test(name)) return true;
  if (toks.length >= 3 && isN(toks[0], 'Math') && isP(toks[1], '.')) return true;
  return false;
}

/** Any escaping call anywhere in the tokens, template substitutions included. */
function escapes(toks: Token[]): boolean {
  return toks.some(
    (t, j) => (t.type === 'name' && ESCAPER.test(t.value) && isP(toks[j + 1], '(')) || (t.type === 'tpl' && t.subs!.some(escapes))
  );
}

function safeHtml(toks: Token[]): boolean {
  toks = unwrap(toks);
  if (toks.length === 0) return true;
  const branches = ternary(toks);
  if (branches) return safeHtml(branches[0]) && safeHtml(branches[1]);
  const alts = split(toks, OR);
  if (alts.length > 1) return alts.every(safeHtml);
  const parts = split(toks, PLUS);
  if (parts.length > 1) return parts.every(safeHtml);
  if (literal(toks) || numeric(toks)) return true;
  if (toks.length === 1 && toks[0].type === 'tpl') return toks[0].subs!.every((s) => s.length === 0 || safeHtml(s) || escapes(s));
  const name = callee(toks);
  if (name && ESCAPER.test(name)) return true;
  // `items.map((i) => `<li>${esc(i.name)}</li>`).join('')`: every template inside is safe.
  const tpls = toks.filter((t) => t.type === 'tpl');
  let join = toks.length - 1;
  while (join > 0 && !(isN(toks[join], 'join') && isP(toks[join - 1], '.') && isP(toks[join + 1], '('))) join--;
  const joined = join > 0 && closing(toks, join + 1) === toks.length - 1;
  return joined && tpls.length > 0 && tpls.every((t) => safeHtml([t]));
}

function safeUrl(toks: Token[]): boolean {
  toks = unwrap(toks);
  if (toks.length === 0) return true;
  const branches = ternary(toks);
  if (branches) return safeUrl(branches[0]) && safeUrl(branches[1]);
  if (literal(toks)) return true;
  const first = split(toks, PLUS)[0];
  if (first.length === 1 && (first[0].type === 'str' || first[0].type === 'tpl') && SAFE_URL_PREFIX.test(first[0].value)) return true;
  const name = callee(toks);
  if (name && URL_GUARD.test(name)) return true;
  // A FileReader data: URL (`reader.result`, `e.target.result`).
  return toks.length >= 3 && isN(toks[toks.length - 1], 'result') && isP(toks[toks.length - 2], '.');
}

const safe = (kind: Kind, toks: Token[]): boolean => (kind === 'html' ? safeHtml(toks) : safeUrl(toks));

/** The argument token lists of the call whose `(` is at `i`. */
function args(toks: Token[], i: number): Token[][] {
  const end = closing(toks, i);
  const inner = toks.slice(i + 1, end);
  return inner.length === 0 ? [] : split(inner, new Set([','])).filter((a) => a.length > 0);
}

interface Hit {
  code: 'xss_html_sink' | 'xss_eval' | 'xss_url_sink';
  line: number;
  message: string;
}

const HTML_RISK = 'if it can carry text a visitor wrote (a data/forms record, a copied app), that text runs as HTML and script in every viewer\'s browser.';
const URL_RISK = 'a `javascript:` URL from text a visitor wrote runs as script when the link is followed or the frame loads.';
const EVAL_RISK = 'the app\'s Content-Security-Policy blocks string-to-code evaluation (it throws in the browser), and code built from visitor text is script injection.';

function htmlHit(line: number, sink: string): Hit {
  return { code: 'xss_html_sink', line, message: `${sink} is set from a value that is not a literal: ${HTML_RISK}` };
}
function urlHit(line: number, sink: string): Hit {
  return { code: 'xss_url_sink', line, message: `${sink} is set from a value that is not a literal or a fixed-scheme URL: ${URL_RISK}` };
}
function evalHit(line: number, sink: string): Hit {
  return { code: 'xss_eval', line, message: `${sink} evaluates a string as code: ${EVAL_RISK}` };
}

/** Is `toks[i]` a global call target (`eval`, `window.eval`) rather than a method or a declaration? */
function global(toks: Token[], i: number): boolean {
  const prev = toks[i - 1];
  if (isP(prev, '.')) return isN(toks[i - 2]) && GLOBALS.has(toks[i - 2].value) && !isP(toks[i - 3], '.');
  if (isP(prev, '?.') || isN(prev, 'function')) return false;
  // A method definition `eval(x) { … }` in a class or object.
  const end = closing(toks, i + 1);
  return !(isP(toks[end + 1], '{') && (prev === undefined || isP(prev, '{') || isP(prev, '}') || isP(prev, ';') || isP(prev, ',')));
}

function scan(toks: Token[], jsx: boolean, hits: Hit[]): void {
  let tag: string | undefined;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === 'tpl') {
      for (const sub of t.subs!) scan(sub, jsx, hits);
      continue;
    }
    if (t.type !== 'name') {
      if (jsx && isP(t, '<') && isN(toks[i + 1])) tag = toks[i + 1].value;
      continue;
    }
    const prev = toks[i - 1];
    const next = toks[i + 1];
    const v = t.value;
    const member = isP(prev, '.');
    const assigned = isP(next, '=') || isP(next, '+=');

    if (member && HTML_PROPS.has(v) && assigned) {
      if (!safe('html', expression(toks, i + 2))) hits.push(htmlHit(t.line, `\`.${v}\``));
    } else if (member && v === 'insertAdjacentHTML' && isP(next, '(')) {
      const a = args(toks, i + 1)[1];
      if (a && !safe('html', a)) hits.push(htmlHit(t.line, '`insertAdjacentHTML()`'));
    } else if (member && (v === 'write' || v === 'writeln') && isN(toks[i - 2], 'document') && isP(next, '(')) {
      if (args(toks, i + 1).some((a) => !safe('html', a))) hits.push(htmlHit(t.line, `\`document.${v}()\``));
    } else if (v === 'dangerouslySetInnerHTML' && !member && (isP(next, '=') || isP(next, ':'))) {
      const attr = isP(next, '=') && isP(toks[i + 2], '{');
      if (!dangerousHtmlSafe(toks, attr ? i + 3 : i + 2, attr)) hits.push(htmlHit(t.line, '`dangerouslySetInnerHTML`'));
    } else if (v === 'eval' && isP(next, '(') && global(toks, i)) {
      hits.push(evalHit(t.line, '`eval()`'));
    } else if (v === 'Function' && isP(next, '(') && (isN(prev, 'new') || global(toks, i))) {
      hits.push(evalHit(t.line, '`new Function()`'));
    } else if (TIMERS.has(v) && isP(next, '(') && (!member || global(toks, i))) {
      const first = args(toks, i + 1)[0];
      if (first && (first[0].type === 'str' || first[0].type === 'tpl')) hits.push(evalHit(t.line, `\`${v}()\` with a string`));
    } else if (member && URL_PROPS.has(v) && isP(next, '=')) {
      if (v === 'src' && MEDIA_OBJECT.test(objectName(toks, i))) continue;
      if (!safe('url', expression(toks, i + 2))) hits.push(urlHit(t.line, `\`.${v}\``));
    } else if (member && v === 'setAttribute' && isP(next, '(')) {
      const [name, value] = args(toks, i + 1);
      const attr = name?.length === 1 && name[0].type === 'str' ? name[0].value.toLowerCase() : undefined;
      if (!attr || !URL_ATTRS.has(attr) || !value) continue;
      if (attr === 'src' && MEDIA_OBJECT.test(objectName(toks, i))) continue;
      if (!safe('url', value)) hits.push(urlHit(t.line, `\`setAttribute('${attr}')\``));
    } else if (member && (v === 'assign' || v === 'replace') && isN(toks[i - 2], 'location') && isP(next, '(')) {
      const first = args(toks, i + 1)[0];
      if (first && !safe('url', first)) hits.push(urlHit(t.line, `\`location.${v}()\``));
    } else if (v === 'location' && isP(next, '=') && (!member || GLOBALS.has(toks[i - 2]?.value ?? ''))) {
      if (!member && (isN(prev, 'let') || isN(prev, 'const') || isN(prev, 'var'))) continue;
      if (!safe('url', expression(toks, i + 2))) hits.push(urlHit(t.line, '`location`'));
    } else if (jsx && !member && isP(next, '=') && isP(toks[i + 2], '{') && (v === 'href' || (v === 'src' && tag !== undefined && JSX_SRC_TAGS.has(tag)))) {
      const end = closing(toks, i + 2);
      if (!safe('url', toks.slice(i + 3, end))) hits.push(urlHit(t.line, `JSX \`${v}\``));
    }
  }
}

/** The object a member is read from: `photoImg` in `this.photoImg.src`. */
function objectName(toks: Token[], i: number): string {
  const obj = toks[i - 2];
  if (!obj) return '';
  if (obj.type === 'name') return obj.value;
  if (isP(obj, ')') || isP(obj, ']')) {
    // `document.getElementById('photo').src`, `imgs[i].src`: look into the call/index.
    let depth = 0;
    for (let j = i - 2; j >= 0; j--) {
      const t = toks[j];
      if (isP(t, ')') || isP(t, ']')) depth++;
      else if (isP(t, '(') || isP(t, '[')) depth--;
      if (depth === 0) return toks.slice(Math.max(0, j - 1), i - 1).map((x) => x.value).join(' ');
    }
  }
  return '';
}

/** `dangerouslySetInnerHTML={{ __html: <safe> }}` / `dangerouslySetInnerHTML: { __html: <safe> }`. */
function dangerousHtmlSafe(toks: Token[], start: number, jsxAttr: boolean): boolean {
  const value = jsxAttr ? toks.slice(start, closing(toks, start - 1)) : expression(toks, start);
  if (!isP(value[0], '{')) return false;
  const obj = value.slice(1, closing(value, 0));
  const entries = split(obj, new Set([',']));
  const html = entries.find((e) => (isN(e[0], '__html') || (e[0]?.type === 'str' && e[0].value === '__html')));
  if (!html || !isP(html[1], ':')) return false;
  return safeHtml(html.slice(2));
}

function scanSource(source: string, firstLine: number, jsx: boolean, hits: Hit[]): void {
  scan(tokenize(source, firstLine), jsx, hits);
}

function htmlScripts(html: string, hits: Hit[]): void {
  SCRIPT_TAG.lastIndex = 0;
  for (let m = SCRIPT_TAG.exec(html); m; m = SCRIPT_TAG.exec(html)) {
    const attrs = m[1];
    if (SRC_ATTR.test(attrs) || (ANY_TYPE.test(attrs) && !JS_TYPE.test(attrs))) continue;
    const bodyAt = m.index + m[0].indexOf('>') + 1;
    let line = 1;
    for (let i = 0; i < bodyAt; i++) if (html.charCodeAt(i) === 10) line++;
    scanSource(m[2], line, false, hits);
  }
}

export const clientXss: ReadinessCheck = {
  id: 'client-xss',
  codes: ['xss_html_sink', 'xss_eval', 'xss_url_sink'],
  run({ files }) {
    const found: CheckFinding[] = [];
    for (const [file, content] of files) {
      if (typeof content !== 'string' || content.length > MAX_FILE_CHARS || SKIPPED_FILE.test(file)) continue;
      const script = SCRIPT_FILE.test(file);
      if (!script && !/\.html?$/i.test(file)) continue;
      const hits: Hit[] = [];
      try {
        if (script) scanSource(content, 1, JSX_FILE.test(file), hits);
        else htmlScripts(content, hits);
      } catch {
        continue;
      }
      const seen = new Set<string>();
      for (const h of hits) {
        const key = `${h.code}:${h.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ code: h.code, file, line: h.line, message: h.message });
      }
    }
    return found;
  },
};
