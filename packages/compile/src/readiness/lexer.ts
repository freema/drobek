/**
 * A small, linear JS/TS/JSX tokenizer for the readiness checks: no AST, no
 * execution. It knows enough to tell code from strings, template literals,
 * comments and regular expressions, which is what a pattern check over the
 * token stream needs. A string ends at the end of its line, so JSX text such
 * as `<p>don't</p>` costs at most the rest of that line.
 */

type TokenType = 'name' | 'punct' | 'str' | 'tpl' | 'num' | 'regex';

export interface Token {
  type: TokenType;
  /** The name, the operator, or a literal's text without its quotes (for `tpl` the first chunk, before any `${`). */
  value: string;
  line: number;
  /** `tpl` only: the token streams of its `${…}` substitutions, in order (empty for a plain template). */
  subs?: Token[][];
}

const PUNCT = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '&&', '||', '??', '?.', '++', '--', '<<', '>>', '**',
];
const REGEX_AFTER_NAME = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);
const NAME = /[\p{ID_Start}$_\\][\p{ID_Continue}$\u200c\u200d\\]*/uy;
const NUM = /(?:\d|\.\d)[\w.]*/y;
const MAX_DEPTH = 32;

class Lexer {
  pos = 0;
  line = 1;
  constructor(readonly src: string) {}

  /** Tokens up to the end of input, or (inside `${…}`) up to the brace that closes the substitution. */
  lex(depth: number): Token[] {
    if (depth > MAX_DEPTH) throw new Error('template nesting too deep');
    const src = this.src;
    const out: Token[] = [];
    let braces = 0;
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (c === '\n') {
        this.line++;
        this.pos++;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff') {
        this.pos++;
        continue;
      }
      if (c === '/' && src[this.pos + 1] === '/') {
        const end = src.indexOf('\n', this.pos);
        this.pos = end === -1 ? src.length : end;
        continue;
      }
      if (c === '/' && src[this.pos + 1] === '*') {
        const end = src.indexOf('*/', this.pos + 2);
        const stop = end === -1 ? src.length : end + 2;
        this.countLines(this.pos, stop);
        this.pos = stop;
        continue;
      }
      const line = this.line;
      if (c === '"' || c === "'") {
        out.push({ type: 'str', value: this.string(c), line });
        continue;
      }
      if (c === '`') {
        out.push(this.template(depth, line));
        continue;
      }
      if (c === '/' && regexAllowed(out[out.length - 1])) {
        out.push({ type: 'regex', value: this.regex(), line });
        continue;
      }
      NAME.lastIndex = this.pos;
      const name = NAME.exec(src);
      if (name) {
        out.push({ type: 'name', value: name[0], line });
        this.pos = NAME.lastIndex;
        continue;
      }
      NUM.lastIndex = this.pos;
      const num = NUM.exec(src);
      if (num) {
        out.push({ type: 'num', value: num[0], line });
        this.pos = NUM.lastIndex;
        continue;
      }
      if (c === '{') braces++;
      if (c === '}') {
        if (depth > 0 && braces === 0) {
          this.pos++;
          return out;
        }
        braces--;
      }
      const op = PUNCT.find((p) => src.startsWith(p, this.pos)) ?? c;
      out.push({ type: 'punct', value: op, line });
      this.pos += op.length;
    }
    return out;
  }

  private countLines(from: number, to: number): void {
    for (let i = from; i < to; i++) if (this.src.charCodeAt(i) === 10) this.line++;
  }

  private string(quote: string): string {
    const src = this.src;
    const start = ++this.pos;
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (c === '\\') {
        if (src[this.pos + 1] === '\n') this.line++;
        this.pos += 2;
        continue;
      }
      if (c === quote) return src.slice(start, this.pos++);
      if (c === '\n') break;
      this.pos++;
    }
    return src.slice(start, this.pos);
  }

  private template(depth: number, line: number): Token {
    const src = this.src;
    this.pos++;
    let head: string | undefined;
    let chunk = this.pos;
    const subs: Token[][] = [];
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (c === '\\') {
        if (src[this.pos + 1] === '\n') this.line++;
        this.pos += 2;
        continue;
      }
      if (c === '\n') this.line++;
      if (c === '`') {
        head ??= src.slice(chunk, this.pos);
        this.pos++;
        return { type: 'tpl', value: head, line, subs };
      }
      if (c === '$' && src[this.pos + 1] === '{') {
        head ??= src.slice(chunk, this.pos);
        this.pos += 2;
        subs.push(this.lex(depth + 1));
        chunk = this.pos;
        continue;
      }
      this.pos++;
    }
    return { type: 'tpl', value: head ?? src.slice(chunk), line, subs };
  }

  private regex(): string {
    const src = this.src;
    const start = ++this.pos;
    let inClass = false;
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (c === '\n') break;
      if (c === '\\') {
        this.pos += 2;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        const body = src.slice(start, this.pos++);
        while (this.pos < src.length && /[a-z]/i.test(src[this.pos])) this.pos++;
        return body;
      }
      this.pos++;
    }
    return src.slice(start, this.pos);
  }
}

function regexAllowed(prev: Token | undefined): boolean {
  if (!prev) return true;
  if (prev.type === 'name') return REGEX_AFTER_NAME.has(prev.value);
  if (prev.type === 'punct') return prev.value !== ')' && prev.value !== ']' && prev.value !== '}' && prev.value !== '<';
  return false;
}

/** Tokenize `src`; `firstLine` is the line number of its first character (an inline `<script>` in HTML). */
export function tokenize(src: string, firstLine = 1): Token[] {
  const lexer = new Lexer(src);
  lexer.line = firstLine;
  return lexer.lex(0);
}
