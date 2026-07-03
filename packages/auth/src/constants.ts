export const SESSION_COOKIE = 'drobek_session';
/** Rolling 30-day session TTL (ratified U2 + PHY-70 — sessions live in Redis). */
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30;

/** U3: CSRF state cookie for the Google OIDC redirect dance. */
export const GOOGLE_OAUTH_STATE_COOKIE = 'drobek_google_oauth_state';
/** Short-lived — the consent round-trip must finish within 10 minutes. */
export const GOOGLE_OAUTH_STATE_MAX_AGE_SEC = 10 * 60;

/**
 * U5 (PHY-71): a same-origin post-login return target. The /login loader drops
 * this cookie from the `?returnTo=` query so the OAuth authorize flow (or any
 * caller) survives the email-code / Google round-trip and lands back where it
 * started instead of on /me.
 */
export const LOGIN_RETURN_COOKIE = 'drobek_login_return';
/** Long enough to enter a code / finish Google, short enough to be transient. */
export const LOGIN_RETURN_MAX_AGE_SEC = 10 * 60;
