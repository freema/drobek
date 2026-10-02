/**
 * Changing the address an account signs in with (Account page, dashboard
 * only — no MCP tool).
 *
 * `requestEmailChange` e-mails a code to the NEW address. The send runs
 * through the sign-in code's guard with the same limits (`OTP_*`), counted
 * under their own scope `email-change` (per client IP, per new address, the
 * hourly brake with its own auto-pause; the operator-wide switches still
 * apply). The code itself lives under `email-change:<user id>`, keyed by the
 * new address: it changes only this account, only to that address, and
 * neither a sign-in nor a deletion code ever does. When another account
 * already signs in with the new address, that address gets an "already has an
 * account" e-mail instead of a code and the answer is the same as for a sent
 * code, so the page never tells whether an address has an account.
 *
 * `confirmEmailChange` checks the code (the dashboard's per-IP verify limit,
 * CODE_MAX_ATTEMPTS guesses per code), changes `users.email` under the row
 * lock and audits `account.email_change` in the personal workspace in the
 * same transaction, ends every dashboard session of the user, starts a new
 * one for this browser and e-mails a notice to the previous address. API
 * keys, OAuth connections, memberships and a linked Google sign-in stay: they
 * hang on the user id. What follows the ADDRESS follows the new one at once:
 * SUPERADMIN_EMAIL and a workspace editor's admin role on the apps' sign-in.
 */
import { eq } from 'drizzle-orm';
import { operatorContact } from '@drobek/apps';
import { AUDIT_ACTIONS, AUDIT_SUBJECT_TYPES, writeAudit } from '@drobek/audit';
import {
  consumeEmailLoginCode,
  createEmailLoginCode,
  createUserSession,
  destroyUserSessions,
  guardOtpRequest,
  guardOtpVerify,
  isSuperAdmin,
  isValidAuthEmail,
  logOtpSent,
  logger,
  maskEmail,
  normalizeAuthEmail,
  releaseOtpCooldown,
  serializeError,
} from '@drobek/auth';
import { dbErrorForLog, getDb, isUniqueViolation, users } from '@drobek/db';
import { sendEmailChangeCodeEmail, sendEmailChangedEmail, sendEmailInUseEmail } from './email/email-change.server.js';
import { ensurePersonalWorkspace } from './personal-workspace.server.js';

export const EMAIL_CHANGE_OTP_SCOPE = 'email-change';

/** Where the codes of one user's change live (`drobek:otp:email-change:<user id>:…`). */
export function emailChangeCodeScope(userId: string): string {
  return `${EMAIL_CHANGE_OTP_SCOPE}:${userId}`;
}

export type EmailChangeRequestResult =
  /** `sent: false` — a code went out moments ago (or the hourly limit is reached): the newest one counts. */
  | { ok: true; email: string; sent: boolean }
  | { ok: false; status: number; message: string };

export type EmailChangeConfirmResult =
  | { ok: true; email: string; previousEmail: string; sessionsEnded: number; setCookie: string }
  | { ok: false; status: number; message: string };

const INVALID_ADDRESS = 'Enter a valid e-mail address.';
const BAD_CODE = 'That code is not valid. Check the newest e-mail and try again, or ask for a new code.';
const GONE = 'This account no longer exists.';

/**
 * Send the code that confirms `newEmail` as the user's sign-in address (see
 * the file header). `currentEmail` is the address the user signs in with now.
 */
export async function requestEmailChange(input: {
  userId: string;
  currentEmail: string;
  newEmail: string;
  ip: string | undefined;
}): Promise<EmailChangeRequestResult> {
  const email = normalizeAuthEmail(input.newEmail);
  if (!isValidAuthEmail(email)) return { ok: false, status: 400, message: INVALID_ADDRESS };
  if (email === normalizeAuthEmail(input.currentEmail)) {
    return { ok: false, status: 400, message: 'You already sign in with this address. Enter the new one.' };
  }

  const scope = EMAIL_CHANGE_OTP_SCOPE;
  const decision = await guardOtpRequest({ ip: input.ip, email, scope });
  if (!decision.ok) {
    if (decision.kind === 'redirect_verify') return { ok: true, email, sent: false };
    return {
      ok: false,
      status: decision.status,
      message:
        decision.status === 429
          ? 'Too many codes were asked for from this network. Try again later.'
          : 'E-mail codes are paused on this server for a little while. Try again later.',
    };
  }

  try {
    const [taken] = await getDb().select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (taken && taken.id !== input.userId) {
      await sendEmailInUseEmail({ email });
    } else {
      const code = await createEmailLoginCode(email, input.ip, emailChangeCodeScope(input.userId));
      await sendEmailChangeCodeEmail({ email, code });
    }
  } catch (err) {
    await releaseOtpCooldown(email, scope);
    logger.error('[account] sending the sign-in e-mail change code failed', {
      err: serializeError(err),
      email: maskEmail(email),
    });
    return { ok: false, status: 502, message: 'The e-mail with the code could not be sent. Try again in a moment.' };
  }
  logOtpSent({ ip: input.ip, email, scope });
  return { ok: true, email, sent: true };
}

/**
 * Make `newEmail` the user's sign-in address when `code` is the live code
 * sent to it for this user (single use). On success every dashboard session
 * of the user has ended and `setCookie` signs this browser in again.
 */
export async function confirmEmailChange(input: {
  userId: string;
  newEmail: string;
  code: string;
  ip: string | undefined;
}): Promise<EmailChangeConfirmResult> {
  const email = normalizeAuthEmail(input.newEmail);
  const code = input.code.trim();
  if (!isValidAuthEmail(email) || !/^\d{6}$/.test(code)) return { ok: false, status: 400, message: BAD_CODE };
  if (!(await guardOtpVerify({ ip: input.ip })).ok) return { ok: false, status: 429, message: BAD_CODE };
  if (!(await consumeEmailLoginCode(email, code, emailChangeCodeScope(input.userId))).ok) {
    return { ok: false, status: 400, message: BAD_CODE };
  }

  const db = getDb();
  const [current] = await db.select({ email: users.email }).from(users).where(eq(users.id, input.userId)).limit(1);
  if (!current) return { ok: false, status: 404, message: GONE };
  const personal = await ensurePersonalWorkspace(input.userId, current.email);

  let previousEmail: string | null;
  try {
    previousEmail = await db.transaction(async (tx) => {
      const [row] = await tx.select({ email: users.email }).from(users).where(eq(users.id, input.userId)).for('update');
      if (!row) return null;
      await tx.update(users).set({ email }).where(eq(users.id, input.userId));
      const before = isSuperAdmin(row.email);
      const after = isSuperAdmin(email);
      await writeAudit(
        {
          workspaceId: personal.id,
          actorUserId: input.userId,
          actorKind: 'user',
          action: AUDIT_ACTIONS.accountEmailChange,
          subjectType: AUDIT_SUBJECT_TYPES.account,
          target: input.userId,
          meta: before === after ? null : { super_admin: after ? 'gained' : 'lost' },
        },
        tx
      );
      return row.email;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // The code proved the mailbox, so its owner may learn that another account took the address meanwhile.
      return { ok: false, status: 409, message: 'Another drobek account signs in with this address now. Nothing changed.' };
    }
    logger.error('[account] changing the sign-in e-mail failed', { err: dbErrorForLog(err) });
    throw err;
  }
  if (previousEmail === null) return { ok: false, status: 404, message: GONE };

  const sessionsEnded = await destroyUserSessions(input.userId);
  const { setCookie } = await createUserSession(input.userId, email);
  logger.info('[account] sign-in e-mail changed', {
    from: maskEmail(previousEmail),
    to: maskEmail(email),
    sessionsEnded,
  });

  const contact = operatorContact();
  try {
    await sendEmailChangedEmail({ email: previousEmail, newEmail: email, contact: contact === previousEmail ? null : contact });
  } catch (err) {
    logger.error('[account] the sign-in e-mail change notice could not be sent', {
      err: serializeError(err),
      email: maskEmail(previousEmail),
    });
  }
  return { ok: true, email, previousEmail, sessionsEnded, setCookie };
}
