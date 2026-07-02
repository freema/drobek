/**
 * Layered protection for the endpoint that triggers an OTP e-mail send
 * ("OTP bombing" abuse). All counters live in Redis (atomic INCR / SET NX) —
 * no DB count queries, so there are no race conditions, and the sending
 * mailbox (Hostinger SMTP in prod) is protected from repeated suspends.
 *
 * Check order (cheapest first, fail-fast):
 *   0. kill switch / global auto-pause
 *   1. per-IP short window   (default 5 / 15 min)
 *   2. per-IP daily window   (default 20 / 24 h)
 *      [CAPTCHA seam — see below]
 *   3. per-e-mail cooldown   (default 60 s between sends — double-click dedup)
 *   4. per-e-mail hourly     (default 3 / h)
 *   5. global hourly brake   (OTP_GLOBAL_HOURLY_MAX / h) → auto-pause + ALERT
 *
 * On Redis errors the decision is FAIL-CLOSED (better a temporarily
 * unavailable login than thousands of un-throttled e-mails).
 */
import { createHash } from 'node:crypto';
import { getRedis } from '@drobek/core';
import { logger, serializeError } from './logger.server.js';
import { maskEmail } from './mask-email.js';
import { rateLimitRedis } from './rate-limit.server.js';

// ---- Fixed windows (limits are env-tunable, windows are not) ----
const IP_SHORT_WINDOW_MS = 15 * 60_000;
const IP_DAILY_WINDOW_MS = 24 * 60 * 60_000;
const EMAIL_HOURLY_WINDOW_MS = 60 * 60_000;
const GLOBAL_WINDOW_MS = 60 * 60_000;
const GLOBAL_AUTOPAUSE_MS = 15 * 60_000;

const KILLSWITCH_KEY = 'drobek:otp:killswitch'; // manual off (operator via redis-cli, no TTL)
const AUTOPAUSE_KEY = 'drobek:otp:autopause'; // automatic pause after the global brake trips (TTL)

// ---- Generic (anti-enumeration) messages — never reveal account existence ----
const MSG_PAUSED =
  'Email sign-in is temporarily unavailable. Please try again in a little while.';
const MSG_IP = 'Too many attempts from this network. Please try again later.';
const MSG_BUSY = 'Sign-in is temporarily unavailable. Please try again shortly.';

/** Tunable limits — env-driven in production, injectable in unit tests. */
export interface OtpGuardLimits {
  ipShortLimit: number;
  ipDailyLimit: number;
  emailHourlyLimit: number;
  emailCooldownMs: number;
  globalHourlyMax: number;
}

function envInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** puls defaults: 5 / 15 min, 20 / 24 h, 3 / 1 h, 60 s, 100 / h. */
export function otpGuardLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): OtpGuardLimits {
  return {
    ipShortLimit: envInt(env, 'OTP_IP_SHORT_LIMIT', 5),
    ipDailyLimit: envInt(env, 'OTP_IP_DAILY_LIMIT', 20),
    emailHourlyLimit: envInt(env, 'OTP_EMAIL_HOURLY_LIMIT', 3),
    emailCooldownMs: envInt(env, 'OTP_EMAIL_COOLDOWN_MS', 60_000),
    globalHourlyMax: envInt(env, 'OTP_GLOBAL_HOURLY_MAX', 100),
  };
}

export type OtpGuardDecision =
  | { ok: true }
  /** Show the user an error with the given HTTP status (429/503). */
  | { ok: false; kind: 'error'; status: number; reason: string; message: string }
  /** Pretend success and redirect to /login/verify — but send NOTHING new. */
  | { ok: false; kind: 'redirect_verify'; reason: string };

function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function cooldownKey(emailHash: string): string {
  return `drobek:otp:cd:${emailHash}`;
}

function logBlock(
  reason: string,
  ctx: { ip?: string; email: string; alert?: boolean }
): void {
  const meta = {
    event: 'otp_send_blocked',
    reason,
    ip: ctx.ip ?? 'unknown',
    email: maskEmail(ctx.email),
    emailHash: hashEmail(ctx.email).slice(0, 12),
    ...(ctx.alert ? { alert: true } : {}),
  };
  if (ctx.alert) logger.warn(`[otp-guard] ALERT: ${reason}`, meta);
  else logger.info(`[otp-guard] blocked: ${reason}`, meta);
}

/** Log a successful code send (the login route calls this after the e-mail). */
export function logOtpSent(ctx: { ip?: string; email: string }): void {
  logger.info('[otp-guard] sent', {
    event: 'otp_send_ok',
    ip: ctx.ip ?? 'unknown',
    email: maskEmail(ctx.email),
    emailHash: hashEmail(ctx.email).slice(0, 12),
  });
}

/** Is OTP sending paused? (env kill switch | manual Redis flag | auto-pause) */
export async function isOtpSendingPaused(): Promise<
  { paused: true; reason: string } | { paused: false }
> {
  if (String(process.env.OTP_LOGIN_DISABLED ?? '') === '1') {
    return { paused: true, reason: 'env_kill_switch' };
  }
  const r = getRedis();
  const [manual, auto] = await Promise.all([
    r.exists(KILLSWITCH_KEY),
    r.exists(AUTOPAUSE_KEY),
  ]);
  if (manual) return { paused: true, reason: 'manual_kill_switch' };
  if (auto) return { paused: true, reason: 'global_autopause' };
  return { paused: false };
}

/**
 * Release the per-e-mail cooldown (call when the e-mail send FAILED — so the
 * user can retry immediately instead of being held by the cooldown).
 */
export async function releaseOtpCooldown(email: string): Promise<void> {
  try {
    await getRedis().del(cooldownKey(hashEmail(email)));
  } catch {
    /* best-effort */
  }
}

/** Run all protection layers. Limits injectable for unit tests. */
export async function guardOtpRequest(args: {
  ip: string | undefined;
  email: string;
  limits?: OtpGuardLimits;
}): Promise<OtpGuardDecision> {
  const { ip, email } = args;
  const limits = args.limits ?? otpGuardLimitsFromEnv();
  const ipKey = ip ?? 'unknown';
  const emailHash = hashEmail(email);

  try {
    // 0. Kill switch / auto-pause
    const paused = await isOtpSendingPaused();
    if (paused.paused) {
      logBlock(paused.reason, {
        ip,
        email,
        alert: paused.reason === 'global_autopause',
      });
      return {
        ok: false,
        kind: 'error',
        status: 503,
        reason: paused.reason,
        message: MSG_PAUSED,
      };
    }

    // 1. per-IP short window
    const ipShort = await rateLimitRedis(
      'otp-ip-15m',
      ipKey,
      limits.ipShortLimit,
      IP_SHORT_WINDOW_MS
    );
    if (!ipShort.ok) {
      logBlock('ip_short', { ip, email, alert: true });
      return {
        ok: false,
        kind: 'error',
        status: 429,
        reason: 'ip_short',
        message: MSG_IP,
      };
    }

    // 2. per-IP daily window
    const ipDaily = await rateLimitRedis(
      'otp-ip-24h',
      ipKey,
      limits.ipDailyLimit,
      IP_DAILY_WINDOW_MS
    );
    if (!ipDaily.ok) {
      logBlock('ip_daily', { ip, email, alert: true });
      return {
        ok: false,
        kind: 'error',
        status: 429,
        reason: 'ip_daily',
        message: MSG_IP,
      };
    }

    // ── CAPTCHA seam ─────────────────────────────────────────────────────────
    // U2 ships without a CAPTCHA vendor. When one lands (e.g. Turnstile), it
    // slots in HERE: after the cheap IP gates, before any per-e-mail work —
    // see puls otp-guard.server.ts step 3 for the reference shape.
    // ─────────────────────────────────────────────────────────────────────────

    // 3. per-e-mail cooldown — atomic SET NX PX. First of the e-mail checks so
    //    a double-click never burns the hourly budget.
    const r = getRedis();
    const acquired = await r.set(
      cooldownKey(emailHash),
      '1',
      'PX',
      limits.emailCooldownMs,
      'NX'
    );
    if (acquired === null) {
      // A code was just sent → send nothing new, redirect to verify (generic).
      logBlock('cooldown', { ip, email });
      return { ok: false, kind: 'redirect_verify', reason: 'cooldown' };
    }

    // 4. per-e-mail hourly limit
    const emailHourly = await rateLimitRedis(
      'otp-email-1h',
      emailHash,
      limits.emailHourlyLimit,
      EMAIL_HOURLY_WINDOW_MS
    );
    if (!emailHourly.ok) {
      logBlock('email_hourly', { ip, email });
      return { ok: false, kind: 'redirect_verify', reason: 'email_hourly' };
    }

    // 5. Global brake (N / h across the whole app)
    const globalRl = await rateLimitRedis(
      'otp-global-1h',
      'all',
      limits.globalHourlyMax,
      GLOBAL_WINDOW_MS
    );
    if (!globalRl.ok) {
      // Auto-pause: temporarily stop ALL sends — protect the mailbox before
      // the provider does it for us.
      await r.set(AUTOPAUSE_KEY, '1', 'PX', GLOBAL_AUTOPAUSE_MS);
      logger.warn(
        '[otp-guard] ALERT: global hourly OTP cap exceeded — auto-pausing sends',
        {
          event: 'otp_global_brake',
          max: limits.globalHourlyMax,
          autopauseMs: GLOBAL_AUTOPAUSE_MS,
          alert: true,
        }
      );
      logBlock('global_brake', { ip, email, alert: true });
      return {
        ok: false,
        kind: 'error',
        status: 503,
        reason: 'global_brake',
        message: MSG_PAUSED,
      };
    }

    return { ok: true };
  } catch (err) {
    // FAIL-CLOSED: if we cannot enforce the limits (typically a Redis outage)
    // we do NOT send e-mails — protect the mailbox.
    logger.error('[otp-guard] guard error — fail-closed', {
      err: serializeError(err),
      email: maskEmail(email),
    });
    return {
      ok: false,
      kind: 'error',
      status: 503,
      reason: 'guard_error',
      message: MSG_BUSY,
    };
  }
}
