import { describe, expect, it } from 'vitest';
import { diffMergePatch, jsonEqual, mergePatch } from './merge-patch.js';

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

  it('diffMergePatch: the patch that turns one config into another', () => {
    const before = { a: 1, b: { c: 2, d: 3 }, e: [1, 2], f: 'x', g: { h: 1 } };
    const after = { a: 1, b: { c: 2, d: 4 }, e: [1], g: 5, i: { j: true } };
    const patch = diffMergePatch(before, after);
    expect(patch).toEqual({ b: { d: 4 }, e: [1], f: null, g: 5, i: { j: true } });
    expect(mergePatch(before, patch)).toEqual(after);
    expect(diffMergePatch(before, structuredClone(before))).toEqual({});
  });

  it('diffMergePatch composes two patches exactly, even where one removes what the other rebuilds', () => {
    const base = { k: { a: 1, b: 2 }, s: 'x', keep: true };
    const first = { k: null, s: 'y', n: [1] };
    const second = { k: { c: 3 }, s: { now: 'an object' } };
    const applied = mergePatch(mergePatch(base, first), second) as Record<string, unknown>;
    const composed = diffMergePatch(base, applied);
    expect(applied).toEqual({ k: { c: 3 }, s: { now: 'an object' }, keep: true, n: [1] });
    expect(mergePatch(base, composed)).toEqual(applied);
    // A naive key-by-key merge of the two patches would keep k.a and k.b.
    expect(mergePatch(base, mergePatch(first, second))).not.toEqual(applied);
  });

  it('compares JSON values structurally, key order aside', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
  });
});
