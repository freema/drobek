/**
 * A light, dependency-free syntax highlighter for the read-only file viewer
 * (NSO-288 Files tab). It only tokenizes — the component renders each token
 * as a React text node inside a <span>, so app source can never become
 * markup (no dangerouslySetInnerHTML). Lossless: the tokens concatenate back
 * to the input exactly (unit-tested). Deliberately small: comments, strings,
 * numbers, keywords, tags — not a parser.
 */

export type TokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'tag' | 'attr' | 'punct';
export type Language = 'js' | 'css' | 'html' | 'json' | 'plain';

export interface Token {
  /** null = plain text. */
  kind: TokenKind | null;
  text: string;
}

/** Above this size the viewer shows plain text (tokenizing stays cheap). */
export const HIGHLIGHT_MAX_CHARS = 200_000;

const EXT_LANG: Record<string, Language> = {
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  ts: 'js',
  tsx: 'js',
  mts: 'js',
  css: 'css',
  html: 'html',
  htm: 'html',
  svg: 'html',
  xml: 'html',
  json: 'json',
  webmanifest: 'json',
};

export function languageOf(path: string): Language {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return (m && EXT_LANG[m[1].toLowerCase()]) || 'plain';
}

const JS_KEYWORDS = new Set(
  (
    'as async await break case catch class const continue debugger default delete do else enum export extends ' +
    'false finally for from function if implements import in instanceof interface let new null of return ' +
    'static super switch this throw true try type typeof undefined var void while with yield'
  ).split(' ')
);

interface Rule {
  re: RegExp;
  kind: (match: string) => TokenKind | null;
}

const RULES: Record<Exclude<Language, 'plain'>, Rule[]> = {
  js: [
    { re: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y, kind: () => 'comment' },
    { re: /"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\[\s\S])*`?/y, kind: () => 'string' },
    { re: /\b(?:0[xob][0-9a-f_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?n?)\b/iy, kind: () => 'number' },
    { re: /[A-Za-z_$][\w$]*/y, kind: (m) => (JS_KEYWORDS.has(m) ? 'keyword' : null) },
  ],
  css: [
    { re: /\/\*[\s\S]*?(?:\*\/|$)/y, kind: () => 'comment' },
    { re: /"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?/y, kind: () => 'string' },
    { re: /@[a-z-]+/iy, kind: () => 'keyword' },
    { re: /#[0-9a-f]{3,8}\b|-?\b\d+(?:\.\d+)?(?:[a-z]+|%)?/iy, kind: () => 'number' },
    { re: /[{};:]/y, kind: () => 'punct' },
  ],
  html: [
    { re: /<!--[\s\S]*?(?:-->|$)/y, kind: () => 'comment' },
    { re: /<\/?[A-Za-z][\w:-]*|\/?>/y, kind: () => 'tag' },
    { re: /"[^"]*"?|'[^']*'?/y, kind: () => 'string' },
    { re: /[A-Za-z_:][\w:.-]*(?==)/y, kind: () => 'attr' },
  ],
  json: [
    { re: /"(?:[^"\\\n]|\\.)*"?/y, kind: () => 'string' },
    { re: /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/iy, kind: () => 'number' },
    { re: /\b(?:true|false|null)\b/y, kind: () => 'keyword' },
  ],
};

/** Tokenize `code` for `lang`; plain (or oversized) input is one plain token. */
export function highlight(code: string, lang: Language): Token[] {
  if (lang === 'plain' || code.length > HIGHLIGHT_MAX_CHARS) return code ? [{ kind: null, text: code }] : [];
  const rules = RULES[lang];
  const out: Token[] = [];
  let plain = '';
  const push = (kind: TokenKind | null, text: string) => {
    if (kind === null) {
      plain += text;
      return;
    }
    if (plain) out.push({ kind: null, text: plain });
    plain = '';
    out.push({ kind, text });
  };
  let i = 0;
  outer: while (i < code.length) {
    for (const rule of rules) {
      rule.re.lastIndex = i;
      const m = rule.re.exec(code);
      if (m && m[0].length > 0) {
        push(rule.kind(m[0]), m[0]);
        i += m[0].length;
        continue outer;
      }
    }
    push(null, code[i]);
    i += 1;
  }
  if (plain) out.push({ kind: null, text: plain });
  return out;
}
