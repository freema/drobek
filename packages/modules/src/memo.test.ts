import { describe, expect, it } from 'vitest';
import { Lru, jsonKey, stableJson } from './memo.js';

describe('Lru', () => {
  it('evicts the least recently used entry past maxEntries; a read refreshes', () => {
    const lru = new Lru<number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1);
    lru.set('c', 3);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe(1);
    expect(lru.get('c')).toBe(3);
    expect(lru.size).toBe(2);
  });
});

describe('stableJson / jsonKey', () => {
  it('ignores object key order at every level, keeps array order', () => {
    expect(stableJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
    expect(jsonKey({ b: 1, a: { c: 2 } })).toBe(jsonKey({ a: { c: 2 }, b: 1 }));
    expect(jsonKey([1, 2])).not.toBe(jsonKey([2, 1]));
    expect(jsonKey({ a: '1' })).not.toBe(jsonKey({ a: 1 }));
  });
});
