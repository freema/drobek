import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oauthAccessTokens, oauthAuthorizationCodes, oauthRefreshTokens, users } from '@drobek/db';
import { createClient } from './clients.server.js';
import { issueAuthCode } from './codes.server.js';
import { listConnections, revokeConnection } from './connections.server.js';
import { createDbOAuthStore, type OAuthStore } from './store.server.js';
import { issueAccessAndRefresh, rotateRefreshToken, validateAccessToken } from './tokens.server.js';
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

async function user(email: string): Promise<string> {
  const [u] = await db.insert(users).values({ email }).returning();
  return u.id;
}

describe('OAuth connections (M2-04)', () => {
  it('lists the clients holding a live grant for the user, with name, source, scope and last use', async () => {
    const alice = await user('alice-conn@example.test');
    const bob = await user('bob-conn@example.test');
    const editor = await createClient({ clientName: 'Claude Code', redirectUris: [REDIRECT] });
    const other = await createClient({ clientName: 'Cursor', redirectUris: [REDIRECT] });
    const unused = await createClient({ clientName: 'Never approved', redirectUris: [REDIRECT] });

    expect(await listConnections(alice)).toEqual([]);

    await issueAccessAndRefresh(
      { userId: alice, oauthClientId: editor.id, scope: 'read write', audience: AUD },
      store
    );
    await issueAccessAndRefresh(
      { userId: alice, oauthClientId: other.id, scope: 'read', audience: AUD },
      store
    );
    // Bob's grant for the same client is not Alice's connection.
    await issueAccessAndRefresh(
      { userId: bob, oauthClientId: editor.id, scope: 'read write publish', audience: AUD },
      store
    );

    const listed = await listConnections(alice);
    expect(listed.map((c) => c.clientName).sort()).toEqual(['Claude Code', 'Cursor']);
    expect(listed.map((c) => c.oauthClientId)).not.toContain(unused.id);
    const cc = listed.find((c) => c.oauthClientId === editor.id);
    expect(cc).toMatchObject({
      clientId: editor.clientId,
      source: 'dcr',
      scope: 'read write',
      liveAccessTokens: 1,
      liveRefreshTokens: 1,
    });
    expect(cc?.lastUsedAt).toBeInstanceOf(Date);

    // An expired, revoked grant is no connection.
    const carol = await user('carol-conn@example.test');
    await issueAccessAndRefresh(
      { userId: carol, oauthClientId: editor.id, scope: 'read', audience: AUD },
      store,
      Date.now() - 400 * 24 * 3600 * 1000
    );
    expect(await listConnections(carol)).toEqual([]);
  });

  it('revocation kills access + refresh of that client for that user only; the old refresh is invalid_grant', async () => {
    const dana = await user('dana-conn@example.test');
    const erin = await user('erin-conn@example.test');
    const client = await createClient({ clientName: 'Agent X', redirectUris: [REDIRECT] });
    const keep = await createClient({ clientName: 'Agent Y', redirectUris: [REDIRECT] });

    const first = await issueAccessAndRefresh(
      { userId: dana, oauthClientId: client.id, scope: 'read write', audience: AUD },
      store
    );
    // One rotation: the lineage now has a used refresh and a live successor.
    const rotated = await rotateRefreshToken(first.refreshToken, store);
    expect(rotated.ok).toBe(true);
    const live = rotated as { ok: true; accessToken: string; refreshToken: string };
    // A pending authorization code of the pair is dropped too.
    await issueAuthCode(
      {
        clientId: client.clientId,
        userId: dana,
        redirectUri: REDIRECT,
        codeChallenge: 'x'.repeat(43),
        codeChallengeMethod: 'S256',
        scope: 'read',
        resource: AUD,
      },
      store
    );
    const keepTokens = await issueAccessAndRefresh(
      { userId: dana, oauthClientId: keep.id, scope: 'read', audience: AUD },
      store
    );
    const erinTokens = await issueAccessAndRefresh(
      { userId: erin, oauthClientId: client.id, scope: 'read', audience: AUD },
      store
    );

    expect(await validateAccessToken(live.accessToken, { audience: AUD }, store)).not.toBeNull();

    // Another user cannot revoke Dana's connection (nothing of theirs → null).
    const stranger = await user('stranger-conn@example.test');
    expect(await revokeConnection(stranger, client.id)).toBeNull();
    expect(await revokeConnection(dana, 'no-such-client')).toBeNull();

    const revoked = await revokeConnection(dana, client.id);
    expect(revoked).toMatchObject({
      oauthClientId: client.id,
      clientId: client.clientId,
      clientName: 'Agent X',
      source: 'dcr',
      accessTokens: 2,
      refreshTokens: 2,
      authorizationCodes: 1,
    });

    // The access token is dead on the next validation (no cache)…
    expect(await validateAccessToken(live.accessToken, { audience: AUD }, store)).toBeNull();
    // …and both refresh tokens of the lineage are unknown → invalid_grant.
    for (const rt of [live.refreshToken, first.refreshToken]) {
      const again = await rotateRefreshToken(rt, store);
      expect(again).toMatchObject({ ok: false, error: 'invalid_grant' });
    }
    const codes = await db
      .select()
      .from(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.userId, dana));
    expect(codes).toEqual([]);

    // Dana's other client and Erin's grant for the same client survive.
    expect(await validateAccessToken(keepTokens.accessToken, { audience: AUD }, store)).not.toBeNull();
    expect(await validateAccessToken(erinTokens.accessToken, { audience: AUD }, store)).not.toBeNull();
    const erinRot = await rotateRefreshToken(erinTokens.refreshToken, store);
    expect(erinRot.ok).toBe(true);
    expect((await listConnections(dana)).map((c) => c.oauthClientId)).toEqual([keep.id]);

    // Revoking again is a no-op.
    expect(await revokeConnection(dana, client.id)).toBeNull();
  });

  it('reuse detection still burns a live lineage after the change', async () => {
    const fay = await user('fay-conn@example.test');
    const client = await createClient({ clientName: 'Agent Z', redirectUris: [REDIRECT] });
    const first = await issueAccessAndRefresh(
      { userId: fay, oauthClientId: client.id, scope: 'read', audience: AUD },
      store
    );
    const rot = await rotateRefreshToken(first.refreshToken, store);
    expect(rot.ok).toBe(true);
    const reuse = await rotateRefreshToken(first.refreshToken, store);
    expect(reuse).toMatchObject({ ok: false, error: 'invalid_grant', reuse: true });
    const successor = (rot as { refreshToken: string }).refreshToken;
    expect(await rotateRefreshToken(successor, store)).toMatchObject({ ok: false });
    // The burned grant has no live token left → no connection.
    expect(await listConnections(fay)).toEqual([]);
    const refreshRows = await db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.userId, fay));
    expect(refreshRows.every((r) => r.usedAt !== null)).toBe(true);
    const accessRows = await db
      .select()
      .from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.userId, fay));
    expect(accessRows.every((r) => r.revokedAt !== null)).toBe(true);
  });
});
