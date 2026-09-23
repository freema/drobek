import { describe, expect, it } from 'vitest';
import { jsonEqual, mergePatch } from './merge-patch.js';

describe('mergePatch (RFC 7396)', () => {
  it('merges objects, replaces arrays and scalars, null deletes', () => {
    expect(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null, e: 4 }, f: [1] })).toEqual({ a: 1, b: { d: 3, e: 4 }, f: [1] });
    expect(mergePatch({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
    expect(mergePatch({ a: 1 }, 'x')).toBe('x');
    expect(mergePatch('x', { a: null, b: 1 })).toEqual({ b: 1 });
  });

  it('does not mutate its inputs', () => {
    const t = { a: { b: 1 } };
    mergePatch(t, { a: { b: 2 } });
    expect(t).toEqual({ a: { b: 1 } });
  });

  it('compares JSON values structurally, key order aside', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
  });
});
