/**
 * The user's OAuth connections (M2-04, NSO-284): which OAuth clients (DCR or
 * CIMD) currently hold a live grant for a user, and revoking one.
 *
 * A "connection" is a (user, client) pair with at least one LIVE token: an
 * unrevoked, unexpired access token or an unused, unexpired refresh token.
 * Tokens are user-bound (M0-04) and carry their client's internal id, so the
 * whole view is a read over the two token tables — no extra schema.
 *
 * `lastUsedAt` = the newest token issued to the pair (the consent exchange or
 * a refresh rotation). Access tokens are not stamped per MCP call; a client
 * that keeps working refreshes within the access TTL (1 h), so this is an
 * hour-accurate "last active".
 *
 * Revocation DELETES every access token, refresh token and pending
 * authorization code of the pair (only this user's — the client row itself
 * and other users' grants stay). The Resource Server reads the token table on
 * every request, so a revoked client gets 401 on its next call; its old
 * refresh token is then unknown to /oauth/token (`invalid_grant`). Reuse
 * detection is untouched: it still burns a lineage whose rotated token comes
 * back while the grant is live.
 */
import { and, eq, gt, inArray, isNotNull, isNull, max } from 'drizzle-orm';
import {
  getDb,
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthClients,
  oauthRefreshTokens,
} from '@drobek/db';
import type { ClientSource } from './clients.server.js';

export interface OAuthConnection {
  /** oauth_clients.id (internal) — what the revoke form posts. */
  oauthClientId: string;
  /** The public client_id (DCR hex id, or the CIMD document URL). */
  clientId: string;
  /** client_name from the DCR registration or the CIMD document. */
  clientName: string;
  source: ClientSource;
  /** Scope of the newest live token (space-delimited wire form). */
  scope: string;
  /** Newest token issued to this user for the client. */
  lastUsedAt: Date;
  liveAccessTokens: number;
  liveRefreshTokens: number;
}

/** Clients holding a live grant for `userId`, most recently used first. */
export async function listConnections(
  userId: string,
  now: number = Date.now()
): Promise<OAuthConnection[]> {
  const db = getDb();
  const at = new Date(now);

  const [access, refresh] = await Promise.all([
    db
      .select({
        client: oauthAccessTokens.oauthClientId,
        scope: oauthAccessTokens.scope,
        createdAt: oauthAccessTokens.createdAt,
      })
      .from(oauthAccessTokens)
      .where(
        and(
          eq(oauthAccessTokens.userId, userId),
          isNotNull(oauthAccessTokens.oauthClientId),
          isNull(oauthAccessTokens.revokedAt),
          gt(oauthAccessTokens.expiresAt, at)
        )
      ),
    db
      .select({
        client: oauthRefreshTokens.oauthClientId,
        scope: oauthRefreshTokens.scope,
        createdAt: oauthRefreshTokens.createdAt,
      })
      .from(oauthRefreshTokens)
      .where(
        and(
          eq(oauthRefreshTokens.userId, userId),
          isNotNull(oauthRefreshTokens.oauthClientId),
          isNull(oauthRefreshTokens.usedAt),
          gt(oauthRefreshTokens.expiresAt, at)
        )
      ),
  ]);

  interface Acc {
    scope: string;
    newestLive: Date;
    access: number;
    refresh: number;
  }
  const byClient = new Map<string, Acc>();
  const add = (row: { client: string | null; scope: string; createdAt: Date }, kind: 'access' | 'refresh') => {
    if (!row.client) return;
    const acc = byClient.get(row.client) ?? {
      scope: row.scope,
      newestLive: row.createdAt,
      access: 0,
      refresh: 0,
    };
    if (row.createdAt.getTime() > acc.newestLive.getTime()) {
      acc.newestLive = row.createdAt;
      acc.scope = row.scope;
    }
    acc[kind] += 1;
    byClient.set(row.client, acc);
  };
  for (const r of access) add(r, 'access');
  for (const r of refresh) add(r, 'refresh');
  if (byClient.size === 0) return [];

  const ids = [...byClient.keys()];
  const [clients, lastIssued] = await Promise.all([
    db
      .select({
        id: oauthClients.id,
        clientId: oauthClients.clientId,
        clientName: oauthClients.clientName,
        source: oauthClients.source,
      })
      .from(oauthClients)
      .where(inArray(oauthClients.id, ids)),
    // Newest issuance incl. already-rotated / revoked rows (a rotation leaves
    // the refresh used, but its successor pair is newer anyway).
    db
      .select({ client: oauthAccessTokens.oauthClientId, last: max(oauthAccessTokens.createdAt) })
      .from(oauthAccessTokens)
      .where(and(eq(oauthAccessTokens.userId, userId), inArray(oauthAccessTokens.oauthClientId, ids)))
      .groupBy(oauthAccessTokens.oauthClientId),
  ]);
  const lastByClient = new Map(lastIssued.map((r) => [r.client, r.last]));

  return clients
    .map((c): OAuthConnection => {
      const acc = byClient.get(c.id) as Acc;
      const last = lastByClient.get(c.id);
      const lastUsedAt =
        last && last.getTime() > acc.newestLive.getTime() ? last : acc.newestLive;
      return {
        oauthClientId: c.id,
        clientId: c.clientId,
        clientName: c.clientName,
        source: c.source === 'cimd' ? 'cimd' : 'dcr',
        scope: acc.scope,
        lastUsedAt,
        liveAccessTokens: acc.access,
        liveRefreshTokens: acc.refresh,
      };
    })
    .sort(
      (a, b) =>
        b.lastUsedAt.getTime() - a.lastUsedAt.getTime() ||
        a.oauthClientId.localeCompare(b.oauthClientId)
    );
}

export interface RevokedConnection {
  oauthClientId: string;
  clientId: string;
  clientName: string;
  source: ClientSource;
  /** Rows deleted (live or not) — for the audit meta. */
  accessTokens: number;
  refreshTokens: number;
  authorizationCodes: number;
}

/**
 * Revoke `userId`'s grant for one client: delete all of the pair's access
 * tokens, refresh tokens and authorization codes in one transaction. Returns
 * null when the client is unknown or the user holds nothing for it (another
 * user's connection is indistinguishable from an unknown one).
 */
export async function revokeConnection(
  userId: string,
  oauthClientId: string
): Promise<RevokedConnection | null> {
  return getDb().transaction(async (tx) => {
    const [client] = await tx
      .select({
        id: oauthClients.id,
        clientId: oauthClients.clientId,
        clientName: oauthClients.clientName,
        source: oauthClients.source,
      })
      .from(oauthClients)
      .where(eq(oauthClients.id, oauthClientId))
      .limit(1);
    if (!client) return null;

    // One statement for the whole pair: `rotated_to` links stay inside a
    // (user, client) lineage, so the self-FK is satisfied at statement end.
    const refresh = await tx
      .delete(oauthRefreshTokens)
      .where(
        and(eq(oauthRefreshTokens.userId, userId), eq(oauthRefreshTokens.oauthClientId, client.id))
      )
      .returning({ id: oauthRefreshTokens.id });
    const access = await tx
      .delete(oauthAccessTokens)
      .where(
        and(eq(oauthAccessTokens.userId, userId), eq(oauthAccessTokens.oauthClientId, client.id))
      )
      .returning({ id: oauthAccessTokens.id });
    const codes = await tx
      .delete(oauthAuthorizationCodes)
      .where(
        and(
          eq(oauthAuthorizationCodes.userId, userId),
          eq(oauthAuthorizationCodes.clientId, client.clientId)
        )
      )
      .returning({ id: oauthAuthorizationCodes.id });

    if (refresh.length + access.length + codes.length === 0) return null;
    return {
      oauthClientId: client.id,
      clientId: client.clientId,
      clientName: client.clientName,
      source: client.source === 'cimd' ? 'cimd' : 'dcr',
      accessTokens: access.length,
      refreshTokens: refresh.length,
      authorizationCodes: codes.length,
    };
  });
}

