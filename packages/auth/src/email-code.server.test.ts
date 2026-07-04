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
  CODE_MAX_ATTEMPTS,
  CODE_TTL_S,
  consumeEmailLoginCode,
  createEmailLoginCode,
  generateLoginCode,
  normalizeAuthEmail,
} from './email-code.server.js';

const EMAIL = 'user@example.com';

function emailHashHex(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function codeKey(email: string): string {
  return `drobek:otp:code:${emailHashHex(email)}`;
}

function attemptsKey(email: string): string {
  return `drobek:otp:attempts:${emailHashHex(email)}`;
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

    const rec = JSON.parse(raw!) as { email: string; codeHash: string };
    expect(rec.email).toBe(EMAIL);
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

  it('resets a burned attempt counter so a re-issued code starts fresh', async () => {
    // Burn the counter to the cap under an old code…
    await fake.set(attemptsKey(EMAIL), String(CODE_MAX_ATTEMPTS), 'EX', 600);
    // …then issue a new code; the fresh code must accept guesses again.
    const code = await createEmailLoginCode(EMAIL, undefined);
    expect(await fake.get(attemptsKey(EMAIL))).toBeNull();
    expect(await consumeEmailLoginCode(EMAIL, code)).toEqual({ ok: true });
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

  it('wrong code increments the atomic counter and leaves the code record + TTL intact', async () => {
    const code = await createEmailLoginCode(EMAIL, undefined);
    const res = await consumeEmailLoginCode(EMAIL, wrongCodeFor(code));
    expect(res).toEqual({ ok: false, reason: 'wrong_code' });

    // The guess count lives in a sibling key, not in the code record.
    expect(await fake.get(attemptsKey(EMAIL))).toBe('1');
    // The code record itself is untouched (and still consumable by the owner).
    expect(await fake.get(codeKey(EMAIL))).not.toBeNull();
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

    // 6th attempt with the CORRECT code is refused (counter already over cap).
    expect(await consumeEmailLoginCode(EMAIL, code)).toEqual({
      ok: false,
      reason: 'too_many_attempts',
    });
  });

  it('caps a CONCURRENT guess flood at CODE_MAX_ATTEMPTS evaluations (PHY-76 #1)', async () => {
    // Regression: the old GET→attempts+1→SET read-modify-write could be raced
    // past the cap by concurrent guesses. The atomic INCR-first counter must
    // let at most CODE_MAX_ATTEMPTS guesses reach a live code no matter how many
    // fire at once.
    const code = await createEmailLoginCode(EMAIL, undefined);
    const wrong = wrongCodeFor(code);

    const results = await Promise.all(
      Array.from({ length: 50 }, () => consumeEmailLoginCode(EMAIL, wrong))
    );

    // INCR hands every concurrent guess a distinct count, and only counts in
    // [1, CODE_MAX_ATTEMPTS - 1] reach the "wrong_code" branch — so no matter
    // how the 50 interleave, at most CODE_MAX_ATTEMPTS - 1 of them can come back
    // "wrong_code". (The old read-modify-write let all 50 read attempts=0 and
    // return "wrong_code".) Nothing succeeds — every guess here is wrong.
    const wrongCodeHits = results.filter(
      (r) => r.ok === false && r.reason === 'wrong_code'
    );
    expect(wrongCodeHits.length).toBeLessThanOrEqual(CODE_MAX_ATTEMPTS - 1);
    expect(results.some((r) => r.ok === true)).toBe(false);

    // The flood burned the code — even the correct code no longer works.
    expect(await fake.get(codeKey(EMAIL))).toBeNull();
    expect(await consumeEmailLoginCode(EMAIL, code)).toEqual({
      ok: false,
      reason: 'too_many_attempts',
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
