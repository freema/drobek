/**
 * GET/POST /login — server half of the route module. Split from
 * the component file so the client bundle never touches server-only deps
 * (redis/db/nodemailer); both apps re-export this next to ./login.tsx.
 * Typed with the generic react-router arg types — the package cannot use the
 * app-generated ./+types/* (RR7 typegen is app-local).
 */
import {
  data,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import {
  createEmailLoginCode,
  getClientIp,
  isValidAuthEmail,
  normalizeAuthEmail,
} from '../email-code.server.js';
import { docPageUrl } from '@drobek/agent-dx';
import { isGoogleLoginEnabled } from '../google-oauth.server.js';
import {
  chargeOtpSent,
  guardOtpRequest,
  logOtpSent,
  releaseOtpCooldown,
} from '../otp-guard.server.js';
import {
  loginReturnCookieHeader,
  safeReturnPath,
} from '../return-to.server.js';
import { getSessionUser } from '../session.server.js';
import { logger, serializeError } from '../logger.server.js';
import { maskEmail } from '../mask-email.js';

// ONE generic message for every Google-login failure mode — the real
// reason is logged server-side only (no detail leak to the browser).
const GENERIC_GOOGLE_ERROR =
  'Google sign-in did not complete. Please try again, or sign in with an email code below.';

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  // A same-origin ?returnTo= (e.g. the OAuth /oauth/authorize URL) is
  // stashed in a cookie so the email-code + Google round-trips land back there
  // instead of on /me. Only same-origin relative paths survive validation.
  const returnTo = safeReturnPath(url.searchParams.get('returnTo'));

  const user = await getSessionUser(request);
  if (user) throw redirect(returnTo ?? '/me');

  const body = {
    googleEnabled: isGoogleLoginEnabled(),
    docsUrl: docPageUrl('overview'),
    googleError:
      url.searchParams.get('error') === 'google' ? GENERIC_GOOGLE_ERROR : null,
    // The redirect after /me/delete.
    accountDeleted: url.searchParams.get('deleted') === 'account',
  };
  if (returnTo) {
    return data(body, {
      headers: { 'Set-Cookie': loginReturnCookieHeader(returnTo) },
    });
  }
  return body;
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const raw = String(form.get('email') ?? '');
  const email = normalizeAuthEmail(raw);

  // Server-side sanity check; the input itself is type=email.
  if (!isValidAuthEmail(email)) {
    return data(
      { error: 'Enter a valid email address.' },
      { status: 400 }
    );
  }

  const ip = getClientIp(request);

  // Layered protection: kill switch → per-IP → per-email → global brake.
  // The per-IP windows count this attempt; the address's hourly share and
  // the global brake count only a code that went out (chargeOtpSent below).
  const decision = await guardOtpRequest({ ip, email });
  if (!decision.ok) {
    // Generic redirect to verify (anti-enumeration / dedup) — nothing new sent.
    if (decision.kind === 'redirect_verify') {
      throw redirect(`/login/verify?${new URLSearchParams({ email })}`);
    }
    return data({ error: decision.message }, { status: decision.status });
  }

  const code = await createEmailLoginCode(email, ip);

  try {
    const { sendLoginCodeEmail } = await import(
      '../email/send-login-code.server.js'
    );
    await sendLoginCodeEmail({ email, code });
  } catch (err) {
    // Send failed → release the cooldown so the user can retry right away;
    // the address and the brake were not charged.
    await releaseOtpCooldown(email);
    logger.error('[login] sendLoginCodeEmail failed', {
      err: serializeError(err),
      email: maskEmail(email),
    });
    return data(
      { error: 'We could not send the email. Please try again in a moment.' },
      { status: 502 }
    );
  }

  await chargeOtpSent({ email });
  logOtpSent({ ip, email });
  throw redirect(`/login/verify?${new URLSearchParams({ email })}`);
}
