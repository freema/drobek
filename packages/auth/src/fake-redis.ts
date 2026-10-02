/**
 * Unit-test helper: minimal in-memory Redis covering exactly the subset the
 * auth stack uses (GET/MGET/SET EX|PX|NX/GETEX/GETDEL/DEL/TTL/PTTL/EXPIRE/
 * PEXPIRE/INCR/EXISTS and a MULTI of GET/SET/INCR/PTTL) — also the end-user
 * sessions of the platform `auth` module.
 * Set `failing = true` to make every op throw (fail-closed tests).
 * Not a *.test.ts file — vitest never collects it as a suite.
 */

interface Entry {
  value: string;
  expiresAt: number | null;
}

interface FakeMulti {
  get(key: string): FakeMulti;
  set(key: string, value: string | number, ...args: (string | number)[]): FakeMulti;
  incr(key: string): FakeMulti;
  pttl(key: string): FakeMulti;
  exec(): Promise<[Error | null, unknown][]>;
}

export class FakeRedis {
  store = new Map<string, Entry>();
  failing = false;

  private throwIfFailing(): void {
    if (this.failing) throw new Error('fake redis: connection refused');
  }

  private live(key: string): Entry | null {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return e;
  }

  async get(key: string): Promise<string | null> {
    this.throwIfFailing();
    return this.live(key)?.value ?? null;
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    this.throwIfFailing();
    return keys.map((k) => this.live(k)?.value ?? null);
  }

  async set(
    key: string,
    value: string | number,
    ...args: (string | number)[]
  ): Promise<'OK' | null> {
    this.throwIfFailing();
    let ttlMs: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i += 1) {
      const a = String(args[i]).toUpperCase();
      if (a === 'EX') ttlMs = Number(args[(i += 1)]) * 1000;
      else if (a === 'PX') ttlMs = Number(args[(i += 1)]);
      else if (a === 'NX') nx = true;
    }
    if (nx && this.live(key)) return null;
    this.store.set(key, {
      value: String(value),
      expiresAt: ttlMs !== null ? Date.now() + ttlMs : null,
    });
    return 'OK';
  }

  async getex(
    key: string,
    ...args: (string | number)[]
  ): Promise<string | null> {
    this.throwIfFailing();
    const e = this.live(key);
    if (!e) return null;
    for (let i = 0; i < args.length; i += 1) {
      const a = String(args[i]).toUpperCase();
      if (a === 'EX') e.expiresAt = Date.now() + Number(args[(i += 1)]) * 1000;
      else if (a === 'PX') e.expiresAt = Date.now() + Number(args[(i += 1)]);
    }
    return e.value;
  }

  async getdel(key: string): Promise<string | null> {
    this.throwIfFailing();
    const e = this.live(key);
    if (!e) return null;
    this.store.delete(key);
    return e.value;
  }

  async del(...keys: string[]): Promise<number> {
    this.throwIfFailing();
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n += 1;
    return n;
  }

  async ttl(key: string): Promise<number> {
    this.throwIfFailing();
    const e = this.live(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    return Math.ceil((e.expiresAt - Date.now()) / 1000);
  }

  async pttl(key: string): Promise<number> {
    this.throwIfFailing();
    const e = this.live(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    return e.expiresAt - Date.now();
  }

  /**
   * MULTI over GET/SET/INCR/PTTL: the queued commands run back to back when
   * `exec` is called (nothing interleaves), each reply an `[err, result]`.
   */
  multi(): FakeMulti {
    const queued: (() => Promise<unknown>)[] = [];
    const chain: FakeMulti = {
      get: (key) => (queued.push(() => this.get(key)), chain),
      set: (key, value, ...args) => (queued.push(() => this.set(key, value, ...args)), chain),
      incr: (key) => (queued.push(() => this.incr(key)), chain),
      pttl: (key) => (queued.push(() => this.pttl(key)), chain),
      exec: async () => {
        this.throwIfFailing();
        const started = queued.map((op) => op());
        const settled = await Promise.allSettled(started);
        return settled.map((s) => (s.status === 'fulfilled' ? [null, s.value] : [s.reason as Error, null]));
      },
    };
    return chain;
  }

  async expire(key: string, sec: number): Promise<number> {
    return this.pexpire(key, sec * 1000);
  }

  async pexpire(key: string, ms: number): Promise<number> {
    this.throwIfFailing();
    const e = this.live(key);
    if (!e) return 0;
    e.expiresAt = Date.now() + ms;
    return 1;
  }

  async incr(key: string): Promise<number> {
    this.throwIfFailing();
    const e = this.live(key);
    const n = e ? Number(e.value) + 1 : 1;
    if (e) e.value = String(n);
    else this.store.set(key, { value: String(n), expiresAt: null });
    return n;
  }

  async exists(...keys: string[]): Promise<number> {
    this.throwIfFailing();
    return keys.filter((k) => this.live(k)).length;
  }
}
