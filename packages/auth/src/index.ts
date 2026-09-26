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
  LOGIN_RETURN_COOKIE,
  LOGIN_RETURN_MAX_AGE_SEC,
} from './constants.js';
export {
  safeReturnPath,
  loginReturnCookieHeader,
  clearLoginReturnCookieHeader,
  readLoginReturnCookie,
} from './return-to.server.js';
export {
  CODE_TTL_S,
  CODE_MAX_ATTEMPTS,
  CODE_LENGTH,
  normalizeAuthEmail,
  generateLoginCode,
  createEmailLoginCode,
  consumeEmailLoginCode,
  getClientIp,
  trustProxyConfigError,
  trustProxyMode,
  otpKeyPrefix,
  type OtpScope,
  type TrustProxyMode,
} from './email-code.server.js';
export {
  otpGuardLimitsFromEnv,
  guardOtpRequest,
  checkOtpRequest,
  chargeOtpRequest,
  isOtpSendingPaused,
  releaseOtpCooldown,
  logOtpSent,
  type OtpGuardLimits,
  type OtpGuardDecision,
} from './otp-guard.server.js';
export {
  guardOtpVerify,
  otpVerifyLimitsFromEnv,
  OTP_VERIFY_IP_BUCKET,
  type OtpVerifyLimits,
} from './otp-verify-guard.server.js';
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
export { isSuperAdmin, superAdminEmails } from './super-admin.server.js';
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
export { cookieName, hostCookieHeader, readCookieValue, secureCookies } from './cookies.js';
export {
  ORIGIN_CHECK_EXEMPT_PATHS,
  createOriginCheckMiddleware,
  decideOriginCheck,
  type OriginCheckDecision,
  type OriginCheckInput,
} from './origin-check.js';
export { maskEmail } from './mask-email.js';
export { logger, serializeError } from './logger.server.js';
// The transport + layout moved to @drobek/email (M1-04); re-exported so
// existing consumers (tenancy invites, drobek-web) keep working.
export {
  smtpConfigured,
  getSmtpTransport,
  getEmailFrom,
  resetSmtpTransportForTests,
  renderEmailLayout,
  escapeHtml,
  emailBrand,
  mascotDataUri,
  type EmailLayoutInput,
} from '@drobek/email';
export { sendLoginCodeEmail } from './email/send-login-code.server.js';
export {
  renderLoginCodeEmail,
  type LoginCodeVars,
  type RenderedEmail,
} from './email/templates/login-code.server.js';
export { FakeRedis } from './fake-redis.js';
