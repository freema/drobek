import { redirect, type LoaderFunctionArgs } from 'react-router';
import {
  buildGoogleAuthUrl,
  generateOAuthFlow,
  generateOAuthState,
  getGoogleOAuthConfig,
  pkceChallenge,
  saveOAuthFlow,
  stateCookieHeader,
} from '../google-oauth.server.js';
import { logger, serializeError } from '../logger.server.js';

/**
 * GET /auth/google — start the OIDC redirect dance: random CSRF state in
 * a short-lived HttpOnly cookie, the PKCE verifier and nonce in Redis under
 * that state, then 302 to the provider's authorize URL.
 * Config-gated: unconfigured (empty GOOGLE_CLIENT_ID) bounces to /login.
 */
export async function loader(_args: LoaderFunctionArgs) {
  const cfg = getGoogleOAuthConfig();
  if (!cfg) {
    logger.warn('[auth.google] hit while unconfigured — redirecting to /login');
    throw redirect('/login');
  }

  const state = generateOAuthState();
  const flow = generateOAuthFlow();
  try {
    await saveOAuthFlow(state, flow);
  } catch (err) {
    logger.warn('[auth.google] could not store the sign-in', {
      err: serializeError(err),
    });
    throw redirect('/login?error=google');
  }
  const url = buildGoogleAuthUrl({
    authUrl: cfg.authUrl,
    clientId: cfg.clientId,
    redirectUri: cfg.redirectUri,
    state,
    codeChallenge: pkceChallenge(flow.verifier),
    nonce: flow.nonce,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      'Set-Cookie': stateCookieHeader(state),
    },
  });
}
