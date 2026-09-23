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

// ── Client metadata caps (PHY-76 #7) — DCR bodies and CIMD documents ─────────

/** Longest client_name we store/show on the consent screen. */
export const CLIENT_NAME_MAX_LENGTH = 100;
/** Most redirect_uris one client may register. */
export const REDIRECT_URIS_MAX = 10;
/** Longest single redirect_uri. */
export const REDIRECT_URI_MAX_LENGTH = 2000;

// ── Dynamic Client Registration abuse caps (PHY-76 #7) ───────────────────────

/** Registrations per client IP per window (→ 429). */
export const DCR_RATE_LIMIT = 10;
export const DCR_RATE_WINDOW_MS = 60 * 60 * 1000;
/** Default cap of never-authorized DCR clients (OAUTH_DCR_MAX_UNUSED_CLIENTS). */
export const DCR_MAX_UNUSED_CLIENTS = 500;
/** A DCR client with no grant after this long is pruned on the next registration. */
export const DCR_UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

// ── Client ID Metadata Documents (CIMD) ─────────────────────────────────────

/** Metadata document size cap, enforced while streaming. */
export const CIMD_MAX_BYTES = 64 * 1024;
/** Whole-fetch wall-clock cap (DNS + connect + body). */
export const CIMD_TIMEOUT_MS = 5_000;
/** A validated document is reused for an hour… */
export const CIMD_CACHE_TTL_SEC = 60 * 60;
/** …a rejected one for a minute (bounds refetch amplification, lets fixes land). */
export const CIMD_FAILURE_TTL_SEC = 60;

// ── API keys ────────────────────────────────────────────────────────────────

/** `last_used_at` is refreshed at most this often per key. */
export const API_KEY_LAST_USED_THROTTLE_MS = 60 * 1000;
