/**
 * Refresh rotation, the retry grace and lineage-scoped revocation against the
 * drizzle store on a real (PGlite) database: the atomic claim + successor
 * link, the access token → refresh row link (`refresh_token_id`) and the
 * revoke of a lineage's access tokens plus the grant's ones without a link.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oauthAccessTokens, oauthRefreshTokens, users } from '@drobek/db';
import { createClient } from './clients.server.js';
import { ACCESS_TTL_MS, REFRESH_RETRY_GRACE_MS } from './constants.js';
import { hashToken } from './crypto.server.js';
import { createDbOAuthStore, type OAuthStore } from './store.server.js';
import {
  issueAccessAndRefresh,
  rotateRefreshToken,
  validateAccessToken,
  type GrantInput,
} from './tokens.server.js';
import { freshDb, type TestDb } from './test/db.js';

const AUD = 'http://localhost:3041/mcp';
const REDIRECT = 'http://127.0.0.1:9999/cb';

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

let seq = 0;
async function grant(): Promise<GrantInput> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `refresh-${seq}@example.test` }).returning();
  const client = await createClient({ clientName: `Agent ${seq}`, redirectUris: [REDIRECT] });
  return { userId: u.id, oauthClientId: client.id, scope: 'read write', audience: AUD };
}

async function refreshRow(raw: string) {
  const [row] = await db
    .select()
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, hashToken(raw)));
  return row;
}

async function accessRow(raw: string) {
  const [row] = await db
    .select()
    .from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.tokenHash, hashToken(raw)));
  return row;
}

describe('refresh rotation (drizzle store)', () => {
  it('stores the refresh row each access token was issued with', async () => {
    const g = await grant();
    const first = await issueAccessAndRefresh(g, store);
    expect((await accessRow(first.accessToken)).refreshTokenId).toBe((await refreshRow(first.refreshToken)).id);

    const rot = await rotateRefreshToken(first.refreshToken, store);
    if (!rot.ok) throw new Error('rotation failed');
    const successor = await refreshRow(rot.refreshToken);
    expect(successor.id).toBe(rot.trace.successorId);
    expect((await accessRow(rot.accessToken)).refreshTokenId).toBe(successor.id);
    expect(await refreshRow(first.refreshToken)).toMatchObject({ rotatedTo: successor.id });
  });

  it('a retry within the grace gets a fresh pair from the tail; the old tail is spent', async () => {
    const g = await grant();
    const t0 = Date.now();
    const first = await issueAccessAndRefresh(g, store, t0);
    const rotated = await rotateRefreshToken(first.refreshToken, store, t0);
    if (!rotated.ok) throw new Error('rotation failed');

    const retry = await rotateRefreshToken(first.refreshToken, store, t0 + 5_000);
    expect(retry).toMatchObject({ ok: true, trace: { outcome: 'retried', hops: 1 } });
    if (!retry.ok) return;
    expect(await validateAccessToken(retry.accessToken, { audience: AUD }, store)).not.toBeNull();
    expect(await validateAccessToken(rotated.accessToken, { audience: AUD }, store)).not.toBeNull();

    const oldTail = await refreshRow(rotated.refreshToken);
    expect(oldTail.usedAt).not.toBeNull();
    expect(oldTail.rotatedTo).toBe(retry.trace.successorId);
    const late = t0 + 5_000 + REFRESH_RETRY_GRACE_MS + 1;
    expect(await rotateRefreshToken(rotated.refreshToken, store, late)).toMatchObject({
      ok: false,
      reuse: true,
    });
  });

  it('a multi-hop retry: A→B→C, A presented again within the grace mints from C', async () => {
    const g = await grant();
    const t0 = Date.now();
    const a = await issueAccessAndRefresh(g, store, t0);
    const b = await rotateRefreshToken(a.refreshToken, store, t0);
    if (!b.ok) throw new Error('A→B failed');
    const c = await rotateRefreshToken(b.refreshToken, store, t0 + 1_000);
    if (!c.ok) throw new Error('B→C failed');

    const retry = await rotateRefreshToken(a.refreshToken, store, t0 + 2_000);
    expect(retry).toMatchObject({ ok: true, trace: { outcome: 'retried', hops: 2 } });
    if (!retry.ok) return;
    expect((await refreshRow(c.refreshToken)).rotatedTo).toBe(retry.trace.successorId);
  });

  it('concurrent refreshes with one token both get a pair', async () => {
    const g = await grant();
    const first = await issueAccessAndRefresh(g, store);
    const results = await Promise.all([
      rotateRefreshToken(first.refreshToken, store),
      rotateRefreshToken(first.refreshToken, store),
      rotateRefreshToken(first.refreshToken, store),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.trace.outcome).sort()).toEqual(['retried', 'retried', 'rotated']);
    const refreshTokens = new Set(results.map((r) => (r.ok ? r.refreshToken : '')));
    expect(refreshTokens.size).toBe(3);
    // One chain: R1 → R2 → R3 → R4, only the tail unused.
    const rows = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.userId, g.userId));
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.usedAt === null)).toHaveLength(1);
    expect(rows.filter((r) => r.usedAt !== null).every((r) => r.rotatedTo !== null)).toBe(true);
  });

  it('a retry after the grace is reuse: the lineage is revoked', async () => {
    const g = await grant();
    const t0 = Date.now();
    const first = await issueAccessAndRefresh(g, store, t0);
    const rotated = await rotateRefreshToken(first.refreshToken, store, t0);
    if (!rotated.ok) throw new Error('rotation failed');

    const reuse = await rotateRefreshToken(first.refreshToken, store, t0 + REFRESH_RETRY_GRACE_MS + 1);
    expect(reuse).toMatchObject({ ok: false, reuse: true, trace: { outcome: 'reuse' } });
    expect(await rotateRefreshToken(rotated.refreshToken, store)).toMatchObject({ ok: false, reuse: true });
    expect(await validateAccessToken(first.accessToken, { audience: AUD }, store)).toBeNull();
    expect(await validateAccessToken(rotated.accessToken, { audience: AUD }, store)).toBeNull();
  });
});

describe('reuse revokes one lineage (drizzle store)', () => {
  it('a second lineage of the same user, client and audience keeps working', async () => {
    const g = await grant();
    const one = await issueAccessAndRefresh(g, store);
    const two = await issueAccessAndRefresh(g, store);
    const oneRotated = await rotateRefreshToken(one.refreshToken, store);
    if (!oneRotated.ok) throw new Error('rotation failed');

    const at = Date.now() + REFRESH_RETRY_GRACE_MS + 1;
    expect(await rotateRefreshToken(one.refreshToken, store, at)).toMatchObject({ reuse: true });
    expect(await validateAccessToken(oneRotated.accessToken, { audience: AUD }, store)).toBeNull();

    expect(await validateAccessToken(two.accessToken, { audience: AUD }, store)).not.toBeNull();
    expect(await rotateRefreshToken(two.refreshToken, store, at)).toMatchObject({
      ok: true,
      trace: { outcome: 'rotated' },
    });
  });

  it('revokes the grant’s access tokens without a refresh row, not those of other grants', async () => {
    const g = await grant();
    const other = await grant();
    const expiresAt = new Date(Date.now() + ACCESS_TTL_MS);
    const legacy = (raw: string, rest: Partial<GrantInput> = {}) =>
      db.insert(oauthAccessTokens).values({ ...g, ...rest, tokenHash: hashToken(raw), expiresAt });
    await legacy('legacy-same-grant');
    await legacy('legacy-other-audience', { audience: 'https://other.example/mcp' });
    await legacy('legacy-other-client', { oauthClientId: other.oauthClientId });
    await legacy('legacy-other-user', { userId: other.userId });

    const first = await issueAccessAndRefresh(g, store);
    await rotateRefreshToken(first.refreshToken, store);
    const at = Date.now() + REFRESH_RETRY_GRACE_MS + 1;
    expect(await rotateRefreshToken(first.refreshToken, store, at)).toMatchObject({ reuse: true });

    expect((await accessRow('legacy-same-grant')).revokedAt).not.toBeNull();
    for (const raw of ['legacy-other-audience', 'legacy-other-client', 'legacy-other-user']) {
      expect((await accessRow(raw)).revokedAt).toBeNull();
    }
  });
});
