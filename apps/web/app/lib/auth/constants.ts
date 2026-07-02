export const SESSION_COOKIE = 'drobek_session';
/** Rolling 30-day session TTL (ratified U2 + PHY-70 — sessions live in Redis). */
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30;

/** U3: CSRF state cookie for the Google OIDC redirect dance. */
export const GOOGLE_OAUTH_STATE_COOKIE = 'drobek_google_oauth_state';
/** Short-lived — the consent round-trip must finish within 10 minutes. */
export const GOOGLE_OAUTH_STATE_MAX_AGE_SEC = 10 * 60;
