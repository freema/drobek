/**
 * Unit-test helper: @drobek/auth's FakeRedis + GETDEL (invites are
 * single-use via GETDEL, which the auth stack never needed) + the hash
 * commands of the workspace invite index (HSET/HGET/HGETALL/HDEL; a hash is
 * stored as JSON under its key, so DEL/EXPIRE/TTL work on it unchanged).
 * Not a *.test.ts file — vitest never collects it as a suite.
 */
import { FakeRedis } from '@drobek/auth';

export class TenancyFakeRedis extends FakeRedis {
  async getdel(key: string): Promise<string | null> {
    const value = await this.get(key);
    if (value !== null) await this.del(key);
    return value;
  }

  private async readHash(key: string): Promise<Record<string, string>> {
    const raw = await this.get(key);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, string>);
  }

  private writeHash(key: string, hash: Record<string, string>): void {
    if (Object.keys(hash).length === 0) {
      this.store.delete(key);
      return;
    }
    this.store.set(key, { value: JSON.stringify(hash), expiresAt: this.store.get(key)?.expiresAt ?? null });
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    const hash = await this.readHash(key);
    const added = Object.hasOwn(hash, field) ? 0 : 1;
    hash[field] = value;
    this.writeHash(key, hash);
    return added;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return (await this.readHash(key))[field] ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.readHash(key);
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const hash = await this.readHash(key);
    let removed = 0;
    for (const f of fields) {
      if (Object.hasOwn(hash, f)) {
        delete hash[f];
        removed += 1;
      }
    }
    this.writeHash(key, hash);
    return removed;
  }
}
