/**
 * The daily OAuth prune on a real (PGlite) database: expired access and
 * refresh tokens go 7 days after their expiry, codes once the lineage they
 * minted is gone too; live and rotated-but-unexpired tokens stay, so reuse
 * detection and code-replay revocation keep working after a prune.
 */
import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oauthAccessTokens, oauthAuthorizationCodes, oauthRefreshTokens, users } from '@drobek/db';
import { createClient } from './clients.server.js';
import { authCodeRefreshTokenId, consumeAuthCode, issueAuthCode } from './codes.server.js';
import { REFRESH_RETRY_GRACE_MS } from './constants.js';
import { hashToken } from './crypto.server.js';
import { pruneExpiredOAuth } from './prune.server.js';
import { createDbOAuthStore, type OAuthStore } from './store.server.js';
import { issueAccessAndRefresh, rotateRefreshToken, validateAccessToken, type GrantInput } from './tokens.server.js';
import { freshDb, type TestDb } from './test/db.js';

const AUD = 'http://localhost:3041/mcp';
const REDIRECT = 'http://127.0.0.1:9999/cb';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

let db: TestDb;
let store: OAuthStore;
let close: () => Promise<void>;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  store = createDbOAuthStore(t.db as never);
  close = () => t.pg.close();
});
afterAll(async () => close());

async function grant(email: string): Promise<{ grant: GrantInput; clientId: string }> {
  const [u] = await db.insert(users).values({ email }).returning();
  const client = await createClient({ clientName: email, redirectUris: [REDIRECT] });
  return { grant: { userId: u.id, oauthClientId: client.id, scope: 'read write', audience: AUD }, clientId: client.clientId };
}

async function refreshRow(raw: string) {
  const [row] = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.tokenHash, hashToken(raw)));
  return row ?? null;
}

async function accessExists(raw: string): Promise<boolean> {
  const rows = await db.select({ id: oauthAccessTokens.id }).from(oauthAccessTokens).where(eq(oauthAccessTokens.tokenHash, hashToken(raw)));
  return rows.length === 1;
}

async function code(clientId: string, userId: string, now: number): Promise<string> {
  return issueAuthCode(
    { clientId, userId, redirectUri: REDIRECT, codeChallenge: CHALLENGE, codeChallengeMethod: 'S256', scope: 'read', resource: AUD },
    store,
    now
  );
}

async function codeExists(raw: string): Promise<boolean> {
  const rows = await db
    .select({ id: oauthAuthorizationCodes.id })
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.codeHash, hashToken(raw)));
  return rows.length === 1;
}

describe('pruneExpiredOAuth', () => {
  it('deletes rows 7 days past their expiry (codes 37 days) and keeps the rest', async () => {
    const { grant: g, clientId } = await grant('prune-mixed@example.test');

    const live = await issueAccessAndRefresh(g, store, NOW);
    // Its access token expired 8 days ago, its refresh token is live.
    const weekOld = await issueAccessAndRefresh(g, store, NOW - 8 * DAY - HOUR);
    // Its refresh token expired 6 days ago.
    const recent = await issueAccessAndRefresh(g, store, NOW - 36 * DAY);

    // A lineage rotated twice: its first two refresh tokens expired 15 and 14 days ago.
    const first = await issueAccessAndRefresh(g, store, NOW - 45 * DAY);
    const second = await rotateRefreshToken(first.refreshToken, store, NOW - 44 * DAY);
    if (!second.ok) throw new Error('rotation failed');
    const third = await rotateRefreshToken(second.refreshToken, store, NOW - 20 * DAY);
    if (!third.ok) throw new Error('rotation failed');

    const oldCode = await code(clientId, g.userId, NOW - 38 * DAY);
    const keptCode = await code(clientId, g.userId, NOW - 36 * DAY);

    const out = await pruneExpiredOAuth({ now: new Date(NOW) });

    expect(await accessExists(live.accessToken)).toBe(true);
    for (const pair of [weekOld, recent, first, second, third]) {
      expect(await accessExists(pair.accessToken)).toBe(false);
    }

    // The lineage's expired head goes, its live tail stays.
    expect(await refreshRow(first.refreshToken)).toBeNull();
    expect(await refreshRow(second.refreshToken)).toBeNull();
    expect(await refreshRow(third.refreshToken)).not.toBeNull();
    expect(await refreshRow(live.refreshToken)).not.toBeNull();
    expect(await refreshRow(weekOld.refreshToken)).not.toBeNull();
    const recentRow = await refreshRow(recent.refreshToken);
    expect(recentRow).not.toBeNull();
    expect(recentRow?.expiresAt.getTime()).toBeLessThan(NOW);

    expect(await codeExists(oldCode)).toBe(false);
    expect(await codeExists(keptCode)).toBe(true);

    expect(out).toEqual({ accessTokens: 5, refreshTokens: 2, authorizationCodes: 1 });
    // A second run finds nothing more.
    expect(await pruneExpiredOAuth({ now: new Date(NOW) })).toEqual({ accessTokens: 0, refreshTokens: 0, authorizationCodes: 0 });
  });

  it('keeps an expired refresh token an unexpired one still points at', async () => {
    const { grant: g } = await grant('prune-fk@example.test');
    // Rotated "in the past": the predecessor outlives its successor.
    const head = await issueAccessAndRefresh(g, store, NOW);
    const tail = await rotateRefreshToken(head.refreshToken, store, NOW - 40 * DAY);
    if (!tail.ok) throw new Error('rotation failed');

    await pruneExpiredOAuth({ now: new Date(NOW) });

    const headRow = await refreshRow(head.refreshToken);
    expect(headRow?.rotatedTo).toBe(tail.trace.successorId);
    expect(await refreshRow(tail.refreshToken)).not.toBeNull();
  });

  it('leaves reuse detection working on a pruned lineage', async () => {
    const { grant: g } = await grant('prune-reuse@example.test');
    const first = await issueAccessAndRefresh(g, store, NOW - 45 * DAY);
    const second = await rotateRefreshToken(first.refreshToken, store, NOW - 20 * DAY);
    if (!second.ok) throw new Error('rotation failed');
    const third = await rotateRefreshToken(second.refreshToken, store, NOW - 10 * DAY);
    if (!third.ok) throw new Error('rotation failed');

    await pruneExpiredOAuth({ now: new Date(NOW) });
    expect(await refreshRow(first.refreshToken)).toBeNull();
    // Rotated, not expired: kept for reuse detection.
    expect((await refreshRow(second.refreshToken))?.usedAt).not.toBeNull();

    const fourth = await rotateRefreshToken(third.refreshToken, store, NOW);
    expect(fourth.ok).toBe(true);
    if (!fourth.ok) return;

    // The rotated token comes back after the retry grace: reuse burns the lineage.
    const replay = await rotateRefreshToken(second.refreshToken, store, NOW + REFRESH_RETRY_GRACE_MS + 1);
    expect(replay).toMatchObject({ ok: false, reuse: true, trace: { outcome: 'reuse' } });
    expect(await validateAccessToken(fourth.accessToken, { now: NOW + 1 }, store)).toBeNull();
    expect((await rotateRefreshToken(fourth.refreshToken, store, NOW + 2)).ok).toBe(false);

    // The pruned head is unknown now, which the endpoint answers like expired.
    expect(await rotateRefreshToken(first.refreshToken, store, NOW)).toMatchObject({ ok: false, reuse: false, trace: { outcome: 'unknown' } });
  });

  it('keeps a used code while the lineage it minted can be revoked by its replay', async () => {
    const { grant: g, clientId } = await grant('prune-code@example.test');
    const issuedAt = NOW - 20 * DAY;
    const raw = await code(clientId, g.userId, issuedAt);
    const consumed = await consumeAuthCode({ code: raw, redirectUri: REDIRECT, codeVerifier: VERIFIER }, store, issuedAt);
    if (!consumed.ok) throw new Error('exchange failed');
    const pair = await issueAccessAndRefresh(g, store, issuedAt, { refreshTokenId: consumed.refreshTokenId });
    const next = await rotateRefreshToken(pair.refreshToken, store, NOW - HOUR);
    if (!next.ok || !next.trace.successorId) throw new Error('rotation failed');
    const successorId = next.trace.successorId;

    await pruneExpiredOAuth({ now: new Date(NOW) });
    expect(await codeExists(raw)).toBe(true);

    const replay = await consumeAuthCode({ code: raw, redirectUri: REDIRECT, codeVerifier: VERIFIER }, store, NOW);
    expect(replay).toMatchObject({ ok: false, error: 'invalid_grant' });
    expect(await validateAccessToken(next.accessToken, { now: NOW }, store)).toBeNull();
    const lineage = await db
      .select({ usedAt: oauthRefreshTokens.usedAt })
      .from(oauthRefreshTokens)
      .where(inArray(oauthRefreshTokens.id, [authCodeRefreshTokenId(consumed.row.id), successorId]));
    expect(lineage).toHaveLength(2);
    expect(lineage.every((r) => r.usedAt !== null)).toBe(true);
  });
});
