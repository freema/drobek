import { describe, expect, it } from 'vitest';
import { countLines, searchLines, selectLines } from './read-file.js';

describe('countLines', () => {
  it('counts lines; a final line break ends the last line', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('\n')).toBe(1);
    expect(countLines('a\n\n')).toBe(2);
    expect(countLines('a\r\nb\r\n')).toBe(2);
  });
});

describe('selectLines', () => {
  const text = 'one\ntwo\nthree\nfour';

  it('returns the lines as stored, each with its own line break', () => {
    expect(selectLines(text, 2, 2)).toEqual({ content: 'two\nthree\n', from: 2, to: 3 });
    expect(selectLines(text, 3, undefined)).toEqual({ content: 'three\nfour', from: 3, to: 4 });
    expect(selectLines(text, 1, 100)).toEqual({ content: text, from: 1, to: 4 });
    expect(selectLines('a\r\nb\r\n', 2, 1)).toEqual({ content: 'b\r\n', from: 2, to: 2 });
  });

  it('is null when the text ends before the offset', () => {
    expect(selectLines(text, 5, 1)).toBeNull();
    expect(selectLines('', 1, undefined)).toBeNull();
    expect(selectLines('a\n', 2, undefined)).toBeNull();
  });
});

describe('searchLines', () => {
  const files: [string, string][] = [
    ['a.ts', 'const Foo = 1;\nfoo(Foo, Foo);\n'],
    ['b.ts', 'nothing here\n\tFOO\n'],
  ];

  it('one match per line (the first), 1-based line and column, literal text', () => {
    expect(searchLines(files, 'Foo', { max: 10 })).toEqual({
      matches: [
        { path: 'a.ts', line: 1, column: 7, text: 'const Foo = 1;' },
        { path: 'a.ts', line: 2, column: 5, text: 'foo(Foo, Foo);' },
      ],
      total: 2,
    });
    expect(searchLines([['r.ts', 'a.*b\naxxb\n']], '.*', { max: 10 }).matches).toEqual([{ path: 'r.ts', line: 1, column: 2, text: 'a.*b' }]);
  });

  it('ignore_case matches regardless of case', () => {
    const r = searchLines(files, 'foo', { ignoreCase: true, max: 10 });
    expect(r.total).toBe(3);
    expect(r.matches.map((m) => [m.path, m.line, m.column])).toEqual([
      ['a.ts', 1, 7],
      ['a.ts', 2, 1],
      ['b.ts', 2, 2],
    ]);
  });

  it('returns at most max matches and counts them all', () => {
    const r = searchLines([['many.txt', 'hit\n'.repeat(30)]], 'hit', { max: 5 });
    expect(r.matches).toHaveLength(5);
    expect(r.total).toBe(30);
  });

  it('cuts a long line to a window around the match', () => {
    const line = `${'a'.repeat(500)}NEEDLE${'b'.repeat(500)}`;
    const [m] = searchLines([['min.js', line]], 'NEEDLE', { max: 1 }).matches;
    expect(m.column).toBe(501);
    expect(m.text).toBe(`…${'a'.repeat(60)}NEEDLE${'b'.repeat(134)}…`);
    const [start] = searchLines([['min.js', `NEEDLE${'b'.repeat(500)}`]], 'NEEDLE', { max: 1 }).matches;
    expect(start.text).toBe(`NEEDLE${'b'.repeat(194)}…`);
  });

  it('stays linear on input that makes a backtracking or naive matcher quadratic', () => {
    const line = 'a'.repeat(4_000_000);
    const lines = 'ab\n'.repeat(500_000);
    const started = performance.now();
    for (const query of [`${'a'.repeat(199)}b`, `b${'a'.repeat(199)}`]) {
      expect(searchLines([['one-line.js', line]], query, { max: 50 }).total).toBe(0);
      expect(searchLines([['one-line.js', line]], query.toUpperCase(), { ignoreCase: true, max: 50 }).total).toBe(0);
    }
    expect(searchLines([['lines.txt', lines]], 'ab', { max: 50 }).total).toBe(500_000);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
