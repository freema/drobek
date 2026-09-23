/**
 * Small in-process memo helpers (NSO-322 H1): an entry-counted LRU and a
 * stable content key for JSON values. Keys are content hashes, so an entry
 * never goes stale — a changed value is a different key; eviction is only
 * about memory. A Map keeps insertion order; a read re-inserts the entry so
 * it becomes the most recently used.
 */
import { createHash } from 'node:crypto';

export class Lru<V> {
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

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** JSON with object keys sorted at every level (so key order never changes the key). */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : stableJson(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableJson(obj[key])}`);
  }
  return `{${parts.join(',')}}`;
}

/** A short content key of a JSON value: sha256 of its stable JSON. */
export function jsonKey(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('base64url');
}
