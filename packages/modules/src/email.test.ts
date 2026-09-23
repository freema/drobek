import { describe, expect, it, vi } from 'vitest';
import { capEmailText, emailKind, MAX_EMAIL_TEXT, resolveRecipients, sanitizeSubject } from './email.js';
import { MAIL_GLOBAL_COUNTER_KEY, MAIL_PAUSE_KEY, mailGuardConfigFromEnv, memoryMailGuard, redisMailGuard, type MailGuardRedis } from './mail-guard.js';

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

/** A Redis double with the four commands the guard uses. */
function fakeRedis(): MailGuardRedis & { store: Map<string, { v: number; exp: number | null }>; now: number } {
  const store = new Map<string, { v: number; exp: number | null }>();
  const r = {
    store,
    now: 0,
    live(k: string) {
      const e = store.get(k);
      if (e && e.exp !== null && e.exp <= r.now) store.delete(k);
      return store.get(k);
    },
    async pttl(k: string) {
      const e = r.live(k);
      if (!e) return -2;
      return e.exp === null ? -1 : e.exp - r.now;
    },
    async incrby(k: string, n: number) {
      const e = r.live(k) ?? { v: 0, exp: null };
      e.v += n;
      store.set(k, e);
      return e.v;
    },
    async pexpire(k: string, ms: number) {
      const e = r.live(k);
      if (!e) return 0;
      e.exp = r.now + ms;
      return 1;
    },
    async set(k: string, v: string, _px: 'PX', ms: number) {
      store.set(k, { v: Number(v), exp: r.now + ms });
      return 'OK';
    },
  };
  return r;
}

describe('the global hourly cap on module e-mail', () => {
  const meta = { app_id: 'app_1', module: 'forms', kind: 'notification' };

  it('env config with defaults', () => {
    expect(mailGuardConfigFromEnv({})).toEqual({ hourlyMax: 500, pauseMinutes: 15 });
    expect(mailGuardConfigFromEnv({ EMAIL_GLOBAL_HOURLY_MAX: '3', EMAIL_GLOBAL_PAUSE_MINUTES: '2' })).toEqual({ hourlyMax: 3, pauseMinutes: 2 });
    expect(mailGuardConfigFromEnv({ EMAIL_GLOBAL_HOURLY_MAX: '-1', EMAIL_GLOBAL_PAUSE_MINUTES: 'x' })).toEqual({ hourlyMax: 500, pauseMinutes: 15 });
  });

  it('counts recipients; past the cap: pause + a super-admin ALERT line; paused sends refused; the pause ends', async () => {
    const redis = fakeRedis();
    const l = log();
    const g = redisMailGuard({ redis: () => redis, config: { hourlyMax: 3, pauseMinutes: 15 }, log: l });
    await g.assertOpen(meta);
    await g.admit(2, meta);
    await g.admit(1, meta);
    expect(await redis.pttl(MAIL_GLOBAL_COUNTER_KEY)).toBe(3_600_000);
    await expect(g.admit(1, meta)).rejects.toMatchObject({ code: 'unavailable', status: 503, headers: { 'Retry-After': '900' } });
    expect(l.error).toHaveBeenCalledWith(
      'ALERT: module e-mail paused — the global hourly cap was reached',
      expect.objectContaining({ event: 'email_global_pause', alert: true, audience: 'super_admin', max: 3, app_id: 'app_1', module: 'forms' })
    );
    await expect(g.assertOpen(meta)).rejects.toMatchObject({ code: 'unavailable', details: { reason: 'email_paused' } });
    expect(l.warn).toHaveBeenCalledWith('module e-mail refused: paused', expect.objectContaining({ reason: 'global_pause' }));
    redis.now += 15 * 60_000;
    await expect(g.assertOpen(meta)).resolves.toBeUndefined();
    // A pause set by hand (no expiry) is honoured.
    redis.store.set(MAIL_PAUSE_KEY, { v: 1, exp: null });
    await expect(g.assertOpen(meta)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('fails closed on a Redis error', async () => {
    const broken = { pttl: async () => { throw new Error('down'); } } as unknown as MailGuardRedis;
    const g = redisMailGuard({ redis: () => broken, config: { hourlyMax: 3, pauseMinutes: 1 }, log: log() });
    await expect(g.assertOpen(meta)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(g.admit(1, meta)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('the in-memory guard behaves the same', async () => {
    let now = 0;
    const g = memoryMailGuard({ hourlyMax: 2, pauseMinutes: 1 }, log(), () => now);
    await g.admit(2, meta);
    await expect(g.admit(1, meta)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(g.assertOpen(meta)).rejects.toMatchObject({ code: 'unavailable' });
    now += 60_000;
    await g.assertOpen(meta);
  });
});
