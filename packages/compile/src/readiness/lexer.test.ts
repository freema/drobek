import { describe, expect, it } from 'vitest';
import { tokenize } from './lexer.js';

const brief = (src: string) => tokenize(src).map((t) => `${t.type}:${t.value}@${t.line}`);

describe('readiness lexer', () => {
  it('tokenizes names, operators, strings and numbers with lines', () => {
    expect(brief("a.b = 'x';\nc += 1.5")).toEqual([
      'name:a@1', 'punct:.@1', 'name:b@1', 'punct:=@1', 'str:x@1', 'punct:;@1',
      'name:c@2', 'punct:+=@2', 'num:1.5@2',
    ]);
  });

  it('skips comments and keeps the line count across them', () => {
    expect(brief('// a = b\n/* x\ny */ z')).toEqual(['name:z@3']);
  });

  it('tells a regex from a division', () => {
    expect(brief('x = a / b / c')).toContain('punct:/@1');
    expect(brief("x = /'/g.test(s)")).toContain("regex:'@1");
    expect(brief("return /[/]'/")).toEqual(["name:return@1", "regex:[/]'@1"]);
  });

  it('keeps a template substitution as its own stream', () => {
    const [tpl] = tokenize('`<b>${ user.name }</b>\n${`${n}`}`');
    expect(tpl).toMatchObject({ type: 'tpl', value: '<b>', line: 1 });
    expect(tpl.subs).toHaveLength(2);
    expect(tpl.subs![0].map((t) => t.value)).toEqual(['user', '.', 'name']);
    expect(tpl.subs![1][0]).toMatchObject({ type: 'tpl', line: 2, subs: [[{ type: 'name', value: 'n', line: 2 }]] });
  });

  it('keeps braces inside a substitution', () => {
    const [tpl, after] = tokenize('`${ {a: 1}.a }` + x');
    expect(tpl.subs![0].map((t) => t.value)).toEqual(['{', 'a', ':', '1', '}', '.', 'a']);
    expect(after.value).toBe('+');
  });

  it('ends an unterminated string at the end of its line', () => {
    expect(brief("<p>don't</p>\nnext")).toContain('name:next@2');
  });

  it('reads a JSX closing tag as punctuation, not a regex', () => {
    expect(brief('<p>{x}</p>; y')).toContain('name:y@1');
  });

  it('starts at the given line', () => {
    expect(tokenize('a', 7)[0].line).toBe(7);
  });

  it('throws on nesting deeper than its bound', () => {
    expect(() => tokenize('`${'.repeat(100))).toThrow();
  });
});
