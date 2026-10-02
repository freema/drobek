/**
 * The daily prune of spent OAuth rows (the retention job in apps/server).
 * Nothing it deletes can still be used, and reuse detection keeps every row
 * it reads:
 *
 *  - access tokens EXPIRED_GRANT_KEEP_MS (7 days) past their expiry — a
 *    revoked one expires within the access TTL as well;
 *  - refresh tokens EXPIRED_GRANT_KEEP_MS past their expiry. The token
 *    endpoint refuses an expired refresh token before any reuse check, so a
 *    rotated token is kept for as long as it can trip reuse detection. A
 *    rotation's successor expires after its predecessor, so the expired rows
 *    of a lineage are its head; a row an unexpired token still points at
 *    (`rotated_to`) stays all the same;
 *  - authorization codes REFRESH_TTL_MS + EXPIRED_GRANT_KEEP_MS past their
 *    expiry: by then the first refresh token of the lineage the code was
 *    exchanged for is gone too, so a replayed code revokes that lineage for
 *    as long as the lineage can be found.
 */
import { and, eq, gte, lt, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getDb, oauthAccessTokens, oauthAuthorizationCodes, oauthRefreshTokens } from '@drobek/db';
import { EXPIRED_GRANT_KEEP_MS, REFRESH_TTL_MS } from './constants.js';

/** Rows one prune deleted, per table. */
export interface OAuthPruneResult {
  accessTokens: number;
  refreshTokens: number;
  authorizationCodes: number;
}

/** Delete the expired OAuth rows of every user and client (one statement per table). */
export async function pruneExpiredOAuth(opts: { now?: Date } = {}): Promise<OAuthPruneResult> {
  const now = (opts.now ?? new Date()).getTime();
  const tokenCutoff = new Date(now - EXPIRED_GRANT_KEEP_MS);
  const codeCutoff = new Date(now - EXPIRED_GRANT_KEEP_MS - REFRESH_TTL_MS);
  const db = getDb();

  const access = await db
    .delete(oauthAccessTokens)
    .where(lt(oauthAccessTokens.expiresAt, tokenCutoff))
    .returning({ id: oauthAccessTokens.id });

  const predecessor = alias(oauthRefreshTokens, 'predecessor');
  const refresh = await db
    .delete(oauthRefreshTokens)
    .where(
      and(
        lt(oauthRefreshTokens.expiresAt, tokenCutoff),
        notExists(
          db
            .select({ one: sql`1` })
            .from(predecessor)
            .where(and(eq(predecessor.rotatedTo, oauthRefreshTokens.id), gte(predecessor.expiresAt, tokenCutoff)))
        )
      )
    )
    .returning({ id: oauthRefreshTokens.id });

  const codes = await db
    .delete(oauthAuthorizationCodes)
    .where(lt(oauthAuthorizationCodes.expiresAt, codeCutoff))
    .returning({ id: oauthAuthorizationCodes.id });

  return { accessTokens: access.length, refreshTokens: refresh.length, authorizationCodes: codes.length };
}
