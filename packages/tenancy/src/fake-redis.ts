/**
 * Unit-test helper: @drobek/auth's FakeRedis + GETDEL (invites are
 * single-use via GETDEL, which the auth stack never needed).
 * Not a *.test.ts file — vitest never collects it as a suite.
 */
import { FakeRedis } from '@drobek/auth';

export class TenancyFakeRedis extends FakeRedis {
  async getdel(key: string): Promise<string | null> {
    const value = await this.get(key);
    if (value !== null) await this.del(key);
    return value;
  }
}
