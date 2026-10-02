/**
 * Access + refresh token issue, refresh ROTATION with a retry grace and reuse
 * detection, and token validation. Opaque tokens, SHA-256 at rest.
 *
 * Rotation contract: every refresh mints a NEW access+refresh pair; the
 * presented refresh is marked used and linked to its successor (rotated_to)
 * in one atomic step. Presenting a used refresh again is
 *  - a RETRY when it and every later token along its rotated_to chain were
 *    used less than REFRESH_RETRY_GRACE_MS ago (a client that lost the
 *    response and retries, or sessions sharing one stored token): the
 *    chain's unused tail is rotated and the client gets a fresh pair;
 *  - REUSE otherwise, or when the chain ends in a used token (a revoked
 *    lineage) or runs past REFRESH_RETRY_MAX_HOPS: the lineage from the
 *    presented token on is marked used and the access tokens issued with it
 *    are revoked. Other lineages of the same user and client keep working.
 * Every access token records the refresh row it was issued with. Access
 * validation honors expiry, revocation, and (RFC 8707) an expected audience.
 */
import {
  ACCESS_TTL_MS,
  ACCESS_TTL_SEC,
  REFRESH_RETRY_GRACE_MS,
  REFRESH_RETRY_MAX_HOPS,
  REFRESH_TTL_MS,
} from './constants.js';
import { generateOpaqueToken, hashToken } from './crypto.server.js';
import { credentialsRevoked } from './revocations.js';
import {
  defaultOAuthStore,
  type OAuthStore,
  type RefreshTokenRow,
} from './store.server.js';

export interface GrantInput {
  userId: string;
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

export interface IssueOptions {
  /**
   * Row id for the new refresh token. The code exchange passes the id derived
   * from the consumed code (consumeAuthCode's `refreshTokenId`) so a later
   * replay of that code can revoke this lineage.
   */
  refreshTokenId?: string;
}

/** Issue a fresh access+refresh pair for a grant (used on the code exchange). */
export async function issueAccessAndRefresh(
  grant: GrantInput,
  store: OAuthStore = defaultOAuthStore(),
  now: number = Date.now(),
  opts: IssueOptions = {}
): Promise<IssuedTokens> {
  const accessToken = generateOpaqueToken(32);
  const refreshToken = generateOpaqueToken(32);

  const refreshTokenId = await store.insertRefreshToken({
    ...(opts.refreshTokenId !== undefined ? { id: opts.refreshTokenId } : {}),
    tokenHash: hashToken(refreshToken),
    ...grant,
    expiresAt: new Date(now + REFRESH_TTL_MS),
  });
  await store.insertAccessToken({
    tokenHash: hashToken(accessToken),
    ...grant,
    refreshTokenId,
    expiresAt: new Date(now + ACCESS_TTL_MS),
  });

  return { accessToken, refreshToken, expiresInSec: ACCESS_TTL_SEC, scope: grant.scope };
}

export type RefreshOutcome =
  | 'rotated'
  | 'retried'
  | 'unknown'
  | 'expired'
  | 'client_mismatch'
  | 'reuse';

/** What a refresh did, for the token endpoint's log line: row ids only, never a token. */
export interface RefreshTrace {
  outcome: RefreshOutcome;
  /** The presented refresh token's row; absent when the token is unknown. */
  refreshTokenId?: string;
  userId?: string;
  /** oauth_clients.id the lineage belongs to. */
  oauthClientId?: string | null;
  /** The refresh token row issued to the client (rotated, retried). */
  successorId?: string;
  /** rotated_to links followed from the presented token (retried, reuse). */
  hops?: number;
}

export type RotateResult =
  | (IssuedTokens & { ok: true; trace: RefreshTrace })
  | {
      ok: false;
      error: 'invalid_grant';
      reuse: boolean;
      description: string;
      trace: RefreshTrace;
    };

export interface RotateOptions {
  /**
   * The internal oauth_clients.id of the client presenting the refresh token,
   * when it identified itself (client_id). A refresh token is bound to the
   * public client it was issued to; another client gets invalid_grant (without
   * burning the victim's lineage).
   */
  expectedOauthClientId?: string | null;
}

/** Rotate a refresh token; a retry within the grace gets a pair, reuse burns the lineage. */
export async function rotateRefreshToken(
  rawRefresh: string,
  store: OAuthStore = defaultOAuthStore(),
  now: number = Date.now(),
  opts: RotateOptions = {}
): Promise<RotateResult> {
  const row = await store.findRefreshTokenByHash(hashToken(rawRefresh));
  if (!row) {
    return refused({ outcome: 'unknown' }, false, 'unknown refresh token');
  }
  const ids = { refreshTokenId: row.id, userId: row.userId, oauthClientId: row.oauthClientId };
  if (
    opts.expectedOauthClientId !== undefined &&
    opts.expectedOauthClientId !== row.oauthClientId
  ) {
    return refused({ outcome: 'client_mismatch', ...ids }, false, 'client_id mismatch');
  }
  if (row.expiresAt.getTime() <= now) {
    return refused({ outcome: 'expired', ...ids }, false, 'refresh token expired');
  }

  const { minted, hops } = await rotateTail(row, store, now);
  if (minted) {
    const trace: RefreshTrace =
      hops === 0
        ? { outcome: 'rotated', ...ids, successorId: minted.successorId }
        : { outcome: 'retried', ...ids, successorId: minted.successorId, hops };
    return { ok: true, ...minted.tokens, trace };
  }

  await revokeLineage(row, store);
  return refused({ outcome: 'reuse', ...ids, hops }, true, 'refresh token reuse detected');
}

function refused(trace: RefreshTrace, reuse: boolean, description: string): RotateResult {
  return { ok: false, error: 'invalid_grant', reuse, description, trace };
}

interface Minted {
  tokens: IssuedTokens;
  successorId: string;
}

/**
 * Rotate `start` when it is unused; when it is used, follow rotated_to to the
 * lineage's unused tail and rotate that — as long as every used token on the
 * way was used within the retry grace and the chain stays within
 * REFRESH_RETRY_MAX_HOPS links. `minted: null` means reuse.
 */
async function rotateTail(
  start: RefreshTokenRow,
  store: OAuthStore,
  now: number
): Promise<{ minted: Minted | null; hops: number }> {
  let cursor: RefreshTokenRow | null = start;
  let hops = 0;
  while (cursor) {
    if (cursor.usedAt === null) {
      if (cursor.expiresAt.getTime() <= now) break;
      const minted = await mintFrom(cursor, store, now);
      if (minted) return { minted, hops };
      // A concurrent rotation won the claim; its successor link is written
      // with the claim, so continue from the token as it is now.
      const current = await store.findRefreshTokenById(cursor.id);
      if (!current || current.usedAt === null) break;
      cursor = current;
      continue;
    }
    if (now - cursor.usedAt.getTime() > REFRESH_RETRY_GRACE_MS) break;
    // Used without a successor: the lineage was revoked.
    if (cursor.rotatedTo === null || hops >= REFRESH_RETRY_MAX_HOPS) break;
    hops += 1;
    cursor = await store.findRefreshTokenById(cursor.rotatedTo);
  }
  return { minted: null, hops };
}

/** Claim `from` and issue its successor pair; null when another rotation claimed it first. */
async function mintFrom(
  from: RefreshTokenRow,
  store: OAuthStore,
  now: number
): Promise<Minted | null> {
  const grant: GrantInput = {
    userId: from.userId,
    oauthClientId: from.oauthClientId,
    scope: from.scope,
    audience: from.audience,
  };
  const refreshToken = generateOpaqueToken(32);
  const successorId = await store.rotateRefresh(
    from.id,
    { tokenHash: hashToken(refreshToken), ...grant, expiresAt: new Date(now + REFRESH_TTL_MS) },
    new Date(now)
  );
  if (successorId === null) return null;

  const accessToken = generateOpaqueToken(32);
  await store.insertAccessToken({
    tokenHash: hashToken(accessToken),
    ...grant,
    refreshTokenId: successorId,
    expiresAt: new Date(now + ACCESS_TTL_MS),
  });
  return {
    tokens: { accessToken, refreshToken, expiresInSec: ACCESS_TTL_SEC, scope: grant.scope },
    successorId,
  };
}

/**
 * Invalidate a rotation lineage from `start` on: every refresh token reachable
 * via rotated_to is marked used (none can rotate again) and the live access
 * tokens issued with them are revoked, together with the grant's access
 * tokens that record no refresh row, and the MCP sessions those access tokens
 * drove are closed. Other lineages of the same user, client and audience are
 * untouched.
 */
export async function revokeLineage(
  start: RefreshTokenRow,
  store: OAuthStore = defaultOAuthStore()
): Promise<void> {
  const seen = new Set<string>();
  let nextId: string | null = start.id;
  while (nextId !== null && !seen.has(nextId)) {
    seen.add(nextId);
    // Marked first, read after: a rotation still claiming this token has
    // committed its successor link by then, and none can claim it afterwards.
    await store.markRefreshUsed(nextId);
    nextId = (await store.findRefreshTokenById(nextId))?.rotatedTo ?? null;
  }

  await store.revokeAccessTokensForLineage(
    { userId: start.userId, oauthClientId: start.oauthClientId, audience: start.audience },
    [...seen]
  );
  credentialsRevoked(start.userId);
}

/** A validated access token: WHO (user) + WHAT (scope) + for WHICH resource. */
export interface AccessTokenClaims {
  id: string;
  userId: string;
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
    id: row.id,
    userId: row.userId,
    scope: row.scope,
    audience: row.audience,
    oauthClientId: row.oauthClientId,
  };
}
