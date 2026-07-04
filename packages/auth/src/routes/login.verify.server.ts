/**
 * GET/POST /login/verify — server half of the route module (U2, PHY-53).
 * Split from the component file so the client bundle never touches
 * server-only deps; both apps re-export this next to ./login.verify.tsx.
 */
import {
  data,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import {
  consumeEmailLoginCode,
  getClientIp,
  normalizeAuthEmail,
} from '../email-code.server.js';
import { ensureUserByEmail } from '../ensure-user.server.js';
import { rateLimitRedis } from '../rate-limit.server.js';
import {
  clearLoginReturnCookieHeader,
  readLoginReturnCookie,
} from '../return-to.server.js';
import { createUserSession } from '../session.server.js';
import { maskEmail } from '../mask-email.js';

// One generic, remaining-attempts-agnostic message for EVERY failure mode
// (wrong code / expired / invalidated / rate-limited) — no enumeration, no
// attempt counting.
const GENERIC_CODE_ERROR =
  'That code is not valid. Check it and try again, or request a new one.';

// Verify-side per-IP rate limit — defense in depth on top of the per-code
// atomic counter in consumeEmailLoginCode. The per-code counter already caps
// guesses against a single code to CODE_MAX_ATTEMPTS (IP-independent, so it
// holds even against botnets / spoofed X-Forwarded-For); this bounds how hard a
// single source can hammer the endpoint for enumeration/load. Generous enough
// never to reach a legitimate user (verifies follow an IP-throttled send).
// NOTE: keyed on getClientIp, which currently trusts the leftmost XFF hop
// (PHY-76 #4) — tighten alongside that fix.
const VERIFY_IP_LIMIT = 30;
const VERIFY_WINDOW_MS = 15 * 60_000;

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const raw = url.searchParams.get('email');
  if (!raw) throw redirect('/login');
  const email = normalizeAuthEmail(raw);
  return { email, masked: maskEmail(email) };
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const email = normalizeAuthEmail(String(form.get('email') ?? ''));
  const code = String(form.get('code') ?? '').trim();

  if (!email || !/^\d{6}$/.test(code)) {
    return data({ error: GENERIC_CODE_ERROR }, { status: 400 });
  }

  const ip = getClientIp(request);
  const ipRl = await rateLimitRedis(
    'otp-verify-ip',
    ip ?? 'unknown',
    VERIFY_IP_LIMIT,
    VERIFY_WINDOW_MS
  );
  if (!ipRl.ok) {
    // Same generic message → no signal that the limit (vs. a bad code) tripped.
    return data({ error: GENERIC_CODE_ERROR }, { status: 429 });
  }

  const consumed = await consumeEmailLoginCode(email, code);
  if (!consumed.ok) {
    return data({ error: GENERIC_CODE_ERROR }, { status: 400 });
  }

  const userId = await ensureUserByEmail(email);
  const { setCookie } = await createUserSession(userId, email);

  // U5: land back on the stashed return target (e.g. /oauth/authorize) if set.
  const returnTo = readLoginReturnCookie(request);
  const headers = new Headers();
  headers.append('Set-Cookie', setCookie);
  if (returnTo) headers.append('Set-Cookie', clearLoginReturnCookieHeader());
  return redirect(returnTo ?? '/me', { headers });
}
