/**
 * Personal API keys (M0-04, NSO-282) — a second Bearer for the MCP Resource
 * Server next to OAuth access tokens, for clients that cannot run an OAuth
 * flow (CI, scripts, tests). Format `drk_` + 32 base64url characters (24
 * random bytes); the prefix is how the RS tells a key from an OAuth token.
 *
 * A key is bound to a USER with a fixed scope set (same vocabulary as OAuth),
 * has no audience, and is stored ONLY as its SHA-256 (the raw key is returned
 * once, at creation). Lookup is by hash equality — the raw key is never
 * compared or logged. A revoked key stops working immediately.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { apiKeys, getDb } from '@drobek/db';
import { API_KEY_LAST_USED_THROTTLE_MS } from './constants.js';
import { hashToken } from './crypto.server.js';
import { knownScopes, serializeScopes, type Scope } from './scopes.js';

export const API_KEY_PREFIX = 'drk_';

const API_KEY_RE = /^drk_[A-Za-z0-9_-]{32}$/;

/** A fresh raw key: `drk_` + base64url(24 random bytes) = 32 chars. */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
}

/** True when `raw` has the exact API-key shape (cheap pre-check before any DB read). */
export function isApiKeyFormat(raw: string): boolean {
  return API_KEY_RE.test(raw);
}

/** True when a Bearer value should be treated as an API key (prefix match). */
export function looksLikeApiKey(bearer: string): boolean {
  return bearer.startsWith(API_KEY_PREFIX);
}

export interface CreatedApiKey {
  id: string;
  /** The raw key — shown to the user ONCE; never persisted. */
  key: string;
  scopes: string;
}

/** Create a key for `userId`. `scopes` must be a non-empty subset of the vocabulary. */
export async function createApiKey(input: {
  userId: string;
  name: string;
  scopes: readonly Scope[];
}): Promise<CreatedApiKey> {
  const scopes = serializeScopes(knownScopes(input.scopes.join(' ')));
  if (!scopes) throw new Error('an API key needs at least one scope (read, write, publish)');
  const name = input.name.trim();
  if (!name) throw new Error('an API key needs a name');
  const key = generateApiKey();
  const [row] = await getDb()
    .insert(apiKeys)
    .values({ userId: input.userId, name, keyHash: hashToken(key), scopes })
    .returning({ id: apiKeys.id });
  return { id: row.id, key, scopes };
}

export interface ApiKeyClaims {
  id: string;
  userId: string;
  scope: string;
}

/**
 * Resolve a raw key to its claims, or null (malformed, unknown, revoked).
 * Refreshes `last_used_at` at most once per API_KEY_LAST_USED_THROTTLE_MS.
 */
export async function validateApiKey(
  raw: string,
  now: number = Date.now()
): Promise<ApiKeyClaims | null> {
  if (!isApiKeyFormat(raw)) return null;
  const db = getDb();
  const [row] = await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      scopes: apiKeys.scopes,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hashToken(raw)))
    .limit(1);
  if (!row || row.revokedAt !== null) return null;

  const stale = new Date(now - API_KEY_LAST_USED_THROTTLE_MS);
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date(now) })
    .where(
      and(
        eq(apiKeys.id, row.id),
        or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, stale))
      )
    );
  return { id: row.id, userId: row.userId, scope: row.scopes };
}

/** Revoke a key (idempotent). Returns true when a live key was revoked. */
export async function revokeApiKey(id: string): Promise<boolean> {
  const updated = await getDb()
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return updated.length > 0;
}
