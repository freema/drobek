import { describe, expect, it } from 'vitest';
import { ByteLru, CountLru, DEFAULT_BLOB_CACHE_BYTES } from './lru.js';

const buf = (n: number) => Buffer.alloc(n, 1);

describe('ByteLru', () => {
  it('defaults to 256 MiB', () => {
    expect(DEFAULT_BLOB_CACHE_BYTES).toBe(256 * 1024 * 1024);
    expect(new ByteLru().maxBytes).toBe(DEFAULT_BLOB_CACHE_BYTES);
  });

  it('evicts the least recently used entries by BYTES, not by count', () => {
    const lru = new ByteLru(100);
    lru.set('a', buf(40));
    lru.set('b', buf(40));
    expect(lru.bytes).toBe(80);
    lru.get('a'); // a is now the most recently used
    lru.set('c', buf(40)); // 120 > 100 → evict b (the LRU)
    expect(lru.has('a')).toBe(true);
    expect(lru.has('b')).toBe(false);
    expect(lru.has('c')).toBe(true);
    expect(lru.bytes).toBe(80);
  });

  it('one big entry can evict several small ones', () => {
    const lru = new ByteLru(100);
    for (const k of ['a', 'b', 'c', 'd']) lru.set(k, buf(20));
    lru.set('big', buf(90));
    expect(lru.size).toBe(1);
    expect(lru.bytes).toBe(90);
  });

  it('never keeps an entry larger than the whole cache', () => {
    const lru = new ByteLru(100);
    lru.set('a', buf(10));
    lru.set('huge', buf(101));
    expect(lru.has('huge')).toBe(false);
    expect(lru.has('a')).toBe(true);
  });

  it('re-setting a key re-accounts its size', () => {
    const lru = new ByteLru(100);
    lru.set('a', buf(60));
    lru.set('a', buf(10));
    expect(lru.bytes).toBe(10);
    lru.delete('a');
    expect(lru.bytes).toBe(0);
  });
});

describe('CountLru', () => {
  it('keeps at most maxEntries, dropping the least recently used', () => {
    const lru = new CountLru<number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.get('a');
    lru.set('c', 3);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe(1);
    expect(lru.get('c')).toBe(3);
  });
});
