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
  chargeOtpRequest,
  checkOtpRequest,
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

  it('no client IP (NSO-309): no shared "unknown" IP bucket — IP-less clients are not coupled', async () => {
    // Far past ipShortLimit (5) and ipDailyLimit (20): distinct e-mails, no IP.
    for (let i = 0; i < 30; i += 1) {
      expect(await guardOtpRequest({ ip: undefined, email: `noip${i}@example.com`, limits: STRICT })).toEqual({
        ok: true,
      });
    }
    expect([...fake.store.keys()].some((k) => k.includes(':otp-ip-'))).toBe(false);
  });

  it('no client IP: the per-e-mail limits and the global brake still apply', async () => {
    const email = 'noip-same@example.com';
    expect(await guardOtpRequest({ ip: undefined, email, limits: STRICT })).toEqual({ ok: true });
    expect(await guardOtpRequest({ ip: undefined, email, limits: STRICT })).toMatchObject({
      ok: false,
      kind: 'redirect_verify',
      reason: 'cooldown',
    });
    const tiny = { ...STRICT, globalHourlyMax: 2 };
    expect(await guardOtpRequest({ ip: undefined, email: 'g1@example.com', limits: tiny })).toEqual({ ok: true });
    expect(await guardOtpRequest({ ip: undefined, email: 'g2@example.com', limits: tiny })).toMatchObject({
      ok: false,
      status: 503,
      reason: 'global_brake',
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

describe('scoped guard (M1-02: one app\'s end users)', () => {
  const SCOPE = 'eu:app_1';

  it('counts per scope: an app\'s per-IP window never touches the dashboard or another app', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(await guardOtpRequest({ ip: '10.0.0.5', email: `s${i}@example.com`, limits: STRICT, scope: SCOPE })).toEqual({ ok: true });
    }
    const sixth = await guardOtpRequest({ ip: '10.0.0.5', email: 's9@example.com', limits: STRICT, scope: SCOPE });
    expect(sixth).toMatchObject({ ok: false, kind: 'error', status: 429, reason: 'ip_short' });
    expect(await guardOtpRequest({ ip: '10.0.0.5', email: 'd@example.com', limits: STRICT })).toEqual({ ok: true });
    expect(await guardOtpRequest({ ip: '10.0.0.5', email: 'o@example.com', limits: STRICT, scope: 'eu:app_2' })).toEqual({ ok: true });
    expect(await fake.get(`drobek:rl:${SCOPE}:otp-ip-15m:10.0.0.5`)).toBe('6');
  });

  it('the scope\'s hourly brake pauses only that scope', async () => {
    const limits = { ...STRICT, globalHourlyMax: 2, ipShortLimit: 100, ipDailyLimit: 100 };
    expect(await guardOtpRequest({ ip: '10.0.0.6', email: 'a1@example.com', limits, scope: SCOPE })).toEqual({ ok: true });
    expect(await guardOtpRequest({ ip: '10.0.0.6', email: 'a2@example.com', limits, scope: SCOPE })).toEqual({ ok: true });
    expect(await guardOtpRequest({ ip: '10.0.0.6', email: 'a3@example.com', limits, scope: SCOPE })).toMatchObject({ ok: false, status: 503, reason: 'global_brake' });
    expect(await isOtpSendingPaused(SCOPE)).toEqual({ paused: true, reason: 'scope_autopause' });
    expect(await isOtpSendingPaused()).toEqual({ paused: false });
    expect(await isOtpSendingPaused('eu:app_2')).toEqual({ paused: false });
  });

  it('a scope obeys the operator-wide switches (manual kill switch, dashboard auto-pause)', async () => {
    await fake.set('drobek:otp:autopause', '1', 'PX', 60_000);
    expect(await isOtpSendingPaused(SCOPE)).toEqual({ paused: true, reason: 'global_autopause' });
    await fake.del('drobek:otp:autopause');
    await fake.set('drobek:otp:killswitch', '1');
    expect(await guardOtpRequest({ ip: '10.0.0.7', email: 'k@example.com', limits: STRICT, scope: SCOPE })).toMatchObject({
      ok: false,
      status: 503,
      reason: 'manual_kill_switch',
    });
  });

  it('cooldown + release are per scope', async () => {
    expect(await guardOtpRequest({ ip: '10.0.0.8', email: 'c@example.com', limits: STRICT, scope: SCOPE })).toEqual({ ok: true });
    expect(await guardOtpRequest({ ip: '10.0.0.8', email: 'c@example.com', limits: STRICT, scope: SCOPE })).toMatchObject({ kind: 'redirect_verify', reason: 'cooldown' });
    // The dashboard cooldown for the same e-mail is independent.
    expect(await guardOtpRequest({ ip: '10.0.0.8', email: 'c@example.com', limits: STRICT })).toEqual({ ok: true });
    await releaseOtpCooldown('c@example.com', SCOPE);
    expect(await guardOtpRequest({ ip: '10.0.0.8', email: 'c@example.com', limits: STRICT, scope: SCOPE })).toEqual({ ok: true });
  });
});

describe('checkOtpRequest + chargeOtpRequest (NSO-327: charge only what was sent)', () => {
  const SCOPE = 'eu:app_9';

  it('a check reads the counters without charging them; only the cooldown is claimed', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect(await checkOtpRequest({ ip: '10.1.0.1', email: `n${i}@example.com`, limits: STRICT, scope: SCOPE })).toEqual({ ok: true });
    }
    expect(await fake.get(`drobek:rl:${SCOPE}:otp-ip-15m:10.1.0.1`)).toBeNull();
    expect(await fake.get(`drobek:rl:${SCOPE}:otp-global-1h:all`)).toBeNull();
    // The cooldown still dedups a double-click.
    expect(await checkOtpRequest({ ip: '10.1.0.1', email: 'n0@example.com', limits: STRICT, scope: SCOPE })).toMatchObject({
      kind: 'redirect_verify',
      reason: 'cooldown',
    });
  });

  it('charged sends hit the same limits as guardOtpRequest (per IP, per address, the scope brake)', async () => {
    const ip = '10.1.0.2';
    for (let i = 0; i < 5; i += 1) {
      const email = `c${i}@example.com`;
      expect(await checkOtpRequest({ ip, email, limits: STRICT, scope: SCOPE })).toEqual({ ok: true });
      await chargeOtpRequest({ ip, email, scope: SCOPE });
    }
    expect(await checkOtpRequest({ ip, email: 'c9@example.com', limits: STRICT, scope: SCOPE })).toMatchObject({ status: 429, reason: 'ip_short' });
    // Per address: 3 an hour, then "sent" without a send.
    const other = { ...STRICT, ipShortLimit: 100, ipDailyLimit: 100, emailCooldownMs: 1 };
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 2));
      expect(await checkOtpRequest({ ip: '10.1.0.3', email: 'same@example.com', limits: other, scope: SCOPE })).toEqual({ ok: true });
      await chargeOtpRequest({ ip: '10.1.0.3', email: 'same@example.com', scope: SCOPE });
    }
    await new Promise((r) => setTimeout(r, 2));
    expect(await checkOtpRequest({ ip: '10.1.0.3', email: 'same@example.com', limits: other, scope: SCOPE })).toMatchObject({
      kind: 'redirect_verify',
      reason: 'email_hourly',
    });
    // The scope brake: 5 + 3 codes charged; a cap of 8 → auto-pause on the next check.
    expect(await checkOtpRequest({ ip: '10.1.0.4', email: 'b@example.com', limits: { ...other, globalHourlyMax: 8 }, scope: SCOPE })).toMatchObject({
      status: 503,
      reason: 'global_brake',
    });
    expect(await isOtpSendingPaused(SCOPE)).toEqual({ paused: true, reason: 'scope_autopause' });
  });

  it('attempts that were never charged (the send was refused) leave the user unlimited afterwards', async () => {
    const ip = '10.1.0.5';
    // Ten attempts while e-mail is paused downstream: checked, cooldown released, never charged.
    for (let i = 0; i < 10; i += 1) {
      expect(await checkOtpRequest({ ip, email: 'retry@example.com', limits: STRICT, scope: SCOPE })).toEqual({ ok: true });
      await releaseOtpCooldown('retry@example.com', SCOPE);
    }
    // The pause is over: the first real send goes through and is charged once.
    expect(await checkOtpRequest({ ip, email: 'retry@example.com', limits: STRICT, scope: SCOPE })).toEqual({ ok: true });
    await chargeOtpRequest({ ip, email: 'retry@example.com', scope: SCOPE });
    expect(await fake.get(`drobek:rl:${SCOPE}:otp-ip-15m:${ip}`)).toBe('1');
    expect(await fake.get(`drobek:rl:${SCOPE}:otp-ip-24h:${ip}`)).toBe('1');
    expect(await fake.get(`drobek:rl:${SCOPE}:otp-global-1h:all`)).toBe('1');
  });

  it('no client IP: the per-IP windows are neither read nor charged (NSO-309)', async () => {
    expect(await checkOtpRequest({ ip: undefined, email: 'x@example.com', limits: STRICT, scope: SCOPE })).toEqual({ ok: true });
    await chargeOtpRequest({ ip: undefined, email: 'x@example.com', scope: SCOPE });
    expect([...fake.store.keys()].filter((k) => k.includes('otp-ip-'))).toEqual([]);
    expect(await fake.get(`drobek:rl:${SCOPE}:otp-global-1h:all`)).toBe('1');
  });

  it('check fails closed on a Redis error; charge only logs it', async () => {
    fake.failing = true;
    expect(await checkOtpRequest({ ip: '10.1.0.6', email: 'f@example.com', limits: STRICT, scope: SCOPE })).toMatchObject({
      ok: false,
      status: 503,
      reason: 'guard_error',
    });
    await expect(chargeOtpRequest({ ip: '10.1.0.6', email: 'f@example.com', scope: SCOPE })).resolves.toBeUndefined();
  });
});
