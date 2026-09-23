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

vi.mock('./logger.server.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (err: unknown) => ({ message: String(err) }),
}));

import { guardOtpVerify, otpVerifyLimitsFromEnv, type OtpVerifyLimits } from './otp-verify-guard.server.js';

const LIMITS: OtpVerifyLimits = { ipLimit: 3, windowMs: 60_000 };

beforeEach(() => {
  fake = new FakeRedis();
});

describe('otpVerifyLimitsFromEnv', () => {
  it('defaults to 30 checks per 15 minutes', () => {
    expect(otpVerifyLimitsFromEnv({})).toEqual({ ipLimit: 30, windowMs: 900_000 });
  });

  it('reads OTP_VERIFY_IP_LIMIT / OTP_VERIFY_IP_WINDOW_S', () => {
    expect(otpVerifyLimitsFromEnv({ OTP_VERIFY_IP_LIMIT: '500', OTP_VERIFY_IP_WINDOW_S: '60' })).toEqual({
      ipLimit: 500,
      windowMs: 60_000,
    });
  });

  it('ignores invalid values (falls back to the defaults)', () => {
    expect(otpVerifyLimitsFromEnv({ OTP_VERIFY_IP_LIMIT: '0', OTP_VERIFY_IP_WINDOW_S: 'abc' })).toEqual({
      ipLimit: 30,
      windowMs: 900_000,
    });
    expect(otpVerifyLimitsFromEnv({ OTP_VERIFY_IP_LIMIT: '-5', OTP_VERIFY_IP_WINDOW_S: '1.5' })).toEqual({
      ipLimit: 30,
      windowMs: 900_000,
    });
  });
});

describe('guardOtpVerify', () => {
  it('known IP: the (limit + 1)th check from one IP is refused, another IP is unaffected', async () => {
    for (let i = 0; i < LIMITS.ipLimit; i += 1) {
      expect(await guardOtpVerify({ ip: '203.0.113.1', limits: LIMITS })).toEqual({ ok: true });
    }
    expect(await guardOtpVerify({ ip: '203.0.113.1', limits: LIMITS })).toEqual({ ok: false });
    expect(await guardOtpVerify({ ip: '203.0.113.2', limits: LIMITS })).toEqual({ ok: true });
    expect(fake.store.has('drobek:rl:otp-verify-ip:203.0.113.1')).toBe(true);
  });

  it('no IP (NSO-309): clients without an IP never share a bucket — far past the limit, still allowed', async () => {
    for (let i = 0; i < LIMITS.ipLimit * 10; i += 1) {
      expect(await guardOtpVerify({ ip: undefined, limits: LIMITS })).toEqual({ ok: true });
      expect(await guardOtpVerify({ ip: null, limits: LIMITS })).toEqual({ ok: true });
    }
    // No shared "unknown" counter is ever written.
    expect([...fake.store.keys()].filter((k) => k.startsWith('drobek:rl:'))).toEqual([]);
  });

  it('IP-less traffic does not consume a known IP budget either', async () => {
    for (let i = 0; i < 20; i += 1) await guardOtpVerify({ ip: undefined, limits: LIMITS });
    expect(await guardOtpVerify({ ip: '203.0.113.3', limits: LIMITS })).toEqual({ ok: true });
  });

  it('a Redis error propagates (nothing is verified)', async () => {
    fake.failing = true;
    await expect(guardOtpVerify({ ip: '203.0.113.4', limits: LIMITS })).rejects.toThrow(/connection refused/);
  });
});
