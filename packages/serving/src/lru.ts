/**
 * A byte-accounted LRU (M0-06): `sha256 → Buffer` for served file bytes,
 * capped at 256 MiB by default. Keys are content hashes, so an entry never
 * goes stale — eviction is purely about memory. A Map keeps insertion order;
 * re-inserting on read makes it the most recently used.
 */
export const DEFAULT_BLOB_CACHE_BYTES = 256 * 1024 * 1024;

export class ByteLru {
  private readonly map = new Map<string, Buffer>();
  private used = 0;

  constructor(readonly maxBytes: number = DEFAULT_BLOB_CACHE_BYTES) {}

  get(key: string): Buffer | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Store `value`; a value larger than the whole cache is simply not kept. */
  set(key: string, value: Buffer): void {
    const existing = this.map.get(key);
    if (existing !== undefined) {
      this.map.delete(key);
      this.used -= existing.length;
    }
    if (value.length > this.maxBytes) return;
    this.map.set(key, value);
    this.used += value.length;
    for (const [k, v] of this.map) {
      if (this.used <= this.maxBytes) break;
      this.map.delete(k);
      this.used -= v.length;
    }
  }

  delete(key: string): void {
    const v = this.map.get(key);
    if (v === undefined) return;
    this.map.delete(key);
    this.used -= v.length;
  }

  clear(): void {
    this.map.clear();
    this.used = 0;
  }

  get bytes(): number {
    return this.used;
  }

  get size(): number {
    return this.map.size;
  }
}

/** A count-capped LRU for small metadata (version manifests, host resolutions). */
export class CountLru<V> {
  private readonly map = new Map<string, V>();

  constructor(readonly maxEntries: number) {}

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
