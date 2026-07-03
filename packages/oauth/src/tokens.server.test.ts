import { beforeEach, describe, expect, it } from 'vitest';
import { ACCESS_TTL_MS, REFRESH_TTL_MS } from './constants.js';
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
  workspaceId: 'ws1',
  role: 'editor',
  oauthClientId: 'client-pk-1',
  scope: 'mcp:whoami apps:read',
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
    expect(claims?.workspaceId).toBe('ws1');
    expect(claims?.role).toBe('editor');
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

  it('detects reuse and burns the whole lineage', async () => {
    const first = await issueAccessAndRefresh(GRANT, store); // A1 + R1
    const rotated = await rotateRefreshToken(first.refreshToken, store); // R1 -> R2 (+ A2)
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    // Replaying R1 (already used) is reuse.
    const reuse = await rotateRefreshToken(first.refreshToken, store);
    expect(reuse.ok).toBe(false);
    if (!reuse.ok) expect(reuse.reuse).toBe(true);

    // Lineage burned: the successor R2 can no longer rotate…
    const r2 = await rotateRefreshToken(rotated.refreshToken, store);
    expect(r2.ok).toBe(false);

    // …and every access token from the grant is revoked.
    expect(await validateAccessToken(first.accessToken, {}, store)).toBeNull();
    expect(await validateAccessToken(rotated.accessToken, {}, store)).toBeNull();
  });

  it('rejects an unknown refresh token', async () => {
    const rot = await rotateRefreshToken('never-minted', store);
    expect(rot.ok).toBe(false);
    if (!rot.ok) expect(rot.reuse).toBe(false);
  });

  it('claims a rotation atomically: the second claim on the same token loses', async () => {
    const first = await issueAccessAndRefresh(GRANT, store); // A1 + R1
    const row = await store.findRefreshTokenByHash(
      hashToken(first.refreshToken)
    );
    expect(row).not.toBeNull();
    if (!row) return;
    // First claim wins, the second (concurrent) claim on the SAME row loses —
    // this is what stops a double-spend when two refreshes race.
    expect(await store.claimRefreshForRotation(row.id)).toBe(true);
    expect(await store.claimRefreshForRotation(row.id)).toBe(false);
  });
});
