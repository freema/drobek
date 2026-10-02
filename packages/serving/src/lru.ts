/**
 * A byte-accounted LRU: `sha256 → Buffer` for served file bytes,
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

/**
 * A count-capped LRU whose entries expire `ttlMs` after they were stored (the
 * host-resolution caches). An expired entry is dropped when it is read, and a
 * write first sweeps out every expired entry once the last sweep is a TTL old,
 * so expired entries never pile up below the cap. An entry may belong to a
 * group (an app slug): `deleteGroup` forgets all entries of one group at once.
 */
export class ExpiringLru<V> {
  private readonly map = new Map<string, { expires: number; value: V; group: string | null }>();
  private readonly groups = new Map<string, Set<string>>();
  private nextSweep = 0;

  constructor(
    readonly maxEntries: number,
    readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (entry.expires <= this.now()) {
      this.remove(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, group: string | null = null): void {
    const now = this.now();
    if (now >= this.nextSweep) {
      for (const [k, e] of this.map) if (e.expires <= now) this.remove(k);
      this.nextSweep = now + this.ttlMs;
    }
    this.remove(key);
    this.map.set(key, { expires: now + this.ttlMs, value, group });
    if (group !== null) {
      const keys = this.groups.get(group);
      if (keys) keys.add(key);
      else this.groups.set(group, new Set([key]));
    }
    while (this.map.size > this.maxEntries) this.remove(this.map.keys().next().value as string);
  }

  delete(key: string): void {
    this.remove(key);
  }

  /** Does `group` have an unexpired entry? */
  hasGroup(group: string): boolean {
    const keys = this.groups.get(group);
    if (!keys) return false;
    const now = this.now();
    for (const k of keys) if ((this.map.get(k)?.expires ?? 0) > now) return true;
    return false;
  }

  deleteGroup(group: string): void {
    const keys = this.groups.get(group);
    if (!keys) return;
    this.groups.delete(group);
    for (const k of keys) this.map.delete(k);
  }

  clear(): void {
    this.map.clear();
    this.groups.clear();
  }

  get size(): number {
    return this.map.size;
  }

  private remove(key: string): void {
    const entry = this.map.get(key);
    if (entry === undefined) return;
    this.map.delete(key);
    if (entry.group === null) return;
    const keys = this.groups.get(entry.group);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) this.groups.delete(entry.group);
  }
}
