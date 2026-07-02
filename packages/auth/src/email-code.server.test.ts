import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedis } from './fake-redis.js';

let fake: FakeRedis;

vi.mock('@drobek/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/core')>();
  return {
    ...actual,
    getRedis: () => fake as unknown as ReturnType<typeof actual.getRedis>,
  };
});

import {
  CODE_TTL_S,
  consumeEmailLoginCode,
  createEmailLoginCode,
  generateLoginCode,
  normalizeAuthEmail,
} from './email-code.server.js';

const EMAIL = 'user@example.com';

function codeKey(email: string): string {
  const h = createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex');
  return `drobek:otp:code:${h}`;
}

function wrongCodeFor(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

beforeEach(() => {
  fake = new FakeRedis();
});

describe('generateLoginCode', () => {
  it('always produces exactly 6 numeric digits (leading zeros allowed)', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateLoginCode()).toMatch(/^\d{6}$/);
    }
  });
});

describe('createEmailLoginCode', () => {
  it('stores a SHA-256 hash (never the code) under drobek:otp:code:<sha256(email)> with a 600s TTL', async () => {
    const code = await createEmailLoginCode(EMAIL, '1.2.3.4');
    const raw = await fake.get(codeKey(EMAIL));
    expect(raw).not.toBeNull();

    const rec = JSON.parse(raw!) as {
      email: string;
      codeHash: string;
      attempts: number;
    };
    expect(rec.email).toBe(EMAIL);
    expect(rec.attempts).toBe(0);
    expect(rec.codeHash).toBe(
      createHash('sha256').update(code).digest('hex')
    );

    const ttl = await fake.ttl(codeKey(EMAIL));
    expect(ttl).toBeGreaterThan(CODE_TTL_S - 5);
    expect(ttl).toBeLessThanOrEqual(CODE_TTL_S);
  });

  it('normalizes the email (trim + lowercase) for the redis key', async () => {
    await createEmailLoginCode('  User@Example.COM ', undefined);
    expect(await fake.get(codeKey(EMAIL))).not.toBeNull();
  });
});

describe('consumeEmailLoginCode', () => {
  it('happy path: correct code consumes the record exactly once', async () => {
    const code = await createEmailLoginCode(EMAIL, undefined);
    expect(await consumeEmailLoginCode(EMAIL, code)).toEqual({ ok: true });
    // Single-use: the record is gone.
    expect(await fake.get(codeKey(EMAIL))).toBeNull();
    expect(await consumeEmailLoginCode(EMAIL, code)).toEqual({
      ok: false,
      reason: 'no_code',
    });
  });

  it('accepts a differently-cased/whitespaced email for the same record', async () => {
    const code = await createEmailLoginCode('User@Example.com', undefined);
    expect(await consumeEmailLoginCode(' user@EXAMPLE.com ', code)).toEqual({
      ok: true,
    });
  });

  it('wrong code increments attempts and keeps the TTL', async () => {
    const code = await createEmailLoginCode(EMAIL, undefined);
    const res = await consumeEmailLoginCode(EMAIL, wrongCodeFor(code));
    expect(res).toEqual({ ok: false, reason: 'wrong_code' });

    const rec = JSON.parse((await fake.get(codeKey(EMAIL)))!) as {
      attempts: number;
    };
    expect(rec.attempts).toBe(1);
    const ttl = await fake.ttl(codeKey(EMAIL));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(CODE_TTL_S);
  });

  it('5 wrong attempts delete the record — the 6th attempt fails even with the CORRECT code', async () => {
    const code = await createEmailLoginCode(EMAIL, undefined);
    const wrong = wrongCodeFor(code);

    for (let i = 1; i <= 4; i += 1) {
      expect(await consumeEmailLoginCode(EMAIL, wrong)).toEqual({
        ok: false,
        reason: 'wrong_code',
      });
    }
    // 5th wrong attempt invalidates the record entirely.
    expect(await consumeEmailLoginCode(EMAIL, wrong)).toEqual({
      ok: false,
      reason: 'too_many_attempts',
    });
    expect(await fake.get(codeKey(EMAIL))).toBeNull();

    // 6th attempt with the CORRECT code is rejected.
    expect(await consumeEmailLoginCode(EMAIL, code)).toEqual({
      ok: false,
      reason: 'no_code',
    });
  });

  it('missing record → no_code', async () => {
    expect(await consumeEmailLoginCode(EMAIL, '123456')).toEqual({
      ok: false,
      reason: 'no_code',
    });
  });
});

describe('normalizeAuthEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeAuthEmail('  Foo@BAR.com ')).toBe('foo@bar.com');
  });
});
