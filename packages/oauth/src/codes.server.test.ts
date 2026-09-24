import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { authCodeRefreshTokenId, consumeAuthCode, issueAuthCode } from './codes.server.js';
import { AUTH_CODE_TTL_MS } from './constants.js';
import { createMemoryOAuthStore, type OAuthStore } from './store.server.js';
import {
  issueAccessAndRefresh,
  rotateRefreshToken,
  validateAccessToken,
  type GrantInput,
} from './tokens.server.js';

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const REDIRECT = 'http://localhost:9999/callback';

let store: OAuthStore;

function issue(now = Date.now()) {
  return issueAuthCode(
    {
      clientId: 'client-abc',
      userId: 'user-1',
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      scope: 'read write',
      resource: 'http://localhost:3042',
    },
    store,
    now
  );
}

beforeEach(() => {
  store = createMemoryOAuthStore();
});

describe('consumeAuthCode', () => {
  it('consumes a valid code once and binds the user-level grant', async () => {
    const code = await issue();
    const res = await consumeAuthCode(
      { code, redirectUri: REDIRECT, codeVerifier: VERIFIER, clientId: 'client-abc' },
      store
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.row.userId).toBe('user-1');
      expect(res.row.scope).toBe('read write');
      // User-bound (M0-04): the code carries no workspace and no role.
      expect(res.row).not.toHaveProperty('workspaceId');
      expect(res.row).not.toHaveProperty('role');
      expect(res.row.resource).toBe('http://localhost:3042');
    }
  });

  it('is single-use: a second consume fails invalid_grant', async () => {
    const code = await issue();
    const first = await consumeAuthCode(
      { code, redirectUri: REDIRECT, codeVerifier: VERIFIER },
      store
    );
    expect(first.ok).toBe(true);

    const second = await consumeAuthCode(
      { code, redirectUri: REDIRECT, codeVerifier: VERIFIER },
      store
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe('invalid_grant');
  });

  it('rejects a redirect_uri mismatch', async () => {
    const code = await issue();
    const res = await consumeAuthCode(
      { code, redirectUri: 'http://localhost:9999/other', codeVerifier: VERIFIER },
      store
    );
    expect(res.ok).toBe(false);
  });

  it('rejects a bad PKCE verifier', async () => {
    const code = await issue();
    const res = await consumeAuthCode(
      { code, redirectUri: REDIRECT, codeVerifier: 'wrong-verifier' },
      store
    );
    expect(res.ok).toBe(false);
  });

  it('rejects a client_id mismatch', async () => {
    const code = await issue();
    const res = await consumeAuthCode(
      { code, redirectUri: REDIRECT, codeVerifier: VERIFIER, clientId: 'someone-else' },
      store
    );
    expect(res.ok).toBe(false);
  });

  it('rejects an expired code', async () => {
    const t0 = Date.now();
    const code = await issue(t0);
    const res = await consumeAuthCode(
      { code, redirectUri: REDIRECT, codeVerifier: VERIFIER },
      store,
      t0 + AUTH_CODE_TTL_MS + 1
    );
    expect(res.ok).toBe(false);
  });

  it('rejects an unknown code', async () => {
    const res = await consumeAuthCode(
      { code: 'never-issued', redirectUri: REDIRECT, codeVerifier: VERIFIER },
      store
    );
    expect(res.ok).toBe(false);
  });
});

describe('consumeAuthCode — a failed exchange burns the code (NSO-332)', () => {
  const good = { redirectUri: REDIRECT, codeVerifier: VERIFIER, clientId: 'client-abc' };
  const failures: [string, (t0: number) => { input: Partial<typeof good>; now: number }][] = [
    ['a wrong PKCE verifier', (t0) => ({ input: { codeVerifier: 'wrong-verifier' }, now: t0 })],
    [
      'a wrong redirect_uri',
      (t0) => ({ input: { redirectUri: 'http://localhost:9999/other' }, now: t0 }),
    ],
    ['a foreign client', (t0) => ({ input: { clientId: 'someone-else' }, now: t0 })],
    ['an expired code', (t0) => ({ input: {}, now: t0 + AUTH_CODE_TTL_MS + 1 })],
  ];

  for (const [name, shape] of failures) {
    it(`${name}: the next attempt with the right verifier is invalid_grant`, async () => {
      const t0 = Date.now();
      const code = await issue(t0);
      const { input, now } = shape(t0);

      const failed = await consumeAuthCode({ code, ...good, ...input }, store, now);
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error).toBe('invalid_grant');

      const retry = await consumeAuthCode({ code, ...good }, store, t0);
      expect(retry).toEqual({
        ok: false,
        error: 'invalid_grant',
        description: 'authorization code already used',
      });
    });
  }

  it('an unknown code touches nothing', async () => {
    const code = await issue();
    const unknown = await consumeAuthCode({ code: 'never-issued', ...good }, store);
    expect(unknown.ok).toBe(false);
    const real = await consumeAuthCode({ code, ...good }, store);
    expect(real.ok).toBe(true);
  });

  it('concurrent exchanges with the right verifier: exactly one wins', async () => {
    const code = await issue();
    const results = await Promise.all([
      consumeAuthCode({ code, ...good }, store),
      consumeAuthCode({ code, ...good }, store),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe('consumeAuthCode — replaying a consumed code revokes its tokens (NSO-332)', () => {
  const good = { redirectUri: REDIRECT, codeVerifier: VERIFIER, clientId: 'client-abc' };

  /** Exchange a fresh code the way the /oauth/token route does. */
  async function exchange() {
    const code = await issue();
    const consumed = await consumeAuthCode({ code, ...good }, store);
    if (!consumed.ok) throw new Error('exchange failed');
    const grant: GrantInput = {
      userId: consumed.row.userId,
      oauthClientId: 'client-pk-abc',
      scope: consumed.row.scope,
      audience: consumed.row.resource,
    };
    const tokens = await issueAccessAndRefresh(grant, store, Date.now(), {
      refreshTokenId: consumed.refreshTokenId,
    });
    return { code, consumed, tokens };
  }

  it('links the first refresh token of the lineage to the code', async () => {
    const { consumed } = await exchange();
    expect(consumed.refreshTokenId).toBe(authCodeRefreshTokenId(consumed.row.id));
    expect(await store.findRefreshTokenById(consumed.refreshTokenId)).not.toBeNull();
  });

  it('burns the whole rotated lineage and the grant access tokens', async () => {
    const { code, tokens } = await exchange();
    const rotated = await rotateRefreshToken(tokens.refreshToken, store);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    // The code comes back (even with the right verifier) → replay.
    const replay = await consumeAuthCode({ code, ...good }, store);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error).toBe('invalid_grant');

    // The rotated successor can no longer rotate…
    const next = await rotateRefreshToken(rotated.refreshToken, store);
    expect(next.ok).toBe(false);
    // …and neither access token is usable.
    expect(await validateAccessToken(tokens.accessToken, {}, store)).toBeNull();
    expect(await validateAccessToken(rotated.accessToken, {}, store)).toBeNull();
  });

  it('a replay with a wrong verifier revokes too', async () => {
    const { code, tokens } = await exchange();
    const replay = await consumeAuthCode({ code, ...good, codeVerifier: 'wrong' }, store);
    expect(replay.ok).toBe(false);
    expect((await rotateRefreshToken(tokens.refreshToken, store)).ok).toBe(false);
    expect(await validateAccessToken(tokens.accessToken, {}, store)).toBeNull();
  });

  it('replaying a code burned by a failed exchange revokes nothing', async () => {
    // A live grant of the same user + client, from an earlier code.
    const { tokens } = await exchange();

    const code = await issue();
    await consumeAuthCode({ code, ...good, codeVerifier: 'wrong' }, store);
    const replay = await consumeAuthCode({ code, ...good }, store);
    expect(replay.ok).toBe(false);

    expect(await validateAccessToken(tokens.accessToken, {}, store)).not.toBeNull();
    expect((await rotateRefreshToken(tokens.refreshToken, store)).ok).toBe(true);
  });
});
