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
  normalizeAuthEmail,
} from '../email-code.server.js';
import { ensureUserByEmail } from '../ensure-user.server.js';
import {
  clearLoginReturnCookieHeader,
  readLoginReturnCookie,
} from '../return-to.server.js';
import { createUserSession } from '../session.server.js';
import { maskEmail } from '../mask-email.js';

// One generic, remaining-attempts-agnostic message for EVERY failure mode
// (wrong code / expired / invalidated) — no enumeration, no attempt counting.
const GENERIC_CODE_ERROR =
  'That code is not valid. Check it and try again, or request a new one.';

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
