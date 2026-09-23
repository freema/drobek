import { describe, expect, it, vi } from 'vitest';
import { capEmailText, emailKind, MAX_EMAIL_TEXT, resolveRecipients, sanitizeSubject } from './email.js';
import {
  MAIL_COUNTER_KEYS,
  MAIL_PAUSE_KEYS,
  mailAppCounterKey,
  mailBudgets,
  mailGuardConfigFromEnv,
  memoryMailGuard,
  memoryMailGuardRedis,
  redisMailGuard,
  type MailGuardMeta,
  type MailGuardRedis,
} from './mail-guard.js';

const user = { kind: 'user' as const, id: 'u', email: 'Ana@Example.com', role: 'user' as const };
const anon = { kind: 'anon' as const };

describe('module e-mail recipients', () => {
  it('config paths, the principal, the app owners and (auth) one sign-in address — nothing else', async () => {
    const config = { notify: { emails: ['a@b.cz', 'not-an-address', 'C@D.cz'] }, one: 'x@y.cz' };
    const src = { principal: user, config, owners: async () => ['owner@example.com', 'a@b.cz'] };
    expect(await resolveRecipients({ config: 'notify.emails' }, src)).toEqual(['a@b.cz', 'c@d.cz']);
    expect(await resolveRecipients({ config: 'one' }, src)).toEqual(['x@y.cz']);
    expect(await resolveRecipients({ config: 'nope.deeper' }, src)).toEqual([]);
    expect(await resolveRecipients({ config: 'notify.__proto__' }, src)).toEqual([]);
    expect(await resolveRecipients({ principal: true }, src)).toEqual(['ana@example.com']);
    await expect(resolveRecipients({ principal: true }, { principal: anon, config })).rejects.toThrow(/Sign in/);
    expect(await resolveRecipients({ signInAddress: ' x@firma.cz ' }, { principal: anon, config })).toEqual(['x@firma.cz']);
    for (const bad of ['a@b.cz, c@d.cz', 'a@b.cz\r\nBcc: e@f.cz', 'x', `${'a'.repeat(250)}@b.cz`]) {
      expect(await resolveRecipients({ signInAddress: bad }, { principal: anon, config })).toEqual([]);
    }
    // Several references: de-duplicated, in order.
    expect(await resolveRecipients([{ config: 'notify.emails' }, { appOwners: true }], src)).toEqual(['a@b.cz', 'c@d.cz', 'owner@example.com']);
    // No owners source → nobody.
    expect(await resolveRecipients({ appOwners: true }, { principal: anon, config })).toEqual([]);
  });

  it('a sign-in address is always alone; kinds', () => {
    expect(emailKind({ signInAddress: 'a@b.cz' })).toBe('sign_in');
    expect(emailKind([{ appOwners: true }, { config: 'x' }])).toBe('notification');
    expect(() => emailKind([{ signInAddress: 'a@b.cz' }, { appOwners: true }])).toThrow(/only recipient/);
    expect(() => emailKind([])).toThrow(/no recipient/);
  });

  it('subjects are one line (no header injection), capped at 200; texts capped', () => {
    expect(sanitizeSubject('Hi\r\nBcc: evil@example.com\tthere')).toBe('Hi Bcc: evil@example.com there');
    expect(sanitizeSubject(`a${String.fromCharCode(0x2028)}b`)).toBe('a b');
    expect(sanitizeSubject('x'.repeat(300))).toHaveLength(200);
    expect(capEmailText('y'.repeat(MAX_EMAIL_TEXT + 50))).toHaveLength(MAX_EMAIL_TEXT);
    expect(capEmailText('short')).toBe('short');
  });
});

function log() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const ALERT = 'ALERT: module e-mail paused — the global hourly cap was reached';

describe('the operator-wide hourly budgets of module e-mail (sign-in codes vs notifications)', () => {
  const notify = (app_id = 'app_1'): MailGuardMeta => ({ app_id, module: 'forms', kind: 'notification' });
  const signIn = (app_id = 'app_1'): MailGuardMeta => ({ app_id, module: 'auth', kind: 'sign_in' });

  it('env config with defaults', () => {
    expect(mailGuardConfigFromEnv({})).toEqual({ hourlyMax: 500, pauseMinutes: 15, appSharePercent: 25, signInAppSharePercent: 25 });
    expect(
      mailGuardConfigFromEnv({
        EMAIL_GLOBAL_HOURLY_MAX: '3',
        EMAIL_GLOBAL_PAUSE_MINUTES: '2',
        EMAIL_SIGNIN_HOURLY_MAX: '1',
        EMAIL_APP_HOURLY_SHARE: '50',
        EMAIL_SIGNIN_APP_HOURLY_SHARE: '40',
      })
    ).toEqual({ hourlyMax: 3, pauseMinutes: 2, signInHourlyMax: 1, appSharePercent: 50, signInAppSharePercent: 40 });
    expect(
      mailGuardConfigFromEnv({
        EMAIL_GLOBAL_HOURLY_MAX: '-1',
        EMAIL_GLOBAL_PAUSE_MINUTES: 'x',
        EMAIL_SIGNIN_HOURLY_MAX: '0',
        EMAIL_APP_HOURLY_SHARE: '250',
        EMAIL_SIGNIN_APP_HOURLY_SHARE: '0',
      })
    ).toEqual({ hourlyMax: 500, pauseMinutes: 15, appSharePercent: 100, signInAppSharePercent: 25 });
  });

  it('the budgets: sign-in reserves 20 % (≥ 50, ≤ half), notifications get the rest, one app 25 % of those', () => {
    expect(mailBudgets({ hourlyMax: 500, pauseMinutes: 15 })).toEqual({ global: 500, sign_in: 100, notification: 400, perApp: 100, perAppSignIn: 25 });
    expect(mailBudgets({ hourlyMax: 1000, pauseMinutes: 15 })).toEqual({ global: 1000, sign_in: 200, notification: 800, perApp: 200, perAppSignIn: 50 });
    expect(mailBudgets({ hourlyMax: 100, pauseMinutes: 15 })).toEqual({ global: 100, sign_in: 50, notification: 50, perApp: 12, perAppSignIn: 12 });
    // One app's sign-in share never drops below 10 codes (MIN_SIGN_IN_APP_SHARE)…
    expect(mailBudgets({ hourlyMax: 60, pauseMinutes: 15 })).toEqual({ global: 60, sign_in: 30, notification: 30, perApp: 7, perAppSignIn: 10 });
    // …nor exceeds the sign-in budget; an explicit share applies.
    expect(mailBudgets({ hourlyMax: 500, pauseMinutes: 15, signInHourlyMax: 4 })).toMatchObject({ sign_in: 4, perAppSignIn: 4 });
    expect(mailBudgets({ hourlyMax: 500, pauseMinutes: 15, signInAppSharePercent: 100 })).toMatchObject({ sign_in: 100, perAppSignIn: 100 });
    // Explicit values; a sign-in budget above the cap leaves notifications one.
    expect(mailBudgets({ hourlyMax: 500, pauseMinutes: 15, signInHourlyMax: 20, appSharePercent: 50 })).toEqual({
      global: 500,
      sign_in: 20,
      notification: 480,
      perApp: 240,
      perAppSignIn: 10,
    });
    expect(mailBudgets({ hourlyMax: 500, pauseMinutes: 15, signInHourlyMax: 9999 })).toMatchObject({ sign_in: 499, notification: 1, perApp: 1 });
    // Degenerate caps still give each class one address.
    expect(mailBudgets({ hourlyMax: 1, pauseMinutes: 15 })).toMatchObject({ sign_in: 1, notification: 1, perApp: 1 });
  });

  it('notifications past their budget: that class pauses + a super-admin ALERT line; sign-in codes keep going to their own limit', async () => {
    const redis = fakeRedis();
    const l = log();
    // G = 10: sign-in 5, notifications 5; one app may use all of them (share 100 %).
    const g = redisMailGuard({ redis: () => redis, config: { hourlyMax: 10, pauseMinutes: 15, appSharePercent: 100 }, log: l });
    await g.assertOpen(notify());
    await g.admit(3, notify());
    await g.admit(2, notify('app_2'));
    expect(await redis.pttl(MAIL_COUNTER_KEYS.notification)).toBe(3_600_000);
    const over = await g.admit(1, notify('app_3')).catch((e: unknown) => e);
    expect(over).toMatchObject({
      code: 'unavailable',
      status: 503,
      headers: { 'Retry-After': '900' },
      details: { reason: 'email_paused', class: 'notification' },
    });
    expect(l.error).toHaveBeenCalledTimes(1);
    expect(l.error).toHaveBeenCalledWith(
      ALERT,
      expect.objectContaining({
        event: 'email_global_pause',
        alert: true,
        audience: 'super_admin',
        max: 10,
        class: 'notification',
        class_max: 5,
        app_id: 'app_3',
        module: 'forms',
        resume: expect.stringContaining(MAIL_PAUSE_KEYS.notification),
      })
    );
    // Every app's notifications are refused while paused…
    for (const app of ['app_1', 'app_2', 'app_4']) {
      await expect(g.assertOpen(notify(app))).rejects.toMatchObject({ code: 'unavailable', details: { reason: 'email_paused' } });
    }
    expect(l.warn).toHaveBeenCalledWith('module e-mail refused: paused', expect.objectContaining({ reason: 'global_pause', class: 'notification' }));
    // …while sign-in codes go out, up to THEIR limit (5), then pause on their own.
    for (let i = 0; i < 5; i++) {
      await g.assertOpen(signIn(`app_${i}`));
      await g.admit(1, signIn(`app_${i}`));
    }
    await expect(g.admit(1, signIn())).rejects.toMatchObject({ code: 'unavailable', details: { reason: 'email_paused', class: 'sign_in' } });
    expect(l.error).toHaveBeenLastCalledWith(ALERT, expect.objectContaining({ event: 'email_global_pause', class: 'sign_in', class_max: 5, max: 10 }));
    await expect(g.assertOpen(signIn())).rejects.toMatchObject({ details: { reason: 'email_paused', class: 'sign_in' } });

    // Both pauses end on their own after EMAIL_GLOBAL_PAUSE_MINUTES.
    redis.now += 15 * 60_000;
    await expect(g.assertOpen(notify())).resolves.toBeUndefined();
    await expect(g.assertOpen(signIn())).resolves.toBeUndefined();
    // A pause set by hand (no expiry) is honoured — for its class only.
    redis.store.set(MAIL_PAUSE_KEYS.notification, { v: '1', exp: null });
    await expect(g.assertOpen(notify())).rejects.toMatchObject({ code: 'unavailable', headers: { 'Retry-After': '900' } });
    await expect(g.assertOpen(signIn())).resolves.toBeUndefined();
  });

  it('sign-in codes exhausted first: sign-in pauses, notifications keep going', async () => {
    const redis = fakeRedis();
    const g = redisMailGuard({ redis: () => redis, config: { hourlyMax: 10, pauseMinutes: 1, signInHourlyMax: 2, appSharePercent: 100 }, log: log() });
    // (One app's share = the whole sign-in budget here: a second app trips the class pause.)
    await g.admit(2, signIn());
    await expect(g.admit(1, signIn('app_2'))).rejects.toMatchObject({ details: { reason: 'email_paused', class: 'sign_in' }, headers: { 'Retry-After': '60' } });
    await expect(g.assertOpen(signIn())).rejects.toMatchObject({ code: 'unavailable' });
    await g.assertOpen(notify());
    await g.admit(8, notify());
    expect(await redis.pttl(MAIL_PAUSE_KEYS.notification)).toBe(-2);
  });

  it('one app past its share of notifications: its mail is refused until its hour ends; other apps and sign-in continue; no ALERT', async () => {
    const redis = fakeRedis();
    const l = log();
    // G = 100: sign-in 50, notifications 50, one app 25 % → 12.
    const g = redisMailGuard({ redis: () => redis, config: { hourlyMax: 100, pauseMinutes: 15 }, log: l });
    await g.admit(10, notify('greedy'));
    redis.now += 10 * 60_000;
    await g.admit(2, notify('greedy'));
    await expect(g.assertOpen(notify('greedy'))).rejects.toMatchObject({
      code: 'unavailable',
      status: 503,
      details: { reason: 'email_paused', class: 'notification', limit: 'EMAIL_APP_HOURLY_SHARE', value: 12 },
      headers: { 'Retry-After': String(50 * 60) },
    });
    expect(l.warn).toHaveBeenCalledWith('module e-mail refused: the app used its hourly share', expect.objectContaining({ reason: 'app_share', app_id: 'greedy' }));
    // A multi-recipient message that crosses the share is refused in admit and not counted server-wide.
    await g.admit(10, notify('other'));
    await expect(g.admit(5, notify('other'))).rejects.toMatchObject({ details: { limit: 'EMAIL_APP_HOURLY_SHARE', value: 12 } });
    expect(l.warn).toHaveBeenCalledWith(
      'module e-mail: an app used its hourly share of notifications',
      expect.objectContaining({ event: 'email_app_share_exceeded', app_id: 'other' })
    );
    expect(Number(await redis.get(MAIL_COUNTER_KEYS.notification))).toBe(22);
    expect(Number(await redis.get(mailAppCounterKey('other')))).toBe(15);
    // Other apps and sign-in codes are not affected; the server is not paused.
    await g.assertOpen(notify('third'));
    await g.admit(12, notify('third'));
    await g.assertOpen(signIn('greedy'));
    await g.admit(1, signIn('greedy'));
    expect(l.error).not.toHaveBeenCalled();
    // The greedy app's hour ends → its notifications go out again.
    redis.now += 50 * 60_000;
    await expect(g.assertOpen(notify('greedy'))).resolves.toBeUndefined();
  });

  it('one app cannot pause sign-in for every app: past its share of sign-in codes only IT is refused (NSO-322 H2)', async () => {
    const redis = fakeRedis();
    const l = log();
    // Defaults: sign-in 100 an hour, one app 25 of them.
    const g = redisMailGuard({ redis: () => redis, config: { hourlyMax: 500, pauseMinutes: 15 }, log: l });
    expect(g.budgets).toMatchObject({ sign_in: 100, perAppSignIn: 25 });
    for (let i = 0; i < 25; i++) {
      await g.assertOpen(signIn('greedy'));
      await g.admit(1, signIn('greedy'));
    }
    const refused = await g.admit(1, signIn('greedy')).catch((e: unknown) => e);
    expect(refused).toMatchObject({
      code: 'unavailable',
      status: 503,
      details: { reason: 'email_paused', class: 'sign_in', limit: 'EMAIL_SIGNIN_APP_HOURLY_SHARE', value: 25 },
      headers: { 'Retry-After': '3600' },
    });
    expect(l.warn).toHaveBeenCalledWith(
      'module e-mail: an app used its hourly share of sign-in codes',
      expect.objectContaining({ event: 'email_app_share_exceeded', class: 'sign_in', app_id: 'greedy', share_max: 25 })
    );
    await expect(g.assertOpen(signIn('greedy'))).rejects.toMatchObject({ details: { limit: 'EMAIL_SIGNIN_APP_HOURLY_SHARE' } });
    // Hammering on does not count server-wide, and nothing pauses.
    for (let i = 0; i < 200; i++) await g.admit(1, signIn('greedy')).catch(() => undefined);
    expect(Number(await redis.get(MAIL_COUNTER_KEYS.sign_in))).toBe(25);
    expect(Number(await redis.get(mailAppCounterKey('greedy', 'sign_in')))).toBe(226);
    expect(await redis.pttl(MAIL_PAUSE_KEYS.sign_in)).toBe(-2);
    expect(l.error).not.toHaveBeenCalled();
    // Other apps sign in; the greedy app's notifications are a separate share.
    await g.assertOpen(signIn('other'));
    await g.admit(1, signIn('other'));
    await g.assertOpen(notify('greedy'));
    await g.admit(1, notify('greedy'));
  });

  it('fails closed on a Redis error', async () => {
    const down = async () => {
      throw new Error('down');
    };
    const broken = { get: down, pttl: down, incrby: down, pexpire: down, set: down } as unknown as MailGuardRedis;
    const l = log();
    const g = redisMailGuard({ redis: () => broken, config: { hourlyMax: 3, pauseMinutes: 1 }, log: l });
    for (const meta of [notify(), signIn()]) {
      await expect(g.assertOpen(meta)).rejects.toMatchObject({ code: 'unavailable', headers: { 'Retry-After': '60' } });
      await expect(g.admit(1, meta)).rejects.toMatchObject({ code: 'unavailable' });
    }
    expect(l.error).toHaveBeenCalledWith('module e-mail guard error — fail-closed', expect.objectContaining({ error: 'down' }));
  });

  it('the in-memory guard behaves the same (both classes, pause expiry, reset)', async () => {
    let now = 0;
    const g = memoryMailGuard({ hourlyMax: 4, pauseMinutes: 1, appSharePercent: 100 }, log(), () => now);
    // G = 4: sign-in 2, notifications 2.
    await g.admit(2, notify());
    await expect(g.admit(1, notify())).rejects.toMatchObject({ code: 'unavailable', details: { class: 'notification' } });
    await expect(g.assertOpen(notify())).rejects.toMatchObject({ code: 'unavailable' });
    await g.assertOpen(signIn());
    await g.admit(2, signIn());
    await expect(g.admit(1, signIn())).rejects.toMatchObject({ details: { class: 'sign_in', limit: 'EMAIL_SIGNIN_APP_HOURLY_SHARE' } });
    await expect(g.admit(1, signIn('app_2'))).rejects.toMatchObject({ details: { class: 'sign_in', reason: 'email_paused' } });
    now += 60_000;
    // The pauses are over; app_1 itself still sits at its hourly shares (2 + 2).
    await expect(g.assertOpen(notify())).rejects.toMatchObject({ details: { limit: 'EMAIL_APP_HOURLY_SHARE' } });
    await expect(g.assertOpen(signIn())).rejects.toMatchObject({ details: { limit: 'EMAIL_SIGNIN_APP_HOURLY_SHARE' } });
    await g.assertOpen(notify('app_2'));
    await g.assertOpen(signIn('app_2'));
    // The hourly class counter still runs: the next notification trips the pause again.
    await expect(g.admit(1, notify('app_2'))).rejects.toMatchObject({ code: 'unavailable', details: { class: 'notification' } });
    await expect(g.assertOpen(notify('app_2'))).rejects.toMatchObject({ details: { reason: 'email_paused' } });
    g.reset();
    await g.assertOpen(notify());
    await g.admit(2, notify());
    // The store alone: keys expire on the clock.
    const r = memoryMailGuardRedis(() => now);
    await r.set('k', '1', 'PX', 10);
    expect(await r.pttl('k')).toBe(10);
    now += 10;
    expect(await r.get('k')).toBeNull();
  });
});

/** A Redis double with the commands the guard uses (a clock you move by hand). */
function fakeRedis(): MailGuardRedis & { store: Map<string, { v: string; exp: number | null }>; now: number } {
  const store = new Map<string, { v: string; exp: number | null }>();
  const r = {
    store,
    now: 0,
    live(k: string) {
      const e = store.get(k);
      if (e && e.exp !== null && e.exp <= r.now) store.delete(k);
      return store.get(k);
    },
    async get(k: string) {
      return r.live(k)?.v ?? null;
    },
    async pttl(k: string) {
      const e = r.live(k);
      if (!e) return -2;
      return e.exp === null ? -1 : e.exp - r.now;
    },
    async incrby(k: string, n: number) {
      const e = r.live(k) ?? { v: '0', exp: null };
      e.v = String(Number(e.v) + n);
      store.set(k, e);
      return Number(e.v);
    },
    async pexpire(k: string, ms: number) {
      const e = r.live(k);
      if (!e) return 0;
      e.exp = r.now + ms;
      return 1;
    },
    async set(k: string, v: string, _px: 'PX', ms: number) {
      store.set(k, { v, exp: r.now + ms });
      return 'OK';
    },
  };
  return r;
}
