import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import {
  guardOtpRequest,
  isOtpSendingPaused,
  otpGuardLimitsFromEnv,
  releaseOtpCooldown,
  type OtpGuardLimits,
} from './otp-guard.server.js';

/** The strict production defaults (spec §4) — injected, never read from env. */
const STRICT: OtpGuardLimits = {
  ipShortLimit: 5,
  ipDailyLimit: 20,
  emailHourlyLimit: 3,
  emailCooldownMs: 60_000,
  globalHourlyMax: 100,
};

beforeEach(() => {
  fake = new FakeRedis();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('guardOtpRequest (strict defaults, injected)', () => {
  it('allows a fresh request', async () => {
    const d = await guardOtpRequest({
      ip: '10.0.0.1',
      email: 'a@example.com',
      limits: STRICT,
    });
    expect(d).toEqual({ ok: true });
  });

  it('per-IP short window: the 6th send from one IP is blocked with 429', async () => {
    for (let i = 0; i < 5; i += 1) {
      const d = await guardOtpRequest({
        ip: '10.0.0.9',
        email: `u${i}@example.com`, // distinct emails — isolate the IP layer
        limits: STRICT,
      });
      expect(d.ok).toBe(true);
    }
    const sixth = await guardOtpRequest({
      ip: '10.0.0.9',
      email: 'u6@example.com',
      limits: STRICT,
    });
    expect(sixth).toMatchObject({
      ok: false,
      kind: 'error',
      status: 429,
      reason: 'ip_short',
    });
  });

  it('per-email cooldown: an immediate resend is a generic redirect_verify (no new send)', async () => {
    const email = 'cool@example.com';
    const first = await guardOtpRequest({ ip: '10.0.0.2', email, limits: STRICT });
    expect(first.ok).toBe(true);

    const second = await guardOtpRequest({ ip: '10.0.0.2', email, limits: STRICT });
    expect(second).toEqual({
      ok: false,
      kind: 'redirect_verify',
      reason: 'cooldown',
    });
  });

  it('releaseOtpCooldown lifts the cooldown (send-failure path)', async () => {
    const email = 'retry@example.com';
    expect(
      (await guardOtpRequest({ ip: '10.0.0.3', email, limits: STRICT })).ok
    ).toBe(true);
    await releaseOtpCooldown(email);
    expect(
      (await guardOtpRequest({ ip: '10.0.0.3', email, limits: STRICT })).ok
    ).toBe(true);
  });

  it('per-email hourly limit: the 4th send within the hour redirects generically', async () => {
    const email = 'hourly@example.com';
    for (let i = 0; i < 3; i += 1) {
      const d = await guardOtpRequest({ ip: '10.0.0.4', email, limits: STRICT });
      expect(d.ok).toBe(true);
      await releaseOtpCooldown(email); // isolate the hourly layer from the cooldown
    }
    const fourth = await guardOtpRequest({ ip: '10.0.0.4', email, limits: STRICT });
    expect(fourth).toEqual({
      ok: false,
      kind: 'redirect_verify',
      reason: 'email_hourly',
    });
  });

  it('global brake: exceeding the global cap returns 503 and sets the autopause key', async () => {
    const limits: OtpGuardLimits = { ...STRICT, globalHourlyMax: 1 };
    expect(
      (
        await guardOtpRequest({
          ip: '10.1.0.1',
          email: 'g1@example.com',
          limits,
        })
      ).ok
    ).toBe(true);

    const second = await guardOtpRequest({
      ip: '10.1.0.2',
      email: 'g2@example.com',
      limits,
    });
    expect(second).toMatchObject({
      ok: false,
      kind: 'error',
      status: 503,
      reason: 'global_brake',
    });
    expect(await fake.exists('drobek:otp:autopause')).toBe(1);

    // While auto-paused, everything is blocked up-front.
    const third = await guardOtpRequest({
      ip: '10.1.0.3',
      email: 'g3@example.com',
      limits,
    });
    expect(third).toMatchObject({
      ok: false,
      kind: 'error',
      status: 503,
      reason: 'global_autopause',
    });
  });

  it('env kill switch OTP_LOGIN_DISABLED=1 blocks with 503', async () => {
    vi.stubEnv('OTP_LOGIN_DISABLED', '1');
    const d = await guardOtpRequest({
      ip: '10.0.0.5',
      email: 'kill@example.com',
      limits: STRICT,
    });
    expect(d).toMatchObject({
      ok: false,
      kind: 'error',
      status: 503,
      reason: 'env_kill_switch',
    });
  });

  it('manual Redis killswitch key blocks with 503', async () => {
    await fake.set('drobek:otp:killswitch', '1');
    const d = await guardOtpRequest({
      ip: '10.0.0.6',
      email: 'manual@example.com',
      limits: STRICT,
    });
    expect(d).toMatchObject({
      ok: false,
      kind: 'error',
      status: 503,
      reason: 'manual_kill_switch',
    });
  });

  it('FAIL-CLOSED: a Redis outage blocks the send with 503', async () => {
    fake.failing = true;
    const d = await guardOtpRequest({
      ip: '10.0.0.7',
      email: 'down@example.com',
      limits: STRICT,
    });
    expect(d).toMatchObject({
      ok: false,
      kind: 'error',
      status: 503,
      reason: 'guard_error',
    });
  });
});

describe('isOtpSendingPaused', () => {
  it('is not paused by default', async () => {
    expect(await isOtpSendingPaused()).toEqual({ paused: false });
  });
});

describe('otpGuardLimitsFromEnv', () => {
  it('falls back to the strict puls defaults when env is empty', () => {
    expect(otpGuardLimitsFromEnv({} as NodeJS.ProcessEnv)).toEqual(STRICT);
  });

  it('reads overrides from env and ignores garbage values', () => {
    const limits = otpGuardLimitsFromEnv({
      OTP_IP_SHORT_LIMIT: '100',
      OTP_IP_DAILY_LIMIT: '500',
      OTP_EMAIL_HOURLY_LIMIT: '50',
      OTP_EMAIL_COOLDOWN_MS: '5000',
      OTP_GLOBAL_HOURLY_MAX: 'not-a-number',
    } as NodeJS.ProcessEnv);
    expect(limits).toEqual({
      ipShortLimit: 100,
      ipDailyLimit: 500,
      emailHourlyLimit: 50,
      emailCooldownMs: 5000,
      globalHourlyMax: 100, // garbage → default
    });
  });
});
