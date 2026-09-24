/**
 * The operator-wide brake on module e-mail (M1-04, §6 "Spam"; NSO-320): every
 * address any platform module sends to counts against an hourly budget of
 * `EMAIL_GLOBAL_HOURLY_MAX` recipients (all apps together), split in two
 * classes so a flood of notifications can never lock end users out:
 *
 *  - `sign_in` — the auth module's one-time codes (`{ signInAddress }`): a
 *    reserved share, `EMAIL_SIGNIN_HOURLY_MAX` (default 20 % of the global
 *    cap, at least 50, never more than half of it), and ONE app may use at
 *    most `EMAIL_SIGNIN_APP_HOURLY_SHARE` percent of it (default 25, at least
 *    10 codes) — so one app can never pause sign-in for all (NSO-322 H2);
 *  - `notification` — everything else (form notifications, notifyAdmins,
 *    mail to the signed-in user): the rest of the global cap, and ONE app
 *    may use at most `EMAIL_APP_HOURLY_SHARE` percent of it (default 25).
 *
 * On top of the per-app shares, ONE workspace (all its apps together) may use
 * at most `EMAIL_WORKSPACE_HOURLY_SHARE` percent of each class (default 50,
 * never less than one app's share) — so a workspace with four apps cannot
 * take a whole class and pause it for every other workspace (NSO-323 M4).
 * Both shares must pass.
 *
 * The two class budgets add up to the global cap, so the operator's mailbox
 * sees at most `EMAIL_GLOBAL_HOURLY_MAX` module recipients per budget window.
 * Past a class budget, THAT class pauses for exactly
 * `EMAIL_GLOBAL_PAUSE_MINUTES` and an ALERT line for the super-admin goes to
 * the log (`event: email_global_pause`, with the `class`): the mailbox is
 * protected before the SMTP provider suspends it. The pause is a FIXED window
 * (NSO-327): tripping it also resets the class counter, so the first message
 * after the pause starts a fresh hourly budget instead of re-tripping the
 * pause until the old hour ends — the per-app and per-workspace shares stay
 * hourly, so the apps that filled the class stay refused until THEIR hour
 * ends. The other class keeps working. Past its
 * share of a class, one app's (or one workspace's) messages of that class are
 * refused until its hourly window ends; other apps (workspaces) continue. Pattern of the dashboard's
 * `OTP_GLOBAL_HOURLY_MAX` auto-pause (@drobek/auth otp-guard).
 *
 * These are operator knobs (env only): the limits provider does not override
 * them, because they protect the operator's mailbox, not a workspace's plan.
 * The dashboard login codes and workspace invites keep their own guard.
 *
 * Redis keys: `drobek:rl:mail:<class>` (the hourly class counters),
 * `drobek:rl:mail:app:<app_id>` (one app's notification counter),
 * `drobek:rl:mail:app:<app_id>:sign_in` (one app's sign-in counter),
 * `drobek:rl:mail:ws:<workspace_id>` / `drobek:rl:mail:ws:<workspace_id>:sign_in`
 * (one workspace's counters) and
 * `drobek:mail:paused:<class>` (the pause; delete it to resume early). Any
 * Redis error is FAIL-CLOSED: no e-mail is sent.
 */
import type { Logger } from '@drobek/core';
import type { EmailKind } from './contract.js';
import { ModuleError } from './errors.js';

/** The budget a message counts against (= its EmailKind). */
export type MailClass = EmailKind;

export const MAIL_COUNTER_KEYS: Readonly<Record<MailClass, string>> = {
  notification: 'drobek:rl:mail:notification',
  sign_in: 'drobek:rl:mail:sign_in',
};
export const MAIL_PAUSE_KEYS: Readonly<Record<MailClass, string>> = {
  notification: 'drobek:mail:paused:notification',
  sign_in: 'drobek:mail:paused:sign_in',
};
/** One app's counter of a class (the per-app share). */
export function mailAppCounterKey(appId: string, cls: MailClass = 'notification'): string {
  return cls === 'notification' ? `drobek:rl:mail:app:${appId}` : `drobek:rl:mail:app:${appId}:${cls}`;
}
/** One workspace's counter of a class (the per-workspace share). */
export function mailWorkspaceCounterKey(workspaceId: string, cls: MailClass = 'notification'): string {
  return cls === 'notification' ? `drobek:rl:mail:ws:${workspaceId}` : `drobek:rl:mail:ws:${workspaceId}:${cls}`;
}
const HOUR_MS = 60 * 60_000;

export interface MailGuardConfig {
  /** Addresses per hour across every app and both classes (EMAIL_GLOBAL_HOURLY_MAX, default 500). */
  hourlyMax: number;
  /** Pause after a class budget is hit, minutes (EMAIL_GLOBAL_PAUSE_MINUTES, default 15). */
  pauseMinutes: number;
  /** Sign-in codes per hour (EMAIL_SIGNIN_HOURLY_MAX); unset = the default reserved share. */
  signInHourlyMax?: number;
  /** Percent of the notification budget one app may use per hour (EMAIL_APP_HOURLY_SHARE, default 25). */
  appSharePercent?: number;
  /** Percent of the sign-in budget one app may use per hour (EMAIL_SIGNIN_APP_HOURLY_SHARE, default 25). */
  signInAppSharePercent?: number;
  /** Percent of each class budget one workspace (all its apps) may use per hour (EMAIL_WORKSPACE_HOURLY_SHARE, default 50). */
  workspaceSharePercent?: number;
}

/** The least sign-in codes one app may send per hour, whatever the share (capped at the sign-in budget). */
const MIN_SIGN_IN_APP_SHARE = 10;

/** The effective hourly budgets (recipients) derived from the config. */
export interface MailBudgets {
  global: number;
  sign_in: number;
  notification: number;
  /** Notifications per app per hour. */
  perApp: number;
  /** Sign-in codes per app per hour. */
  perAppSignIn: number;
  /** Notifications per workspace per hour (all its apps). */
  perWorkspace: number;
  /** Sign-in codes per workspace per hour (all its apps). */
  perWorkspaceSignIn: number;
}

/**
 * sign_in = EMAIL_SIGNIN_HOURLY_MAX, or by default min(max(50, ⌈20 % × G⌉),
 * ⌊G / 2⌋); an explicit value is capped at G − 1. notification = G − sign_in
 * (at least 1). perApp = ⌊notification × share / 100⌋ (at least 1).
 * perAppSignIn = ⌊sign_in × sign-in share / 100⌋, at least
 * MIN_SIGN_IN_APP_SHARE, never more than sign_in. perWorkspace /
 * perWorkspaceSignIn = ⌊class × workspace share / 100⌋, never less than the
 * app share of that class, never more than the class.
 */
export function mailBudgets(c: MailGuardConfig): MailBudgets {
  const g = c.hourlyMax;
  const reserved = c.signInHourlyMax ?? Math.min(Math.max(50, Math.ceil(g * 0.2)), Math.floor(g / 2));
  const signIn = Math.max(1, Math.min(reserved, g - 1));
  const notification = Math.max(1, g - signIn);
  const share = Math.min(100, Math.max(1, c.appSharePercent ?? 25));
  const signInShare = Math.min(100, Math.max(1, c.signInAppSharePercent ?? 25));
  const wsShare = Math.min(100, Math.max(1, c.workspaceSharePercent ?? 50));
  const perApp = Math.max(1, Math.floor((notification * share) / 100));
  const perAppSignIn = Math.min(signIn, Math.max(MIN_SIGN_IN_APP_SHARE, Math.floor((signIn * signInShare) / 100)));
  return {
    global: g,
    sign_in: signIn,
    notification,
    perApp,
    perAppSignIn,
    perWorkspace: Math.min(notification, Math.max(perApp, Math.floor((notification * wsShare) / 100))),
    perWorkspaceSignIn: Math.min(signIn, Math.max(perAppSignIn, Math.floor((signIn * wsShare) / 100))),
  };
}

function envInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const n = Number(env[name]);
  return env[name] !== undefined && env[name] !== '' && Number.isInteger(n) && n > 0 ? n : undefined;
}

export function mailGuardConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MailGuardConfig {
  const signIn = envInt(env, 'EMAIL_SIGNIN_HOURLY_MAX');
  return {
    hourlyMax: envInt(env, 'EMAIL_GLOBAL_HOURLY_MAX') ?? 500,
    pauseMinutes: envInt(env, 'EMAIL_GLOBAL_PAUSE_MINUTES') ?? 15,
    ...(signIn !== undefined ? { signInHourlyMax: signIn } : {}),
    appSharePercent: Math.min(100, envInt(env, 'EMAIL_APP_HOURLY_SHARE') ?? 25),
    signInAppSharePercent: Math.min(100, envInt(env, 'EMAIL_SIGNIN_APP_HOURLY_SHARE') ?? 25),
    workspaceSharePercent: Math.min(100, envInt(env, 'EMAIL_WORKSPACE_HOURLY_SHARE') ?? 50),
  };
}

/** Which message the guard is asked about (logged; never an address). */
export interface MailGuardMeta {
  app_id: string;
  /** The app's workspace (its apps share the per-workspace budget). */
  workspace_id: string;
  module: string;
  /** `sign_in` counts against the sign-in budget; anything else is a notification. */
  kind: EmailKind;
}

export interface MailGuard {
  /** The hourly budgets it enforces (modules clamp their own per-app caps to them). */
  readonly budgets?: MailBudgets;
  /** Refuse (ModuleError `unavailable`, 503) while the message's class — or its app's or workspace's share — is used up. */
  assertOpen(meta: MailGuardMeta): Promise<void>;
  /** Count `recipients` against the app's share, its workspace's share and the class budget; past it: pause (fixed window, class counter reset), ALERT, refuse. */
  admit(recipients: number, meta: MailGuardMeta): Promise<void>;
}

export interface MailGuardRedis {
  get(key: string): Promise<string | null>;
  pttl(key: string): Promise<number>;
  incrby(key: string, n: number): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  set(key: string, value: string, px: 'PX', ms: number): Promise<unknown>;
}

function classOf(meta: MailGuardMeta): MailClass {
  return meta.kind === 'sign_in' ? 'sign_in' : 'notification';
}

function paused(cls: MailClass, retryAfterSec: number): ModuleError {
  const message =
    cls === 'sign_in'
      ? 'Sign-in e-mails from apps are paused for a while on this server. Try again later.'
      : 'E-mail from apps is paused for a while on this server. Try again later.';
  return new ModuleError('unavailable', message, {
    details: { reason: 'email_paused', class: cls },
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec))) },
  });
}

function appShareUsed(cls: MailClass, perApp: number, retryAfterSec: number): ModuleError {
  const message =
    cls === 'sign_in'
      ? 'This app has sent its share of sign-in e-mails for this hour. Try again later.'
      : 'This app has sent its share of e-mail for this hour. Try again later.';
  const limit = cls === 'sign_in' ? 'EMAIL_SIGNIN_APP_HOURLY_SHARE' : 'EMAIL_APP_HOURLY_SHARE';
  return new ModuleError('unavailable', message, {
    details: { reason: 'email_paused', class: cls, limit, value: perApp },
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec))) },
  });
}

function workspaceShareUsed(cls: MailClass, perWorkspace: number, retryAfterSec: number): ModuleError {
  const message =
    cls === 'sign_in'
      ? "This workspace's apps have sent their share of sign-in e-mails for this hour. Try again later."
      : "This workspace's apps have sent their share of e-mail for this hour. Try again later.";
  return new ModuleError('unavailable', message, {
    details: { reason: 'email_paused', class: cls, limit: 'EMAIL_WORKSPACE_HOURLY_SHARE', value: perWorkspace },
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec))) },
  });
}

/** One app's hourly budget of a class. */
function appShareOf(budgets: MailBudgets, cls: MailClass): number {
  return cls === 'sign_in' ? budgets.perAppSignIn : budgets.perApp;
}

/** One workspace's hourly budget of a class. */
function workspaceShareOf(budgets: MailBudgets, cls: MailClass): number {
  return cls === 'sign_in' ? budgets.perWorkspaceSignIn : budgets.perWorkspace;
}

function guardDown(): ModuleError {
  return new ModuleError('unavailable', 'E-mail cannot be sent right now. Try again in a moment.', {
    headers: { 'Retry-After': '60' },
  });
}

/** The production guard (Redis). */
export function redisMailGuard(opts: { redis: () => MailGuardRedis; config: MailGuardConfig; log: Logger }): MailGuard {
  const pauseMs = opts.config.pauseMinutes * 60_000;
  const budgets = mailBudgets(opts.config);
  const log = opts.log;
  const failClosed = (meta: MailGuardMeta, err: unknown): ModuleError => {
    log.error('module e-mail guard error — fail-closed', { ...meta, error: String((err as Error)?.message ?? err) });
    return guardDown();
  };
  /** Seconds until `key` expires (a missing/eternal key → `fallbackSec`). */
  const ttlSec = async (r: MailGuardRedis, key: string, fallbackSec: number) => {
    const ttl = await r.pttl(key);
    return ttl > 0 ? ttl / 1000 : fallbackSec;
  };
  /** INCRBY with an hourly window; a counter that lost its expiry gets one back. */
  const count = async (r: MailGuardRedis, key: string, n: number) => {
    const c = await r.incrby(key, n);
    if (c === n || (await r.pttl(key)) < 0) await r.pexpire(key, HOUR_MS);
    return c;
  };

  return {
    budgets,
    async assertOpen(meta) {
      const cls = classOf(meta);
      let refusal: ModuleError | null = null;
      try {
        const r = opts.redis();
        const ttl = await r.pttl(MAIL_PAUSE_KEYS[cls]);
        // -2: no pause. -1: a pause without expiry (set by hand) — honour it.
        if (ttl !== -2) {
          log.warn('module e-mail refused: paused', { event: 'email_send_blocked', reason: 'global_pause', class: cls, ...meta });
          refusal = paused(cls, ttl > 0 ? ttl / 1000 : pauseMs / 1000);
        } else {
          const key = mailAppCounterKey(meta.app_id, cls);
          const share = appShareOf(budgets, cls);
          const used = Number((await r.get(key)) ?? 0);
          if (used >= share) {
            log.warn('module e-mail refused: the app used its hourly share', {
              event: 'email_send_blocked',
              reason: 'app_share',
              class: cls,
              share_max: share,
              ...meta,
            });
            refusal = appShareUsed(cls, share, await ttlSec(r, key, HOUR_MS / 1000));
          } else {
            const wsKey = mailWorkspaceCounterKey(meta.workspace_id, cls);
            const wsShare = workspaceShareOf(budgets, cls);
            if (Number((await r.get(wsKey)) ?? 0) >= wsShare) {
              log.warn('module e-mail refused: the workspace used its hourly share', {
                event: 'email_send_blocked',
                reason: 'workspace_share',
                class: cls,
                share_max: wsShare,
                ...meta,
              });
              refusal = workspaceShareUsed(cls, wsShare, await ttlSec(r, wsKey, HOUR_MS / 1000));
            }
          }
        }
      } catch (err) {
        throw failClosed(meta, err);
      }
      if (refusal) throw refusal;
    },
    async admit(recipients, meta) {
      const cls = classOf(meta);
      let refusal: ModuleError | null = null;
      let tripped = false;
      try {
        const r = opts.redis();
        // A message that raced past assertOpen while the pause tripped is
        // refused without counting (the class counter restarted at the trip).
        const pauseTtl = await r.pttl(MAIL_PAUSE_KEYS[cls]);
        if (pauseTtl !== -2) refusal = paused(cls, pauseTtl > 0 ? pauseTtl / 1000 : pauseMs / 1000);
        if (!refusal) {
          const key = mailAppCounterKey(meta.app_id, cls);
          const share = appShareOf(budgets, cls);
          const used = await count(r, key, recipients);
          if (used > share) {
            if (used - recipients <= share) {
              log.warn(`module e-mail: an app used its hourly share of ${cls === 'sign_in' ? 'sign-in codes' : 'notifications'}`, {
                event: 'email_app_share_exceeded',
                class: cls,
                share_max: share,
                ...meta,
              });
            }
            refusal = appShareUsed(cls, share, await ttlSec(r, key, HOUR_MS / 1000));
          }
        }
        if (!refusal) {
          const key = mailWorkspaceCounterKey(meta.workspace_id, cls);
          const share = workspaceShareOf(budgets, cls);
          const used = await count(r, key, recipients);
          if (used > share) {
            if (used - recipients <= share) {
              log.warn(`module e-mail: a workspace used its hourly share of ${cls === 'sign_in' ? 'sign-in codes' : 'notifications'}`, {
                event: 'email_workspace_share_exceeded',
                class: cls,
                share_max: share,
                ...meta,
              });
            }
            refusal = workspaceShareUsed(cls, share, await ttlSec(r, key, HOUR_MS / 1000));
          }
        }
        if (!refusal) {
          const used = await count(r, MAIL_COUNTER_KEYS[cls], recipients);
          if (used > budgets[cls]) {
            await r.set(MAIL_PAUSE_KEYS[cls], '1', 'PX', pauseMs);
            // A fixed pause: the class budget restarts with the first message after it.
            await r.set(MAIL_COUNTER_KEYS[cls], '0', 'PX', pauseMs);
            tripped = true;
            refusal = paused(cls, pauseMs / 1000);
          }
        }
      } catch (err) {
        throw failClosed(meta, err);
      }
      if (tripped) {
        log.error('ALERT: module e-mail paused — the global hourly cap was reached', {
          event: 'email_global_pause',
          alert: true,
          audience: 'super_admin',
          max: budgets.global,
          class: cls,
          class_max: budgets[cls],
          pause_minutes: opts.config.pauseMinutes,
          resume: `automatic after ${opts.config.pauseMinutes} min, or DEL ${MAIL_PAUSE_KEYS[cls]} in Redis`,
          ...meta,
        });
      }
      if (refusal) throw refusal;
    },
  };
}

/** An in-process Redis stand-in with the commands the guard uses (`now` is the clock seam). */
export function memoryMailGuardRedis(now: () => number = Date.now): MailGuardRedis & { clear(): void } {
  const store = new Map<string, { v: string; exp: number | null }>();
  const live = (k: string) => {
    const e = store.get(k);
    if (e && e.exp !== null && e.exp <= now()) store.delete(k);
    return store.get(k);
  };
  return {
    async get(k) {
      return live(k)?.v ?? null;
    },
    async pttl(k) {
      const e = live(k);
      if (!e) return -2;
      return e.exp === null ? -1 : e.exp - now();
    },
    async incrby(k, n) {
      const e = live(k) ?? { v: '0', exp: null };
      e.v = String(Number(e.v) + n);
      store.set(k, e);
      return Number(e.v);
    },
    async pexpire(k, ms) {
      const e = live(k);
      if (!e) return 0;
      e.exp = now() + ms;
      return 1;
    },
    async set(k, v, _px, ms) {
      store.set(k, { v, exp: now() + ms });
      return 'OK';
    },
    clear() {
      store.clear();
    },
  };
}

/** An in-process guard (tests; `now` is the clock seam) — the Redis guard over an in-memory store. */
export function memoryMailGuard(config: MailGuardConfig, log: Logger, now: () => number = Date.now): MailGuard & { reset(): void } {
  const store = memoryMailGuardRedis(now);
  const guard = redisMailGuard({ redis: () => store, config, log });
  return { ...guard, budgets: mailBudgets(config), reset: () => store.clear() };
}
