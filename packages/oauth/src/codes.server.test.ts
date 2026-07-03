import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { consumeAuthCode, issueAuthCode } from './codes.server.js';
import { AUTH_CODE_TTL_MS } from './constants.js';
import { createMemoryOAuthStore, type OAuthStore } from './store.server.js';

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const REDIRECT = 'http://localhost:9999/callback';

let store: OAuthStore;

function issue(now = Date.now()) {
  return issueAuthCode(
    {
      clientId: 'client-abc',
      userId: 'user-1',
      workspaceId: 'ws-1',
      role: 'editor',
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      scope: 'mcp:whoami apps:read',
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
  it('consumes a valid code once and binds the grant', async () => {
    const code = await issue();
    const res = await consumeAuthCode(
      { code, redirectUri: REDIRECT, codeVerifier: VERIFIER, clientId: 'client-abc' },
      store
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.row.userId).toBe('user-1');
      expect(res.row.workspaceId).toBe('ws-1');
      expect(res.row.role).toBe('editor');
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
