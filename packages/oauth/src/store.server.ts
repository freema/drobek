/**
 * Persistence seam for the OAuth code/token lifecycle (U5). The business rules
 * (single-use, rotation, reuse detection, audience/expiry validation) live in
 * codes.server.ts / tokens.server.ts and talk ONLY to this interface, so they
 * unit-test against an in-memory store with NO Postgres — `task check` runs
 * host-side without the stack. Production wires the drizzle-backed store.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  getDb,
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthRefreshTokens,
  type DB,
} from '@drobek/db';

/** The three membership roles a token can be bound to (mirrors membershipRoleEnum). */
export type OAuthRole = 'workspace-admin' | 'editor' | 'viewer';

export interface AuthCodeRecord {
  codeHash: string;
  clientId: string;
  userId: string;
  workspaceId: string;
  role: OAuthRole;
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

export interface GrantRecord {
  tokenHash: string;
  userId: string;
  workspaceId: string;
  role: OAuthRole;
  oauthClientId: string | null;
  scope: string;
  audience: string;
  expiresAt: Date;
}
export interface AccessTokenRow extends GrantRecord {
  id: string;
  createdAt: Date;
  revokedAt: Date | null;
}
export interface RefreshTokenRow extends GrantRecord {
  id: string;
  rotatedTo: string | null;
  usedAt: Date | null;
  createdAt: Date;
}

/** Grant identity used to revoke a lineage's access tokens on reuse. */
export interface GrantKey {
  userId: string;
  workspaceId: string;
  oauthClientId: string | null;
  audience: string;
}

export interface OAuthStore {
  insertAuthCode(rec: AuthCodeRecord): Promise<void>;
  findAuthCodeByHash(hash: string): Promise<AuthCodeRow | null>;
  /** Atomic single-use flip; true iff THIS call moved used false→true. */
  markAuthCodeUsed(id: string): Promise<boolean>;

  insertAccessToken(rec: GrantRecord): Promise<void>;
  findAccessTokenByHash(hash: string): Promise<AccessTokenRow | null>;
  revokeAccessTokensForGrant(grant: GrantKey): Promise<void>;

  /** Returns the new row id (for rotated_to lineage links). */
  insertRefreshToken(rec: GrantRecord): Promise<string>;
  findRefreshTokenByHash(hash: string): Promise<RefreshTokenRow | null>;
  findRefreshTokenById(id: string): Promise<RefreshTokenRow | null>;
  /**
   * Atomically claim a refresh token for rotation: flips used_at null→now and
   * returns true iff THIS call won. A concurrent rotation of the same token
   * loses the claim (false) and is treated as reuse — prevents double-spend.
   */
  claimRefreshForRotation(id: string): Promise<boolean>;
  /** Link a claimed refresh to its successor (rotated_to). */
  linkRefreshRotatedTo(id: string, rotatedToId: string): Promise<void>;
  /** Idempotent: stamps used_at only if still null (does not overwrite). */
  markRefreshUsed(id: string): Promise<void>;
}

// ── In-memory store (unit tests only) ────────────────────────────────────────

export function createMemoryOAuthStore(): OAuthStore {
  const codes = new Map<string, AuthCodeRow>();
  const access = new Map<string, AccessTokenRow>();
  const refresh = new Map<string, RefreshTokenRow>();
  const id = () => randomBytes(12).toString('hex');

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

    async insertAccessToken(rec) {
      const row: AccessTokenRow = {
        ...rec,
        id: id(),
        createdAt: new Date(),
        revokedAt: null,
      };
      access.set(row.tokenHash, row);
    },
    async findAccessTokenByHash(hash) {
      return access.get(hash) ?? null;
    },
    async revokeAccessTokensForGrant(grant) {
      for (const row of access.values()) {
        if (
          row.userId === grant.userId &&
          row.workspaceId === grant.workspaceId &&
          row.oauthClientId === grant.oauthClientId &&
          row.audience === grant.audience &&
          row.revokedAt === null
        ) {
          row.revokedAt = new Date();
        }
      }
    },

    async insertRefreshToken(rec) {
      const row: RefreshTokenRow = {
        ...rec,
        id: id(),
        rotatedTo: null,
        usedAt: null,
        createdAt: new Date(),
      };
      refresh.set(row.tokenHash, row);
      return row.id;
    },
    async findRefreshTokenByHash(hash) {
      return refresh.get(hash) ?? null;
    },
    async findRefreshTokenById(rowId) {
      for (const row of refresh.values()) if (row.id === rowId) return row;
      return null;
    },
    async claimRefreshForRotation(rowId) {
      for (const row of refresh.values()) {
        if (row.id === rowId) {
          if (row.usedAt !== null) return false;
          row.usedAt = new Date();
          return true;
        }
      }
      return false;
    },
    async linkRefreshRotatedTo(rowId, rotatedToId) {
      for (const row of refresh.values()) {
        if (row.id === rowId) {
          row.rotatedTo = rotatedToId;
          return;
        }
      }
    },
    async markRefreshUsed(rowId) {
      for (const row of refresh.values()) {
        if (row.id === rowId && row.usedAt === null) row.usedAt = new Date();
      }
    },
  };
}

// ── Drizzle store (production) ────────────────────────────────────────────────

export function createDbOAuthStore(db: DB): OAuthStore {
  return {
    async insertAuthCode(rec) {
      await db.insert(oauthAuthorizationCodes).values({
        codeHash: rec.codeHash,
        clientId: rec.clientId,
        userId: rec.userId,
        workspaceId: rec.workspaceId,
        role: rec.role,
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
        workspaceId: rec.workspaceId,
        role: rec.role,
        oauthClientId: rec.oauthClientId,
        scope: rec.scope,
        audience: rec.audience,
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
    async revokeAccessTokensForGrant(grant) {
      await db
        .update(oauthAccessTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(oauthAccessTokens.userId, grant.userId),
            eq(oauthAccessTokens.workspaceId, grant.workspaceId),
            eq(oauthAccessTokens.audience, grant.audience),
            grant.oauthClientId === null
              ? isNull(oauthAccessTokens.oauthClientId)
              : eq(oauthAccessTokens.oauthClientId, grant.oauthClientId),
            isNull(oauthAccessTokens.revokedAt)
          )
        );
    },

    async insertRefreshToken(rec) {
      const [row] = await db
        .insert(oauthRefreshTokens)
        .values({
          tokenHash: rec.tokenHash,
          userId: rec.userId,
          workspaceId: rec.workspaceId,
          role: rec.role,
          oauthClientId: rec.oauthClientId,
          scope: rec.scope,
          audience: rec.audience,
          expiresAt: rec.expiresAt,
        })
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
    async claimRefreshForRotation(rowId) {
      const updated = await db
        .update(oauthRefreshTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(oauthRefreshTokens.id, rowId),
            isNull(oauthRefreshTokens.usedAt)
          )
        )
        .returning({ id: oauthRefreshTokens.id });
      return updated.length > 0;
    },
    async linkRefreshRotatedTo(rowId, rotatedToId) {
      await db
        .update(oauthRefreshTokens)
        .set({ rotatedTo: rotatedToId })
        .where(eq(oauthRefreshTokens.id, rowId));
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
