import { describe, expect, it } from 'vitest';
import { ByteLru, CountLru, DEFAULT_BLOB_CACHE_BYTES, ExpiringLru } from './lru.js';

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

describe('ExpiringLru', () => {
  function clocked(max: number, ttl = 1_000) {
    const clock = { now: 0 };
    return { clock, lru: new ExpiringLru<string>(max, ttl, () => clock.now) };
  }

  it('keeps at most maxEntries over all groups, dropping the least recently used', () => {
    const { lru } = clocked(3);
    lru.set('shop:prod', 'a', 'shop');
    lru.set('shop:v1', 'b', 'shop');
    lru.set('blog:prod', 'c', 'blog');
    lru.get('shop:prod');
    lru.set('shop:v2', 'd', 'shop');
    expect(lru.size).toBe(3);
    expect(lru.get('shop:v1')).toBeUndefined();
    expect(lru.get('shop:prod')).toBe('a');
    for (let n = 3; n < 100; n++) lru.set(`shop:v${n}`, 'x', 'shop');
    expect(lru.size).toBe(3);
    // The evicted entries left the group index too: forgetting the group empties the cache.
    lru.deleteGroup('shop');
    expect(lru.size).toBe(0);
  });

  it('an expired entry is never returned and is dropped when read', () => {
    const { clock, lru } = clocked(10);
    lru.set('a', 'x');
    clock.now = 999;
    expect(lru.get('a')).toBe('x');
    clock.now = 1_000;
    expect(lru.get('a')).toBeUndefined();
    expect(lru.size).toBe(0);
  });

  it('a write sweeps out every expired entry once the last sweep is a TTL old', () => {
    const { clock, lru } = clocked(100);
    for (let i = 0; i < 50; i++) lru.set(`old-${i}`, 'x', 'old');
    clock.now = 500;
    lru.set('mid', 'x');
    expect(lru.size).toBe(51);
    clock.now = 1_200;
    lru.set('new', 'x');
    // The 50 entries of t=0 expired at 1 000 and are gone without being read; `mid` lives until 1 500.
    expect(lru.size).toBe(2);
    expect(lru.hasGroup('old')).toBe(false);
    expect(lru.get('mid')).toBe('x');
  });

  it('groups: hasGroup sees only unexpired entries, deleteGroup forgets one group', () => {
    const { clock, lru } = clocked(10);
    lru.set('shop:prod', 'a', 'shop');
    lru.set('shop:v1', 'b', 'shop');
    lru.set('blog:prod', 'c', 'blog');
    expect(lru.hasGroup('shop')).toBe(true);
    expect(lru.hasGroup('nope')).toBe(false);
    lru.deleteGroup('shop');
    expect(lru.get('shop:prod')).toBeUndefined();
    expect(lru.get('shop:v1')).toBeUndefined();
    expect(lru.get('blog:prod')).toBe('c');
    clock.now = 1_000;
    expect(lru.hasGroup('blog')).toBe(false);
  });

  it('re-setting a key renews its expiry and may move it to another group', () => {
    const { clock, lru } = clocked(10);
    lru.set('k', 'a', 'one');
    clock.now = 800;
    lru.set('k', 'b', 'two');
    clock.now = 1_500;
    expect(lru.get('k')).toBe('b');
    expect(lru.hasGroup('one')).toBe(false);
    lru.deleteGroup('two');
    expect(lru.size).toBe(0);
  });
});
