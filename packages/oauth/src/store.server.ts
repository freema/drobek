/**
 * Persistence seam for the OAuth code/token lifecycle. The business rules
 * (single-use, rotation, retry grace, reuse detection, audience/expiry
 * validation) live in codes.server.ts / tokens.server.ts and talk ONLY to this
 * interface, so they unit-test against an in-memory store with NO Postgres —
 * `task check` runs host-side without the stack. Production wires the
 * drizzle-backed store.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  getDb,
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthRefreshTokens,
  type DB,
} from '@drobek/db';

interface AuthCodeRecord {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  resource: string;
  expiresAt: Date;
}
export interface AuthCodeRow extends AuthCodeRecord {
  id: string;
  used: boolean;
  createdAt: Date;
}

/** A user-bound grant: no workspace, no role — membership is resolved per call. */
export interface GrantRecord {
  tokenHash: string;
  userId: string;
  oauthClientId: string | null;
  scope: string;
  audience: string;
  expiresAt: Date;
}
export interface AccessTokenRecord extends GrantRecord {
  /** The refresh token row issued together with this access token. */
  refreshTokenId?: string;
}
export interface AccessTokenRow extends GrantRecord {
  id: string;
  /** Null on access tokens issued before tokens recorded their refresh row. */
  refreshTokenId: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}
export interface RefreshTokenRecord extends GrantRecord {
  /** Explicit row id; omitted → a generated one. */
  id?: string;
}
export interface RefreshTokenRow extends GrantRecord {
  id: string;
  rotatedTo: string | null;
  usedAt: Date | null;
  createdAt: Date;
}

/** Grant identity (user, client, audience) of a lineage. */
export interface GrantKey {
  userId: string;
  oauthClientId: string | null;
  audience: string;
}

export interface OAuthStore {
  insertAuthCode(rec: AuthCodeRecord): Promise<void>;
  findAuthCodeByHash(hash: string): Promise<AuthCodeRow | null>;
  /** Atomic single-use flip; true iff THIS call moved used false→true. */
  markAuthCodeUsed(id: string): Promise<boolean>;

  insertAccessToken(rec: AccessTokenRecord): Promise<void>;
  findAccessTokenByHash(hash: string): Promise<AccessTokenRow | null>;
  /**
   * Revoke the live access tokens issued with one of `refreshTokenIds`, plus
   * the grant's live access tokens that record no refresh row. Other lineages
   * of the same user, client and audience keep working.
   */
  revokeAccessTokensForLineage(grant: GrantKey, refreshTokenIds: string[]): Promise<void>;

  /**
   * Returns the new row id. `id` is set only by the code exchange: the first
   * refresh token of a code's lineage takes an id derived from the code row
   * (codes.server.ts), so a replayed code can find and burn the chain it
   * minted without a code→token column.
   */
  insertRefreshToken(rec: RefreshTokenRecord): Promise<string>;
  findRefreshTokenByHash(hash: string): Promise<RefreshTokenRow | null>;
  findRefreshTokenById(id: string): Promise<RefreshTokenRow | null>;
  /**
   * Rotate refresh token `id` atomically: stamp its used_at (only while still
   * null), insert `successor` and point rotated_to at it — readers never see
   * the claim without the link. Returns the successor's id, or null when the
   * token was already used (a concurrent rotation won, or its lineage was
   * revoked).
   */
  rotateRefresh(id: string, successor: RefreshTokenRecord, usedAt: Date): Promise<string | null>;
  /** Idempotent: stamps used_at only if still null (does not overwrite). */
  markRefreshUsed(id: string): Promise<void>;
}

// ── In-memory store (unit tests only) ────────────────────────────────────────

export function createMemoryOAuthStore(): OAuthStore {
  const codes = new Map<string, AuthCodeRow>();
  const access = new Map<string, AccessTokenRow>();
  const refresh = new Map<string, RefreshTokenRow>();
  const id = () => randomBytes(12).toString('hex');

  const refreshById = (rowId: string): RefreshTokenRow | null => {
    for (const row of refresh.values()) if (row.id === rowId) return row;
    return null;
  };
  const insertRefresh = ({ id: explicitId, ...rec }: RefreshTokenRecord): string => {
    const row: RefreshTokenRow = {
      ...rec,
      id: explicitId ?? id(),
      rotatedTo: null,
      usedAt: null,
      createdAt: new Date(),
    };
    refresh.set(row.tokenHash, row);
    return row.id;
  };

  return {
    async insertAuthCode(rec) {
      const row: AuthCodeRow = {
        ...rec,
        id: id(),
        used: false,
        createdAt: new Date(),
      };
      codes.set(row.codeHash, row);
    },
    async findAuthCodeByHash(hash) {
      return codes.get(hash) ?? null;
    },
    async markAuthCodeUsed(rowId) {
      for (const row of codes.values()) {
        if (row.id === rowId) {
          if (row.used) return false;
          row.used = true;
          return true;
        }
      }
      return false;
    },

    async insertAccessToken({ refreshTokenId, ...rec }) {
      const row: AccessTokenRow = {
        ...rec,
        id: id(),
        refreshTokenId: refreshTokenId ?? null,
        createdAt: new Date(),
        revokedAt: null,
      };
      access.set(row.tokenHash, row);
    },
    async findAccessTokenByHash(hash) {
      return access.get(hash) ?? null;
    },
    async revokeAccessTokensForLineage(grant, refreshTokenIds) {
      const lineage = new Set(refreshTokenIds);
      for (const row of access.values()) {
        if (row.revokedAt !== null) continue;
        const inLineage = row.refreshTokenId !== null && lineage.has(row.refreshTokenId);
        const legacyOfGrant =
          row.refreshTokenId === null &&
          row.userId === grant.userId &&
          row.oauthClientId === grant.oauthClientId &&
          row.audience === grant.audience;
        if (inLineage || legacyOfGrant) row.revokedAt = new Date();
      }
    },

    async insertRefreshToken(rec) {
      return insertRefresh(rec);
    },
    async findRefreshTokenByHash(hash) {
      return refresh.get(hash) ?? null;
    },
    async findRefreshTokenById(rowId) {
      return refreshById(rowId);
    },
    async rotateRefresh(rowId, successor, usedAt) {
      const row = refreshById(rowId);
      if (!row || row.usedAt !== null) return null;
      row.usedAt = usedAt;
      row.rotatedTo = insertRefresh(successor);
      return row.rotatedTo;
    },
    async markRefreshUsed(rowId) {
      const row = refreshById(rowId);
      if (row && row.usedAt === null) row.usedAt = new Date();
    },
  };
}

// ── Drizzle store (production) ────────────────────────────────────────────────

function refreshValues(rec: RefreshTokenRecord) {
  return {
    ...(rec.id !== undefined ? { id: rec.id } : {}),
    tokenHash: rec.tokenHash,
    userId: rec.userId,
    oauthClientId: rec.oauthClientId,
    scope: rec.scope,
    audience: rec.audience,
    expiresAt: rec.expiresAt,
  };
}

export function createDbOAuthStore(db: DB): OAuthStore {
  return {
    async insertAuthCode(rec) {
      await db.insert(oauthAuthorizationCodes).values({
        codeHash: rec.codeHash,
        clientId: rec.clientId,
        userId: rec.userId,
        redirectUri: rec.redirectUri,
        codeChallenge: rec.codeChallenge,
        codeChallengeMethod: rec.codeChallengeMethod,
        scope: rec.scope,
        resource: rec.resource,
        expiresAt: rec.expiresAt,
      });
    },
    async findAuthCodeByHash(hash) {
      const [row] = await db
        .select()
        .from(oauthAuthorizationCodes)
        .where(eq(oauthAuthorizationCodes.codeHash, hash))
        .limit(1);
      return (row as AuthCodeRow | undefined) ?? null;
    },
    async markAuthCodeUsed(rowId) {
      const updated = await db
        .update(oauthAuthorizationCodes)
        .set({ used: true })
        .where(
          and(
            eq(oauthAuthorizationCodes.id, rowId),
            eq(oauthAuthorizationCodes.used, false)
          )
        )
        .returning({ id: oauthAuthorizationCodes.id });
      return updated.length > 0;
    },

    async insertAccessToken(rec) {
      await db.insert(oauthAccessTokens).values({
        tokenHash: rec.tokenHash,
        userId: rec.userId,
        oauthClientId: rec.oauthClientId,
        scope: rec.scope,
        audience: rec.audience,
        refreshTokenId: rec.refreshTokenId ?? null,
        expiresAt: rec.expiresAt,
      });
    },
    async findAccessTokenByHash(hash) {
      const [row] = await db
        .select()
        .from(oauthAccessTokens)
        .where(eq(oauthAccessTokens.tokenHash, hash))
        .limit(1);
      return (row as AccessTokenRow | undefined) ?? null;
    },
    async revokeAccessTokensForLineage(grant, refreshTokenIds) {
      const legacyOfGrant = and(
        isNull(oauthAccessTokens.refreshTokenId),
        eq(oauthAccessTokens.userId, grant.userId),
        eq(oauthAccessTokens.audience, grant.audience),
        grant.oauthClientId === null
          ? isNull(oauthAccessTokens.oauthClientId)
          : eq(oauthAccessTokens.oauthClientId, grant.oauthClientId)
      );
      await db
        .update(oauthAccessTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            isNull(oauthAccessTokens.revokedAt),
            refreshTokenIds.length > 0
              ? or(inArray(oauthAccessTokens.refreshTokenId, refreshTokenIds), legacyOfGrant)
              : legacyOfGrant
          )
        );
    },

    async insertRefreshToken(rec) {
      const [row] = await db
        .insert(oauthRefreshTokens)
        .values(refreshValues(rec))
        .returning({ id: oauthRefreshTokens.id });
      return row.id;
    },
    async findRefreshTokenByHash(hash) {
      const [row] = await db
        .select()
        .from(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.tokenHash, hash))
        .limit(1);
      return (row as RefreshTokenRow | undefined) ?? null;
    },
    async findRefreshTokenById(rowId) {
      const [row] = await db
        .select()
        .from(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.id, rowId))
        .limit(1);
      return (row as RefreshTokenRow | undefined) ?? null;
    },
    async rotateRefresh(rowId, successor, usedAt) {
      // The claim's row lock makes a concurrent rotation wait for this
      // transaction and then find used_at set, with rotated_to already there.
      return db.transaction(async (tx) => {
        const claimed = await tx
          .update(oauthRefreshTokens)
          .set({ usedAt })
          .where(
            and(
              eq(oauthRefreshTokens.id, rowId),
              isNull(oauthRefreshTokens.usedAt)
            )
          )
          .returning({ id: oauthRefreshTokens.id });
        if (claimed.length === 0) return null;
        const [next] = await tx
          .insert(oauthRefreshTokens)
          .values(refreshValues(successor))
          .returning({ id: oauthRefreshTokens.id });
        await tx
          .update(oauthRefreshTokens)
          .set({ rotatedTo: next.id })
          .where(eq(oauthRefreshTokens.id, rowId));
        return next.id;
      });
    },
    async markRefreshUsed(rowId) {
      await db
        .update(oauthRefreshTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(oauthRefreshTokens.id, rowId),
            isNull(oauthRefreshTokens.usedAt)
          )
        );
    },
  };
}

let cachedDbStore: OAuthStore | null = null;

/** Lazy singleton drizzle store used by the route handlers. */
export function defaultOAuthStore(): OAuthStore {
  if (!cachedDbStore) cachedDbStore = createDbOAuthStore(getDb());
  return cachedDbStore;
}
