import { redirect, type LoaderFunctionArgs } from 'react-router';
import {
  buildGoogleAuthUrl,
  generateOAuthState,
  getGoogleOAuthConfig,
  stateCookieHeader,
} from '../google-oauth.server.js';
import { logger } from '../logger.server.js';

/**
 * GET /auth/google (U3) — start the OIDC redirect dance: random CSRF state in
 * a short-lived HttpOnly cookie, then 302 to the provider's authorize URL.
 * Config-gated: unconfigured (empty GOOGLE_CLIENT_ID) bounces to /login.
 */
export async function loader(_args: LoaderFunctionArgs) {
  const cfg = getGoogleOAuthConfig();
  if (!cfg) {
    logger.warn('[auth.google] hit while unconfigured — redirecting to /login');
    throw redirect('/login');
  }

  const state = generateOAuthState();
  const url = buildGoogleAuthUrl({
    authUrl: cfg.authUrl,
    clientId: cfg.clientId,
    redirectUri: cfg.redirectUri,
    state,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      'Set-Cookie': stateCookieHeader(state),
    },
  });
}
