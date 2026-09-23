/**
 * Per-IP rate limit of the dashboard code check (`POST /login/verify`) —
 * defense in depth ON TOP of the per-code attempt cap, never a replacement.
 *
 * What actually stops brute force is the per-challenge cap in
 * `consumeEmailLoginCode` (email-code.server.ts): an atomic INCR counter per
 * e-mail allows at most CODE_MAX_ATTEMPTS (5) guesses against one code, the
 * last wrong guess destroys the code, and new codes are throttled per e-mail by
 * the send guard (otp-guard.server.ts). That cap is IP-independent, so it holds
 * against botnets and spoofed headers alike, it runs on EVERY request (IP or
 * not) and it is not configurable.
 *
 * This bucket only bounds how hard ONE client can hammer the endpoint
 * (enumeration / load). It is keyed on `getClientIp`; when no client IP can be
 * resolved (no trusted proxy header — the plain-HTTP dev stack, a request that
 * bypassed the proxy) the bucket is SKIPPED (NSO-309). The former shared
 * `unknown` bucket coupled every such client: ~30 sign-ins per window locked
 * the whole instance out with "That code is not valid". Skipping it loses
 * nothing — a client able to make its IP unresolvable could equally rotate
 * spoofed headers — and the per-code cap above stays in force.
 *
 * Env (both optional, positive integers):
 *   OTP_VERIFY_IP_LIMIT     code checks per client IP per window (default 30)
 *   OTP_VERIFY_IP_WINDOW_S  window length in seconds (default 900 = 15 min)
 */
import { logger } from './logger.server.js';
import { rateLimitRedis } from './rate-limit.server.js';

export interface OtpVerifyLimits {
  ipLimit: number;
  windowMs: number;
}

export const OTP_VERIFY_IP_BUCKET = 'otp-verify-ip';

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const n = Number(env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Defaults: 30 checks / 15 min per client IP. */
export function otpVerifyLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): OtpVerifyLimits {
  return {
    ipLimit: envInt(env, 'OTP_VERIFY_IP_LIMIT', 30),
    windowMs: envInt(env, 'OTP_VERIFY_IP_WINDOW_S', 15 * 60) * 1000,
  };
}

let warnedNoIp = false;

/**
 * May this code check proceed? `ip` undefined/null → the per-IP bucket is
 * skipped (warned once per process so a misconfigured TRUST_PROXY is visible).
 * A Redis error propagates — the route fails, nothing is verified.
 */
export async function guardOtpVerify(args: {
  ip: string | null | undefined;
  limits?: OtpVerifyLimits;
}): Promise<{ ok: boolean }> {
  if (!args.ip) {
    if (!warnedNoIp) {
      warnedNoIp = true;
      logger.warn(
        '[otp-verify] no client IP resolved — per-IP verify limit skipped (check TRUST_PROXY and the proxy X-Real-IP header)',
        { event: 'otp_verify_no_ip' }
      );
    }
    return { ok: true };
  }
  const limits = args.limits ?? otpVerifyLimitsFromEnv();
  return rateLimitRedis(OTP_VERIFY_IP_BUCKET, args.ip, limits.ipLimit, limits.windowMs);
}
