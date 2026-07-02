/**
 * @drobek/auth — the U2+U3 auth feature (email magic-code + Redis sessions +
 * Google OIDC) as a workspace LIBRARY (PHY-53, ROADMAP §2 locked integration
 * model): heavy logic lives here; apps/web in this repo AND the private
 * drobek-web app register thin route files that re-export the route modules
 * under `@drobek/auth/routes/*` (core APPS are deliberately not workspace
 * members of the SaaS repo, so app-local code cannot be shared — packages can).
 */
export {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  GOOGLE_OAUTH_STATE_COOKIE,
  GOOGLE_OAUTH_STATE_MAX_AGE_SEC,
} from './constants.js';
export {
  CODE_TTL_S,
  CODE_MAX_ATTEMPTS,
  CODE_LENGTH,
  normalizeAuthEmail,
  generateLoginCode,
  createEmailLoginCode,
  consumeEmailLoginCode,
  getClientIp,
} from './email-code.server.js';
export {
  otpGuardLimitsFromEnv,
  guardOtpRequest,
  isOtpSendingPaused,
  releaseOtpCooldown,
  logOtpSent,
  type OtpGuardLimits,
  type OtpGuardDecision,
} from './otp-guard.server.js';
export {
  readSessionToken,
  sessionCookieHeader,
  getSessionUser,
  requireSessionUser,
  createUserSession,
  destroySession,
  type SessionUser,
} from './session.server.js';
export {
  ensureUserByEmail,
  resolveGoogleUser,
  ensureUserFromGoogle,
  type GoogleUserStore,
} from './ensure-user.server.js';
export { isSuperAdmin } from './super-admin.server.js';
export {
  GOOGLE_DEFAULT_AUTH_URL,
  GOOGLE_DEFAULT_TOKEN_URL,
  GOOGLE_DEFAULT_USERINFO_URL,
  getGoogleOAuthConfig,
  isGoogleLoginEnabled,
  generateOAuthState,
  oauthStatesMatch,
  stateCookieHeader,
  readStateCookie,
  buildGoogleAuthUrl,
  exchangeGoogleAuthCode,
  fetchGoogleUserInfo,
  type GoogleOAuthConfig,
  type GoogleIdentity,
} from './google-oauth.server.js';
export { rateLimitRedis } from './rate-limit.server.js';
export { maskEmail } from './mask-email.js';
export { logger, serializeError } from './logger.server.js';
export {
  smtpConfigured,
  getSmtpTransport,
  getEmailFrom,
  resetSmtpTransportForTests,
} from './email/smtp.server.js';
export {
  renderEmailLayout,
  escapeHtml,
  emailBrand,
  type EmailLayoutInput,
} from './email/layout.server.js';
export { sendLoginCodeEmail } from './email/send-login-code.server.js';
export {
  renderLoginCodeEmail,
  type LoginCodeVars,
  type RenderedEmail,
} from './email/templates/login-code.server.js';
export { FakeRedis } from './fake-redis.js';
