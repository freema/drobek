/**
 * Access + refresh token issue, refresh ROTATION with reuse detection, and
 * token validation (U5, R6 security sleeper). Opaque tokens, SHA-256 at rest.
 *
 * Rotation contract: every refresh use mints a NEW access+refresh pair and
 * marks the presented refresh used (rotated_to = successor). Presenting an
 * already-used refresh is REUSE — the whole rotated_to lineage is invalidated
 * and the grant's access tokens revoked. Access validation honors expiry,
 * revocation, and (RFC 8707) an expected audience.
 */
import { ACCESS_TTL_MS, ACCESS_TTL_SEC, REFRESH_TTL_MS } from './constants.js';
import { generateOpaqueToken, hashToken } from './crypto.server.js';
import {
  defaultOAuthStore,
  type GrantKey,
  type OAuthRole,
  type OAuthStore,
  type RefreshTokenRow,
} from './store.server.js';

export interface GrantInput {
  userId: string;
  workspaceId: string;
  role: OAuthRole;
  oauthClientId: string | null;
  scope: string;
  audience: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  scope: string;
}

/** Issue a fresh access+refresh pair for a grant (used on the code exchange). */
export async function issueAccessAndRefresh(
  grant: GrantInput,
  store: OAuthStore = defaultOAuthStore(),
  now: number = Date.now()
): Promise<IssuedTokens> {
  const accessToken = generateOpaqueToken(32);
  const refreshToken = generateOpaqueToken(32);

  await store.insertAccessToken({
    tokenHash: hashToken(accessToken),
    ...grant,
    expiresAt: new Date(now + ACCESS_TTL_MS),
  });
  await store.insertRefreshToken({
    tokenHash: hashToken(refreshToken),
    ...grant,
    expiresAt: new Date(now + REFRESH_TTL_MS),
  });

  return { accessToken, refreshToken, expiresInSec: ACCESS_TTL_SEC, scope: grant.scope };
}

export type RotateResult =
  | (IssuedTokens & { ok: true })
  | { ok: false; error: 'invalid_grant'; reuse: boolean; description: string };

/** Rotate a refresh token; detects + punishes reuse per the schema contract. */
export async function rotateRefreshToken(
  rawRefresh: string,
  store: OAuthStore = defaultOAuthStore(),
  now: number = Date.now()
): Promise<RotateResult> {
  const row = await store.findRefreshTokenByHash(hashToken(rawRefresh));
  if (!row) {
    return { ok: false, error: 'invalid_grant', reuse: false, description: 'unknown refresh token' };
  }
  if (row.expiresAt.getTime() <= now) {
    return { ok: false, error: 'invalid_grant', reuse: false, description: 'refresh token expired' };
  }
  if (row.usedAt !== null) {
    // Reuse of an already-rotated token → burn the whole lineage.
    await revokeLineage(row, store);
    return {
      ok: false,
      error: 'invalid_grant',
      reuse: true,
      description: 'refresh token reuse detected',
    };
  }

  // Atomically claim the rotation BEFORE minting anything — mirrors the
  // single-use auth-code flip. Two concurrent refreshes with the same token
  // both pass the usedAt check above, but only one wins the claim; the loser
  // is treated as reuse (burn the lineage) so no double-spend occurs.
  const claimed = await store.claimRefreshForRotation(row.id);
  if (!claimed) {
    await revokeLineage(row, store);
    return {
      ok: false,
      error: 'invalid_grant',
      reuse: true,
      description: 'refresh token reuse detected',
    };
  }

  const grant: GrantInput = {
    userId: row.userId,
    workspaceId: row.workspaceId,
    role: row.role,
    oauthClientId: row.oauthClientId,
    scope: row.scope,
    audience: row.audience,
  };

  const accessToken = generateOpaqueToken(32);
  const refreshToken = generateOpaqueToken(32);

  await store.insertAccessToken({
    tokenHash: hashToken(accessToken),
    ...grant,
    expiresAt: new Date(now + ACCESS_TTL_MS),
  });
  const newRefreshId = await store.insertRefreshToken({
    tokenHash: hashToken(refreshToken),
    ...grant,
    expiresAt: new Date(now + REFRESH_TTL_MS),
  });
  await store.linkRefreshRotatedTo(row.id, newRefreshId);

  return {
    ok: true,
    accessToken,
    refreshToken,
    expiresInSec: ACCESS_TTL_SEC,
    scope: grant.scope,
  };
}

/**
 * Invalidate an entire rotation lineage: every refresh token reachable via
 * rotated_to (marked used so none can rotate again) plus every live access
 * token for the grant identity.
 */
export async function revokeLineage(
  start: RefreshTokenRow,
  store: OAuthStore = defaultOAuthStore()
): Promise<void> {
  const seen = new Set<string>();
  let cursor: RefreshTokenRow | null = start;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    await store.markRefreshUsed(cursor.id);
    cursor = cursor.rotatedTo
      ? await store.findRefreshTokenById(cursor.rotatedTo)
      : null;
  }

  const key: GrantKey = {
    userId: start.userId,
    workspaceId: start.workspaceId,
    oauthClientId: start.oauthClientId,
    audience: start.audience,
  };
  await store.revokeAccessTokensForGrant(key);
}

export interface AccessTokenClaims {
  userId: string;
  workspaceId: string;
  role: OAuthRole;
  scope: string;
  audience: string;
  oauthClientId: string | null;
}

export interface ValidateOptions {
  /** RFC 8707: when set, the token's audience MUST equal this exactly. */
  audience?: string;
  now?: number;
}

/** Resolve a bearer access token to its claims, or null if unusable. */
export async function validateAccessToken(
  rawToken: string,
  opts: ValidateOptions = {},
  store: OAuthStore = defaultOAuthStore()
): Promise<AccessTokenClaims | null> {
  const now = opts.now ?? Date.now();
  const row = await store.findAccessTokenByHash(hashToken(rawToken));
  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt.getTime() <= now) return null;
  if (opts.audience !== undefined && row.audience !== opts.audience) return null;
  return {
    userId: row.userId,
    workspaceId: row.workspaceId,
    role: row.role,
    scope: row.scope,
    audience: row.audience,
    oauthClientId: row.oauthClientId,
  };
}
