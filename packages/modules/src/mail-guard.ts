/**
 * The operator-wide brake on module e-mail (M1-04, §6 "Spam"): every address
 * any platform module sends to — form notifications, notifyAdmins, the auth
 * module's sign-in codes — counts against ONE hourly budget
 * (`EMAIL_GLOBAL_HOURLY_MAX`, all apps together). Past it, all module e-mail
 * pauses for `EMAIL_GLOBAL_PAUSE_MINUTES` and an ALERT line for the
 * super-admin goes to the log (`event: email_global_pause`): the mailbox is
 * protected before the SMTP provider suspends it. Pattern of the dashboard's
 * `OTP_GLOBAL_HOURLY_MAX` auto-pause (@drobek/auth otp-guard).
 *
 * These are operator knobs (env only): the limits provider does not override
 * them, because they protect the operator's mailbox, not a workspace's plan.
 * The dashboard login codes and workspace invites keep their own guard.
 *
 * Redis keys: `drobek:rl:mail:global` (the hourly counter) and
 * `drobek:mail:paused` (the pause; delete it to resume early). Any Redis
 * error is FAIL-CLOSED: no e-mail is sent.
 */
import type { Logger } from '@drobek/core';
import { ModuleError } from './errors.js';

export const MAIL_GLOBAL_COUNTER_KEY = 'drobek:rl:mail:global';
export const MAIL_PAUSE_KEY = 'drobek:mail:paused';
const HOUR_MS = 60 * 60_000;

export interface MailGuardConfig {
  /** Addresses per hour across every app (EMAIL_GLOBAL_HOURLY_MAX, default 500). */
  hourlyMax: number;
  /** Pause after the cap is hit, minutes (EMAIL_GLOBAL_PAUSE_MINUTES, default 15). */
  pauseMinutes: number;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const n = Number(env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function mailGuardConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MailGuardConfig {
  return {
    hourlyMax: envInt(env, 'EMAIL_GLOBAL_HOURLY_MAX', 500),
    pauseMinutes: envInt(env, 'EMAIL_GLOBAL_PAUSE_MINUTES', 15),
  };
}

/** Which message the guard is asked about (logged; never an address). */
export interface MailGuardMeta {
  app_id: string;
  module: string;
  kind: string;
}

export interface MailGuard {
  /** Refuse (ModuleError `unavailable`, 503) while module e-mail is paused. */
  assertOpen(meta: MailGuardMeta): Promise<void>;
  /** Count `recipients` against the hourly cap; past it: pause, ALERT, refuse. */
  admit(recipients: number, meta: MailGuardMeta): Promise<void>;
}

export interface MailGuardRedis {
  pttl(key: string): Promise<number>;
  incrby(key: string, n: number): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  set(key: string, value: string, px: 'PX', ms: number): Promise<unknown>;
}

function paused(retryAfterSec: number): ModuleError {
  return new ModuleError('unavailable', 'E-mail from apps is paused for a while on this server. Try again later.', {
    details: { reason: 'email_paused' },
    headers: { 'Retry-After': String(Math.max(1, retryAfterSec)) },
  });
}

function guardDown(): ModuleError {
  return new ModuleError('unavailable', 'E-mail cannot be sent right now. Try again in a moment.', {
    headers: { 'Retry-After': '60' },
  });
}

/** The production guard (Redis). */
export function redisMailGuard(opts: { redis: () => MailGuardRedis; config: MailGuardConfig; log: Logger }): MailGuard {
  const pauseMs = opts.config.pauseMinutes * 60_000;
  return {
    async assertOpen(meta) {
      let ttl: number;
      try {
        ttl = await opts.redis().pttl(MAIL_PAUSE_KEY);
      } catch (err) {
        opts.log.error('module e-mail guard error — fail-closed', { ...meta, error: String((err as Error)?.message ?? err) });
        throw guardDown();
      }
      // -2: no pause. -1: a pause without expiry (set by hand) — honour it.
      if (ttl === -2) return;
      opts.log.warn('module e-mail refused: paused', { event: 'email_send_blocked', reason: 'global_pause', ...meta });
      throw paused(ttl > 0 ? Math.ceil(ttl / 1000) : pauseMs / 1000);
    },
    async admit(recipients, meta) {
      let count: number;
      try {
        const r = opts.redis();
        count = await r.incrby(MAIL_GLOBAL_COUNTER_KEY, recipients);
        if (count === recipients) await r.pexpire(MAIL_GLOBAL_COUNTER_KEY, HOUR_MS);
        if (count > opts.config.hourlyMax) {
          await r.set(MAIL_PAUSE_KEY, '1', 'PX', pauseMs);
          // A counter that lost its expiry must not keep the cap tripped forever.
          if ((await r.pttl(MAIL_GLOBAL_COUNTER_KEY)) < 0) await r.pexpire(MAIL_GLOBAL_COUNTER_KEY, HOUR_MS);
        }
      } catch (err) {
        opts.log.error('module e-mail guard error — fail-closed', { ...meta, error: String((err as Error)?.message ?? err) });
        throw guardDown();
      }
      if (count > opts.config.hourlyMax) {
        opts.log.error('ALERT: module e-mail paused — the global hourly cap was reached', {
          event: 'email_global_pause',
          alert: true,
          audience: 'super_admin',
          max: opts.config.hourlyMax,
          pause_minutes: opts.config.pauseMinutes,
          resume: `automatic after ${opts.config.pauseMinutes} min, or DEL ${MAIL_PAUSE_KEY} in Redis`,
          ...meta,
        });
        throw paused(pauseMs / 1000);
      }
    },
  };
}

/** An in-process guard (tests; `now` is the clock seam). */
export function memoryMailGuard(config: MailGuardConfig, log: Logger, now: () => number = Date.now): MailGuard & { reset(): void } {
  let windowEnds = 0;
  let count = 0;
  let pausedUntil = 0;
  const pauseMs = config.pauseMinutes * 60_000;
  return {
    async assertOpen(meta) {
      const t = now();
      if (pausedUntil > t) {
        log.warn('module e-mail refused: paused', { event: 'email_send_blocked', reason: 'global_pause', ...meta });
        throw paused(Math.ceil((pausedUntil - t) / 1000));
      }
    },
    async admit(recipients, meta) {
      const t = now();
      if (windowEnds <= t) {
        windowEnds = t + HOUR_MS;
        count = 0;
      }
      count += recipients;
      if (count > config.hourlyMax) {
        pausedUntil = t + pauseMs;
        log.error('ALERT: module e-mail paused — the global hourly cap was reached', {
          event: 'email_global_pause',
          alert: true,
          audience: 'super_admin',
          max: config.hourlyMax,
          pause_minutes: config.pauseMinutes,
          ...meta,
        });
        throw paused(pauseMs / 1000);
      }
    },
    reset() {
      windowEnds = 0;
      count = 0;
      pausedUntil = 0;
    },
  };
}
