import { redirect, type LoaderFunctionArgs } from 'react-router';
import { ensureUserFromGoogle } from '~/lib/auth/ensure-user.server';
import {
  exchangeGoogleAuthCode,
  fetchGoogleUserInfo,
  getGoogleOAuthConfig,
  oauthStatesMatch,
  readStateCookie,
  stateCookieHeader,
  type GoogleIdentity,
} from '~/lib/auth/google-oauth.server';
import { createUserSession } from '~/lib/auth/session.server';
import { logger, serializeError } from '~/lib/logger.server';
import { maskEmail } from '~/lib/mask-email';

/**
 * GET /auth/google/callback (U3) — finish the OIDC dance:
 * exact-match state param vs cookie (cookie cleared either way), exchange the
 * code, fetch userinfo, REQUIRE email_verified === true, then account
 * resolution (sub match → email link → create) and session via the U2
 * createUserSession. EVERY failure path: no session, generic
 * /login?error=google (real reason logged server-side only, email masked).
 */
export async function loader({ request }: LoaderFunctionArgs) {
  // The one-shot state cookie dies with this response, success or failure.
  const clearState = stateCookieHeader('', { clear: true });

  const fail = (reason: string, meta?: Record<string, unknown>): Response => {
    logger.warn('[auth.google.callback] rejected', { reason, ...meta });
    return redirect('/login?error=google', {
      headers: { 'Set-Cookie': clearState },
    });
  };

  const cfg = getGoogleOAuthConfig();
  if (!cfg) return fail('not_configured');

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  const stateCookie = readStateCookie(request);

  if (!code) return fail('missing_code');
  if (!oauthStatesMatch(stateParam, stateCookie)) {
    return fail('state_mismatch');
  }

  let accessToken: string;
  try {
    ({ accessToken } = await exchangeGoogleAuthCode({
      tokenUrl: cfg.tokenUrl,
      code,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      redirectUri: cfg.redirectUri,
    }));
  } catch (err) {
    return fail('token_exchange_failed', { err: serializeError(err) });
  }

  let identity: GoogleIdentity;
  try {
    identity = await fetchGoogleUserInfo({
      userinfoUrl: cfg.userinfoUrl,
      accessToken,
    });
  } catch (err) {
    return fail('userinfo_failed', { err: serializeError(err) });
  }

  // Unverified email must NEVER create a session or link an account.
  if (!identity.emailVerified) {
    return fail('email_unverified', { email: maskEmail(identity.email) });
  }

  let resolved: { userId: string; email: string };
  try {
    resolved = await ensureUserFromGoogle(identity);
  } catch (err) {
    return fail('account_resolution_failed', {
      err: serializeError(err),
      email: maskEmail(identity.email),
    });
  }

  const { setCookie } = await createUserSession(resolved.userId, resolved.email);

  logger.info('[auth.google.callback] signed in', {
    email: maskEmail(resolved.email),
  });

  const headers = new Headers();
  headers.append('Location', '/me');
  headers.append('Set-Cookie', setCookie);
  headers.append('Set-Cookie', clearState);
  return new Response(null, { status: 302, headers });
}

export default function AuthGoogleCallback() {
  return null;
}
