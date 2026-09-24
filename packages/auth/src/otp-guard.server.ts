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
 * No resolvable client IP (`ip` undefined — no trusted proxy header) → steps 1
 * and 2 are SKIPPED, never keyed on a shared `unknown` bucket (NSO-309): that
 * bucket coupled every such client and ~5 sends per 15 min locked the whole
 * instance out. Steps 3–5 (per-e-mail + the global brake) still apply, and a
 * client able to hide its IP could equally rotate spoofed headers.
 *
 * On Redis errors the decision is FAIL-CLOSED (better a temporarily
 * unavailable login than thousands of un-throttled e-mails).
 *
 * CHARGE AFTER SEND (NSO-327): `guardOtpRequest` charges the counters as it
 * checks them (the dashboard login). The platform `auth` module sends its
 * codes through the module e-mail path, which can refuse a send (e-mail
 * paused, the app's share used up) AFTER the guard said yes — so it runs
 * `checkOtpRequest` (same layers, counters only READ; the cooldown is still
 * claimed so a double-click sends once) and `chargeOtpRequest` once the code
 * went out. A user who retries while e-mail is paused is not left limited
 * after the pause by attempts that sent nothing. Two concurrent checks may
 * both pass the last free slot of a counter; the module e-mail budgets
 * (per app and per workspace, @drobek/modules mail-guard) bound that.
 *
 * SCOPES (M1-02): `scope` undefined = the dashboard login (the original keys);
 * `eu:<app_id>` = the end users of one app (platform module `auth`). A scoped
 * request has its OWN per-IP, per-e-mail and hourly counters, cooldown and
 * auto-pause (one app's abuse never pauses the dashboard login or another
 * app), and still obeys the operator-wide switches that protect the mailbox:
 * `OTP_LOGIN_DISABLED`, the manual kill switch and the dashboard's global
 * auto-pause.
 */
import { createHash } from 'node:crypto';
import { getRedis, perIpLimitKey } from '@drobek/core';
import { otpKeyPrefix, type OtpScope } from './email-code.server.js';
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

function cooldownKey(emailHash: string, scope?: OtpScope): string {
  return `${otpKeyPrefix(scope)}cd:${emailHash}`;
}

function autopauseKey(scope?: OtpScope): string {
  return scope === undefined ? AUTOPAUSE_KEY : `${otpKeyPrefix(scope)}autopause`;
}

/** Rate-limit bucket of a scope: `otp-ip-15m` / `eu:<app_id>:otp-ip-15m`. */
function bucket(name: string, scope?: OtpScope): string {
  return scope === undefined ? name : `${otpKeyPrefix(scope).slice('drobek:otp:'.length)}${name}`;
}

function logBlock(
  reason: string,
  ctx: { ip?: string; email: string; alert?: boolean; scope?: OtpScope }
): void {
  const meta = {
    event: 'otp_send_blocked',
    reason,
    ...(ctx.scope ? { scope: ctx.scope } : {}),
    ip: ctx.ip ?? 'unknown',
    email: maskEmail(ctx.email),
    emailHash: hashEmail(ctx.email).slice(0, 12),
    ...(ctx.alert ? { alert: true } : {}),
  };
  if (ctx.alert) logger.warn(`[otp-guard] ALERT: ${reason}`, meta);
  else logger.info(`[otp-guard] blocked: ${reason}`, meta);
}

/** Log a successful code send (the login route calls this after the e-mail). */
export function logOtpSent(ctx: { ip?: string; email: string; scope?: OtpScope }): void {
  logger.info('[otp-guard] sent', {
    event: 'otp_send_ok',
    ...(ctx.scope ? { scope: ctx.scope } : {}),
    ip: ctx.ip ?? 'unknown',
    email: maskEmail(ctx.email),
    emailHash: hashEmail(ctx.email).slice(0, 12),
  });
}

/**
 * Is OTP sending paused? (env kill switch | manual Redis flag | auto-pause).
 * A scoped check also honours the scope's own auto-pause (`scope_autopause`).
 */
export async function isOtpSendingPaused(scope?: OtpScope): Promise<
  { paused: true; reason: string } | { paused: false }
> {
  if (String(process.env.OTP_LOGIN_DISABLED ?? '') === '1') {
    return { paused: true, reason: 'env_kill_switch' };
  }
  const r = getRedis();
  const [manual, auto, scoped] = await Promise.all([
    r.exists(KILLSWITCH_KEY),
    r.exists(AUTOPAUSE_KEY),
    scope === undefined ? Promise.resolve(0) : r.exists(autopauseKey(scope)),
  ]);
  if (manual) return { paused: true, reason: 'manual_kill_switch' };
  if (auto) return { paused: true, reason: 'global_autopause' };
  if (scoped) return { paused: true, reason: 'scope_autopause' };
  return { paused: false };
}

/**
 * Release the per-e-mail cooldown (call when the e-mail send FAILED — so the
 * user can retry immediately instead of being held by the cooldown).
 */
export async function releaseOtpCooldown(email: string, scope?: OtpScope): Promise<void> {
  try {
    await getRedis().del(cooldownKey(hashEmail(email), scope));
  } catch {
    /* best-effort */
  }
}

/** Step 0 of both guards: the kill switch / auto-pause as a refusal, or null. */
async function pausedDecision(ip: string | undefined, email: string, scope?: OtpScope): Promise<OtpGuardDecision | null> {
  const paused = await isOtpSendingPaused(scope);
  if (!paused.paused) return null;
  logBlock(paused.reason, {
    ip,
    email,
    scope,
    alert: paused.reason === 'global_autopause' || paused.reason === 'scope_autopause',
  });
  return { ok: false, kind: 'error', status: 503, reason: paused.reason, message: MSG_PAUSED };
}

/** The current value of a fixed-window counter of `rateLimitRedis` (0 when absent). */
async function counterValue(bucketName: string, key: string): Promise<number> {
  return Number((await getRedis().get(`drobek:rl:${bucketName}:${key}`)) ?? 0) || 0;
}

/**
 * Every layer of `guardOtpRequest`, but the per-IP, per-e-mail and per-scope
 * hourly counters are only READ — nothing is charged until
 * `chargeOtpRequest` runs after the code went out. The per-e-mail cooldown
 * IS claimed (release it with `releaseOtpCooldown` when the send fails).
 * FAIL-CLOSED on Redis errors.
 */
export async function checkOtpRequest(args: {
  ip: string | undefined;
  email: string;
  limits?: OtpGuardLimits;
  scope?: OtpScope;
}): Promise<OtpGuardDecision> {
  const { ip, email, scope } = args;
  const limits = args.limits ?? otpGuardLimitsFromEnv();
  const emailHash = hashEmail(email);
  try {
    const paused = await pausedDecision(ip, email, scope);
    if (paused) return paused;

    // 1 + 2. per-IP windows (skipped without a client IP — NSO-309)
    if (ip && (await counterValue(bucket('otp-ip-15m', scope), ip)) >= limits.ipShortLimit) {
      logBlock('ip_short', { ip, email, scope, alert: true });
      return { ok: false, kind: 'error', status: 429, reason: 'ip_short', message: MSG_IP };
    }
    if (ip && (await counterValue(bucket('otp-ip-24h', scope), ip)) >= limits.ipDailyLimit) {
      logBlock('ip_daily', { ip, email, scope, alert: true });
      return { ok: false, kind: 'error', status: 429, reason: 'ip_daily', message: MSG_IP };
    }

    // 3. per-e-mail cooldown — claimed now, so a double-click sends once.
    const acquired = await getRedis().set(cooldownKey(emailHash, scope), '1', 'PX', limits.emailCooldownMs, 'NX');
    if (acquired === null) {
      logBlock('cooldown', { ip, email, scope });
      return { ok: false, kind: 'redirect_verify', reason: 'cooldown' };
    }

    // 4. per-e-mail hourly limit
    if ((await counterValue(bucket('otp-email-1h', scope), emailHash)) >= limits.emailHourlyLimit) {
      logBlock('email_hourly', { ip, email, scope });
      return { ok: false, kind: 'redirect_verify', reason: 'email_hourly' };
    }

    // 5. the scope's hourly brake: full → auto-pause, as in guardOtpRequest.
    if ((await counterValue(bucket('otp-global-1h', scope), 'all')) >= limits.globalHourlyMax) {
      await getRedis().set(autopauseKey(scope), '1', 'PX', GLOBAL_AUTOPAUSE_MS);
      logger.warn('[otp-guard] ALERT: global hourly OTP cap exceeded — auto-pausing sends', {
        event: 'otp_global_brake',
        ...(scope ? { scope } : {}),
        max: limits.globalHourlyMax,
        autopauseMs: GLOBAL_AUTOPAUSE_MS,
        alert: true,
      });
      logBlock('global_brake', { ip, email, scope, alert: true });
      return { ok: false, kind: 'error', status: 503, reason: 'global_brake', message: MSG_PAUSED };
    }
    return { ok: true };
  } catch (err) {
    logger.error('[otp-guard] guard error — fail-closed', {
      ...(scope ? { scope } : {}),
      err: serializeError(err),
      email: maskEmail(email),
    });
    return { ok: false, kind: 'error', status: 503, reason: 'guard_error', message: MSG_BUSY };
  }
}

/**
 * Charge one sent code to the counters `checkOtpRequest` read: the per-IP
 * windows (when the IP is known), the per-e-mail hour and the scope's hour.
 * Call it only after the code went out. Best-effort: the code is already
 * sent, so a Redis error is logged, not thrown.
 */
export async function chargeOtpRequest(args: { ip: string | undefined; email: string; scope?: OtpScope }): Promise<void> {
  const { ip, email, scope } = args;
  const uncapped = Number.MAX_SAFE_INTEGER;
  try {
    if (ip) {
      await rateLimitRedis(bucket('otp-ip-15m', scope), ip, uncapped, IP_SHORT_WINDOW_MS);
      await rateLimitRedis(bucket('otp-ip-24h', scope), ip, uncapped, IP_DAILY_WINDOW_MS);
    }
    await rateLimitRedis(bucket('otp-email-1h', scope), hashEmail(email), uncapped, EMAIL_HOURLY_WINDOW_MS);
    await rateLimitRedis(bucket('otp-global-1h', scope), 'all', uncapped, GLOBAL_WINDOW_MS);
  } catch (err) {
    logger.error('[otp-guard] could not charge a sent code', {
      ...(scope ? { scope } : {}),
      err: serializeError(err),
      email: maskEmail(email),
    });
  }
}

/** Run all protection layers. Limits injectable for unit tests. */
export async function guardOtpRequest(args: {
  ip: string | undefined;
  email: string;
  limits?: OtpGuardLimits;
  /** undefined = the dashboard login; `eu:<app_id>` = one app's end users. */
  scope?: OtpScope;
}): Promise<OtpGuardDecision> {
  const { ip, email, scope } = args;
  const limits = args.limits ?? otpGuardLimitsFromEnv();
  const emailHash = hashEmail(email);

  try {
    // 0. Kill switch / auto-pause
    const paused = await pausedDecision(ip, email, scope);
    if (paused) return paused;

    // 1. per-IP short window (skipped without a client IP — NSO-309/328)
    const ipKey = perIpLimitKey(ip, scope === undefined ? 'otp-ip' : 'eu:otp-ip', logger);
    const ipShort = ipKey
      ? await rateLimitRedis(bucket('otp-ip-15m', scope), ipKey, limits.ipShortLimit, IP_SHORT_WINDOW_MS)
      : { ok: true };
    if (!ipShort.ok) {
      logBlock('ip_short', { ip, email, scope, alert: true });
      return {
        ok: false,
        kind: 'error',
        status: 429,
        reason: 'ip_short',
        message: MSG_IP,
      };
    }

    // 2. per-IP daily window (skipped without a client IP — NSO-309/328)
    const ipDaily = ipKey
      ? await rateLimitRedis(bucket('otp-ip-24h', scope), ipKey, limits.ipDailyLimit, IP_DAILY_WINDOW_MS)
      : { ok: true };
    if (!ipDaily.ok) {
      logBlock('ip_daily', { ip, email, scope, alert: true });
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
      cooldownKey(emailHash, scope),
      '1',
      'PX',
      limits.emailCooldownMs,
      'NX'
    );
    if (acquired === null) {
      // A code was just sent → send nothing new, redirect to verify (generic).
      logBlock('cooldown', { ip, email, scope });
      return { ok: false, kind: 'redirect_verify', reason: 'cooldown' };
    }

    // 4. per-e-mail hourly limit
    const emailHourly = await rateLimitRedis(
      bucket('otp-email-1h', scope),
      emailHash,
      limits.emailHourlyLimit,
      EMAIL_HOURLY_WINDOW_MS
    );
    if (!emailHourly.ok) {
      logBlock('email_hourly', { ip, email, scope });
      return { ok: false, kind: 'redirect_verify', reason: 'email_hourly' };
    }

    // 5. Global brake (N / h across the whole app)
    const globalRl = await rateLimitRedis(
      bucket('otp-global-1h', scope),
      'all',
      limits.globalHourlyMax,
      GLOBAL_WINDOW_MS
    );
    if (!globalRl.ok) {
      // Auto-pause: temporarily stop ALL sends — protect the mailbox before
      // the provider does it for us.
      await r.set(autopauseKey(scope), '1', 'PX', GLOBAL_AUTOPAUSE_MS);
      logger.warn(
        '[otp-guard] ALERT: global hourly OTP cap exceeded — auto-pausing sends',
        {
          event: 'otp_global_brake',
          ...(scope ? { scope } : {}),
          max: limits.globalHourlyMax,
          autopauseMs: GLOBAL_AUTOPAUSE_MS,
          alert: true,
        }
      );
      logBlock('global_brake', { ip, email, scope, alert: true });
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
      ...(scope ? { scope } : {}),
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
