export const SESSION_COOKIE = 'drobek_session';
/** Rolling 30-day session TTL (ratified U2 + PHY-70 — sessions live in Redis). */
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30;
