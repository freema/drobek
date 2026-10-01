import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACCESS_TTL_MS,
  REFRESH_RETRY_GRACE_MS,
  REFRESH_RETRY_MAX_HOPS,
  REFRESH_TTL_MS,
} from './constants.js';
import {
  issueAccessAndRefresh,
  rotateRefreshToken,
  validateAccessToken,
  type GrantInput,
} from './tokens.server.js';
import { createMemoryOAuthStore, type OAuthStore } from './store.server.js';
import { hashToken } from './crypto.server.js';

const GRANT: GrantInput = {
  userId: 'u1',
  oauthClientId: 'client-pk-1',
  scope: 'read write',
  audience: 'http://localhost:3042',
};

let store: OAuthStore;

beforeEach(() => {
  store = createMemoryOAuthStore();
});

describe('validateAccessToken', () => {
  it('resolves a fresh token to its claims', async () => {
    const { accessToken } = await issueAccessAndRefresh(GRANT, store);
    const claims = await validateAccessToken(accessToken, {}, store);
    expect(claims).not.toBeNull();
    expect(claims?.userId).toBe('u1');
    expect(claims?.scope).toBe('read write');
    expect(claims).not.toHaveProperty('workspaceId');
    expect(claims?.audience).toBe('http://localhost:3042');
  });

  it('honors the expected audience (RFC 8707)', async () => {
    const { accessToken } = await issueAccessAndRefresh(GRANT, store);
    expect(
      await validateAccessToken(accessToken, { audience: 'http://localhost:3042' }, store)
    ).not.toBeNull();
    expect(
      await validateAccessToken(accessToken, { audience: 'https://evil.example' }, store)
    ).toBeNull();
  });

  it('rejects an expired token', async () => {
    const t0 = Date.now();
    const { accessToken } = await issueAccessAndRefresh(GRANT, store, t0);
    expect(
      await validateAccessToken(accessToken, { now: t0 + ACCESS_TTL_MS + 1 }, store)
    ).toBeNull();
  });

  it('rejects an unknown token', async () => {
    expect(await validateAccessToken('never-minted', {}, store)).toBeNull();
  });
});

describe('rotateRefreshToken', () => {
  it('rotates: a new pair is issued and the old refresh is retired', async () => {
    const first = await issueAccessAndRefresh(GRANT, store);
    const rot = await rotateRefreshToken(first.refreshToken, store);
    expect(rot.ok).toBe(true);
    if (rot.ok) {
      expect(rot.refreshToken).not.toBe(first.refreshToken);
      expect(await validateAccessToken(rot.accessToken, {}, store)).not.toBeNull();
      expect(rot.scope).toBe(GRANT.scope);
    }
  });

  it('rejects an expired refresh token', async () => {
    const t0 = Date.now();
    const first = await issueAccessAndRefresh(GRANT, store, t0);
    const rot = await rotateRefreshToken(
      first.refreshToken,
      store,
      t0 + REFRESH_TTL_MS + 1
    );
    expect(rot.ok).toBe(false);
    if (!rot.ok) {
      expect(rot.error).toBe('invalid_grant');
      expect(rot.reuse).toBe(false);
    }
  });

  it('detects reuse after the retry grace and burns the whole lineage', async () => {
    const t0 = Date.now();
    const first = await issueAccessAndRefresh(GRANT, store, t0); // A1 + R1
    const rotated = await rotateRefreshToken(first.refreshToken, store, t0); // R1 -> R2 (+ A2)
    expect(rotated).toMatchObject({ ok: true, trace: { outcome: 'rotated' } });
    if (!rotated.ok) return;

    // Replaying R1 (used more than the grace ago) is reuse.
    const later = t0 + REFRESH_RETRY_GRACE_MS + 1;
    const reuse = await rotateRefreshToken(first.refreshToken, store, later);
    expect(reuse).toMatchObject({ ok: false, reuse: true, trace: { outcome: 'reuse' } });

    // Lineage burned: the successor R2 can no longer rotate, not even as a retry…
    const r2 = await rotateRefreshToken(rotated.refreshToken, store, later);
    expect(r2).toMatchObject({ ok: false, reuse: true });

    // …and every access token of the lineage is revoked.
    expect(await validateAccessToken(first.accessToken, { now: later }, store)).toBeNull();
    expect(await validateAccessToken(rotated.accessToken, { now: later }, store)).toBeNull();
  });

  it('rejects a refresh presented by another client without burning the lineage', async () => {
    const first = await issueAccessAndRefresh(GRANT, store);
    const stolen = await rotateRefreshToken(first.refreshToken, store, Date.now(), {
      expectedOauthClientId: 'someone-else',
    });
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.reuse).toBe(false);
    // The rightful client can still rotate it.
    const ok = await rotateRefreshToken(first.refreshToken, store, Date.now(), {
      expectedOauthClientId: GRANT.oauthClientId,
    });
    expect(ok.ok).toBe(true);
  });

  it('rejects an unknown refresh token', async () => {
    const rot = await rotateRefreshToken('never-minted', store);
    expect(rot).toMatchObject({ ok: false, reuse: false, trace: { outcome: 'unknown' } });
  });

  it('claims a rotation atomically: the second rotation of the same token loses', async () => {
    const first = await issueAccessAndRefresh(GRANT, store); // A1 + R1
    const row = await store.findRefreshTokenByHash(
      hashToken(first.refreshToken)
    );
    expect(row).not.toBeNull();
    if (!row) return;
    const successor = (hash: string) => ({ ...GRANT, tokenHash: hash, expiresAt: new Date(Date.now() + 1000) });
    // The first rotation wins and links its successor; a second one on the
    // SAME row loses — no double-spend when two refreshes race.
    const won = await store.rotateRefresh(row.id, successor('h-1'), new Date());
    expect(won).not.toBeNull();
    expect(await store.rotateRefresh(row.id, successor('h-2'), new Date())).toBeNull();
    expect(await store.findRefreshTokenById(row.id)).toMatchObject({ rotatedTo: won });
    expect(await store.findRefreshTokenByHash('h-2')).toBeNull();
  });

  it('records the refresh row an access token was issued with', async () => {
    const first = await issueAccessAndRefresh(GRANT, store);
    const firstRefresh = await store.findRefreshTokenByHash(hashToken(first.refreshToken));
    expect(await store.findAccessTokenByHash(hashToken(first.accessToken))).toMatchObject({
      refreshTokenId: firstRefresh?.id,
    });
    const rot = await rotateRefreshToken(first.refreshToken, store);
    if (!rot.ok) throw new Error('rotation failed');
    expect(await store.findAccessTokenByHash(hashToken(rot.accessToken))).toMatchObject({
      refreshTokenId: rot.trace.successorId,
    });
  });

  it('traces every outcome with row ids only', async () => {
    const t0 = Date.now();
    const first = await issueAccessAndRefresh(GRANT, store, t0);
    const row = await store.findRefreshTokenByHash(hashToken(first.refreshToken));
    const ids = { refreshTokenId: row?.id, userId: GRANT.userId, oauthClientId: GRANT.oauthClientId };

    const mismatch = await rotateRefreshToken(first.refreshToken, store, t0, {
      expectedOauthClientId: 'someone-else',
    });
    expect(mismatch.trace).toEqual({ outcome: 'client_mismatch', ...ids });
    const expired = await rotateRefreshToken(first.refreshToken, store, t0 + REFRESH_TTL_MS + 1);
    expect(expired.trace).toEqual({ outcome: 'expired', ...ids });
    expect((await rotateRefreshToken('never-minted', store)).trace).toEqual({ outcome: 'unknown' });

    const rotated = await rotateRefreshToken(first.refreshToken, store, t0);
    if (!rotated.ok) throw new Error('rotation failed');
    expect(rotated.trace).toEqual({ outcome: 'rotated', ...ids, successorId: expect.any(String) });
    const retried = await rotateRefreshToken(first.refreshToken, store, t0 + 1000);
    expect(retried.trace).toEqual({ outcome: 'retried', ...ids, successorId: expect.any(String), hops: 1 });

    const serialized = JSON.stringify([mismatch, expired, rotated, retried].map((r) => r.trace));
    for (const raw of [first.refreshToken, first.accessToken, rotated.refreshToken, rotated.accessToken]) {
      expect(serialized).not.toContain(raw);
      expect(serialized).not.toContain(hashToken(raw));
    }
  });
});

describe('rotateRefreshToken — retry grace', () => {
  async function refreshOf(raw: string) {
    return store.findRefreshTokenByHash(hashToken(raw));
  }

  it('a retry within the grace gets a fresh pair from the tail; the old tail is spent', async () => {
    const t0 = Date.now();
    const first = await issueAccessAndRefresh(GRANT, store, t0); // R1
    const rotated = await rotateRefreshToken(first.refreshToken, store, t0); // R1 -> R2
    if (!rotated.ok) throw new Error('rotation failed');

    // The client lost that response and sends R1 again 30 s later.
    const retry = await rotateRefreshToken(first.refreshToken, store, t0 + 30_000);
    expect(retry).toMatchObject({ ok: true, trace: { outcome: 'retried', hops: 1 } });
    if (!retry.ok) return;
    expect(retry.refreshToken).not.toBe(rotated.refreshToken);
    expect(retry.scope).toBe(GRANT.scope);
    for (const access of [first.accessToken, rotated.accessToken, retry.accessToken]) {
      expect(await validateAccessToken(access, { now: t0 + 30_000 }, store)).not.toBeNull();
    }

    // R2 was rotated by the retry: used, linked to the new tail R3.
    const r2 = await refreshOf(rotated.refreshToken);
    expect(r2?.usedAt).not.toBeNull();
    expect(r2?.rotatedTo).toBe(retry.trace.successorId);
    expect((await refreshOf(retry.refreshToken))?.usedAt).toBeNull();
    // Once the grace is over, R2 is plain reuse.
    const late = await rotateRefreshToken(rotated.refreshToken, store, t0 + 30_000 + REFRESH_RETRY_GRACE_MS + 1);
    expect(late).toMatchObject({ ok: false, reuse: true });
  });

  it('a multi-hop retry: A→B→C, A presented again within the grace mints from C', async () => {
    const t0 = Date.now();
    const a = await issueAccessAndRefresh(GRANT, store, t0);
    const b = await rotateRefreshToken(a.refreshToken, store, t0);
    if (!b.ok) throw new Error('A→B failed');
    const c = await rotateRefreshToken(b.refreshToken, store, t0 + 10_000);
    if (!c.ok) throw new Error('B→C failed');

    const retry = await rotateRefreshToken(a.refreshToken, store, t0 + 20_000);
    expect(retry).toMatchObject({ ok: true, trace: { outcome: 'retried', hops: 2 } });
    if (!retry.ok) return;
    expect((await refreshOf(c.refreshToken))?.rotatedTo).toBe(retry.trace.successorId);
    expect(await validateAccessToken(retry.accessToken, { now: t0 + 20_000 }, store)).not.toBeNull();
    // The new tail rotates normally.
    const next = await rotateRefreshToken(retry.refreshToken, store, t0 + 21_000);
    expect(next).toMatchObject({ ok: true, trace: { outcome: 'rotated' } });
  });

  it('a retry after the grace is reuse: the lineage is revoked', async () => {
    const t0 = Date.now();
    const first = await issueAccessAndRefresh(GRANT, store, t0);
    const rotated = await rotateRefreshToken(first.refreshToken, store, t0);
    if (!rotated.ok) throw new Error('rotation failed');

    const later = t0 + REFRESH_RETRY_GRACE_MS + 1;
    const reuse = await rotateRefreshToken(first.refreshToken, store, later);
    expect(reuse).toMatchObject({ ok: false, error: 'invalid_grant', reuse: true, trace: { outcome: 'reuse', hops: 0 } });
    expect((await refreshOf(rotated.refreshToken))?.usedAt).not.toBeNull();
    expect(await validateAccessToken(rotated.accessToken, { now: later }, store)).toBeNull();
    // The revoked tail is not retried even within the grace of its revocation.
    expect(await rotateRefreshToken(rotated.refreshToken, store)).toMatchObject({ ok: false, reuse: true });
  });

  it('a chain longer than REFRESH_RETRY_MAX_HOPS links is reuse', async () => {
    const t0 = Date.now();
    const first = await issueAccessAndRefresh(GRANT, store, t0);
    let current = first.refreshToken;
    for (let i = 0; i <= REFRESH_RETRY_MAX_HOPS; i++) {
      const rot = await rotateRefreshToken(current, store, t0 + i);
      if (!rot.ok) throw new Error(`rotation ${i} failed`);
      current = rot.refreshToken;
    }
    const reuse = await rotateRefreshToken(first.refreshToken, store, t0 + 1000);
    expect(reuse).toMatchObject({ ok: false, reuse: true, trace: { hops: REFRESH_RETRY_MAX_HOPS } });
    expect(await rotateRefreshToken(current, store, t0 + 1000)).toMatchObject({ ok: false });
  });

  it('concurrent refreshes with one token: the claim loser gets a pair from the winner’s successor', async () => {
    const first = await issueAccessAndRefresh(GRANT, store);
    const [x, y] = await Promise.all([
      rotateRefreshToken(first.refreshToken, store),
      rotateRefreshToken(first.refreshToken, store),
    ]);
    expect(x.ok && y.ok).toBe(true);
    if (!x.ok || !y.ok) return;
    expect([x.trace.outcome, y.trace.outcome].sort()).toEqual(['retried', 'rotated']);
    expect(x.refreshToken).not.toBe(y.refreshToken);
    expect(await validateAccessToken(x.accessToken, {}, store)).not.toBeNull();
    expect(await validateAccessToken(y.accessToken, {}, store)).not.toBeNull();
  });
});

describe('revokeLineage — scoped to one lineage', () => {
  const later = () => Date.now() + REFRESH_RETRY_GRACE_MS + 1;

  it('reuse revokes only its own lineage; another lineage of the same grant keeps working', async () => {
    const one = await issueAccessAndRefresh(GRANT, store);
    const two = await issueAccessAndRefresh(GRANT, store);
    const oneRotated = await rotateRefreshToken(one.refreshToken, store);
    if (!oneRotated.ok) throw new Error('rotation failed');

    const at = later();
    expect(await rotateRefreshToken(one.refreshToken, store, at)).toMatchObject({ reuse: true });
    expect(await validateAccessToken(one.accessToken, { now: at }, store)).toBeNull();
    expect(await validateAccessToken(oneRotated.accessToken, { now: at }, store)).toBeNull();

    expect(await validateAccessToken(two.accessToken, { now: at }, store)).not.toBeNull();
    expect(await rotateRefreshToken(two.refreshToken, store, at)).toMatchObject({
      ok: true,
      trace: { outcome: 'rotated' },
    });
  });

  it('also revokes the grant’s access tokens that record no refresh row, and nothing of other grants', async () => {
    const legacy = 'legacy-access-token';
    const otherClient = 'legacy-other-client';
    const otherAudience = 'legacy-other-audience';
    const expiresAt = new Date(Date.now() + ACCESS_TTL_MS);
    await store.insertAccessToken({ ...GRANT, tokenHash: hashToken(legacy), expiresAt });
    await store.insertAccessToken({ ...GRANT, oauthClientId: 'client-pk-2', tokenHash: hashToken(otherClient), expiresAt });
    await store.insertAccessToken({ ...GRANT, audience: 'https://other.example', tokenHash: hashToken(otherAudience), expiresAt });

    const first = await issueAccessAndRefresh(GRANT, store);
    await rotateRefreshToken(first.refreshToken, store);
    const at = later();
    expect(await rotateRefreshToken(first.refreshToken, store, at)).toMatchObject({ reuse: true });

    expect(await validateAccessToken(legacy, { now: at }, store)).toBeNull();
    expect(await validateAccessToken(otherClient, { now: at }, store)).not.toBeNull();
    expect(await validateAccessToken(otherAudience, { now: at }, store)).not.toBeNull();
  });
});
