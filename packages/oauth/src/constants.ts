/**
 * OAuth 2.1 lifetimes (U5, PHY-71/PHY-53). Kept small and explicit so the
 * Authorization Server and the mcp Resource Server agree without a shared DB
 * read. All are ratified in ROADMAP §5 / TECHNICAL_DESIGN §4.
 */

/** Authorization code: single-use, short (5 minutes). */
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

/** Access token: 1 hour. */
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const ACCESS_TTL_SEC = Math.floor(ACCESS_TTL_MS / 1000);

/** Refresh token: 30 days (rotated on every use). */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
