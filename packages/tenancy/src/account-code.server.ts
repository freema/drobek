/**
 * The fresh e-mail code that confirms an account deletion. Its own OTP scope
 * (`account-delete`), so a sign-in code never deletes an account and a
 * deletion code never signs anyone in; the scope also has its own send
 * counters, cooldown and auto-pause (the operator-wide switches still apply).
 * Checking a code shares the dashboard's per-IP verify limit, and each code
 * takes CODE_MAX_ATTEMPTS guesses.
 */
import {
  chargeOtpSent,
  consumeEmailLoginCode,
  createEmailLoginCode,
  guardOtpRequest,
  guardOtpVerify,
  logOtpSent,
  logger,
  maskEmail,
  releaseOtpCooldown,
  serializeError,
} from '@drobek/auth';
import { sendAccountDeleteCodeEmail } from './email/account-delete-code.server.js';

export const ACCOUNT_DELETE_OTP_SCOPE = 'account-delete';

export type AccountDeleteCodeResult =
  /** `sent: false` — a code went out moments ago (or the hourly limit is reached): the user uses that one. */
  | { ok: true; sent: boolean }
  | { ok: false; status: number; message: string };

/** Send a deletion code to the signed-in user's own address, within the OTP send limits. */
export async function sendAccountDeleteCode(input: { email: string; ip: string | undefined }): Promise<AccountDeleteCodeResult> {
  const scope = ACCOUNT_DELETE_OTP_SCOPE;
  const decision = await guardOtpRequest({ ip: input.ip, email: input.email, scope });
  if (!decision.ok) {
    if (decision.kind === 'redirect_verify') return { ok: true, sent: false };
    return {
      ok: false,
      status: decision.status,
      message:
        decision.status === 429
          ? 'Too many codes were asked for from this network. Try again later.'
          : 'E-mail codes are paused on this server for a little while. Try again later.',
    };
  }
  const code = await createEmailLoginCode(input.email, input.ip, scope);
  try {
    await sendAccountDeleteCodeEmail({ email: input.email, code });
  } catch (err) {
    await releaseOtpCooldown(input.email, scope);
    logger.error('[account] sending the deletion code failed', { err: serializeError(err), email: maskEmail(input.email) });
    return { ok: false, status: 502, message: 'The e-mail with the code could not be sent. Try again in a moment.' };
  }
  await chargeOtpSent({ email: input.email, scope });
  logOtpSent({ ip: input.ip, email: input.email, scope });
  return { ok: true, sent: true };
}

/** True when `code` is the live deletion code of this address (single use). */
export async function checkAccountDeleteCode(input: { email: string; code: string; ip: string | undefined }): Promise<boolean> {
  const code = input.code.trim();
  if (!/^\d{6}$/.test(code)) return false;
  if (!(await guardOtpVerify({ ip: input.ip })).ok) return false;
  return (await consumeEmailLoginCode(input.email, code, ACCOUNT_DELETE_OTP_SCOPE)).ok;
}
