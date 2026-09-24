/**
 * /oauth/token authorization_code grant against a real (PGlite) database
 * (NSO-332): a failed exchange burns the code, and replaying a consumed code
 * revokes the refresh lineage + access tokens it minted. Exercises the drizzle
 * store's explicit refresh-token id (the code → lineage link).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ActionFunctionArgs } from 'react-router';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oauthRefreshTokens, users } from '@drobek/db';
import { createClient } from '../clients.server.js';
import { issueAuthCode } from '../codes.server.js';
import { validateAccessToken } from '../tokens.server.js';
import { freshDb, type TestDb } from '../test/db.js';
import { action } from './oauth.token.js';

const AUD = 'http://localhost:3041/mcp';
const REDIRECT = 'http://127.0.0.1:9999/cb';

let db: TestDb;
let close: () => Promise<void>;
let userId: string;
let clientId: string;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [u] = await db.insert(users).values({ email: 'token-route@example.test' }).returning();
  userId = u.id;
  clientId = (await createClient({ clientName: 'Replay test', redirectUris: [REDIRECT] })).clientId;
});
afterAll(async () => close());

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

async function post(form: Record<string, string>): Promise<{ status: number; body: TokenBody }> {
  const request = new Request('http://localhost:3041/oauth/token', {
    method: 'POST',
    body: new URLSearchParams(form),
  });
  const res = (await action({ request } as ActionFunctionArgs)) as Response;
  return { status: res.status, body: (await res.json()) as TokenBody };
}

async function newCode(): Promise<{ code: string; verifier: string }> {
  const verifier = randomBytes(32).toString('base64url');
  const code = await issueAuthCode({
    clientId,
    userId,
    redirectUri: REDIRECT,
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    codeChallengeMethod: 'S256',
    scope: 'read write',
    resource: AUD,
  });
  return { code, verifier };
}

function exchange(code: string, verifier: string) {
  return post({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
    client_id: clientId,
  });
}

function refresh(refreshToken: string) {
  return post({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
}

describe('POST /oauth/token — authorization code replay (NSO-332)', () => {
  it('a wrong code_verifier burns the code: the right one then gets invalid_grant', async () => {
    const { code, verifier } = await newCode();
    const wrong = await exchange(code, randomBytes(32).toString('base64url'));
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_grant');

    const right = await exchange(code, verifier);
    expect(right.status).toBe(400);
    expect(right.body.error).toBe('invalid_grant');
    expect(right.body.access_token).toBeUndefined();
  });

  it('replaying an exchanged code revokes the refresh chain and access tokens', async () => {
    const { code, verifier } = await newCode();
    const first = await exchange(code, verifier);
    expect(first.status).toBe(200);

    const rotated = await refresh(first.body.refresh_token as string);
    expect(rotated.status).toBe(200);
    expect(await validateAccessToken(rotated.body.access_token as string, { audience: AUD })).not.toBeNull();

    const replay = await exchange(code, verifier);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');

    const dead = await refresh(rotated.body.refresh_token as string);
    expect(dead.status).toBe(400);
    expect(dead.body.error).toBe('invalid_grant');
    expect(await validateAccessToken(first.body.access_token as string, { audience: AUD })).toBeNull();
    expect(await validateAccessToken(rotated.body.access_token as string, { audience: AUD })).toBeNull();

    // Every refresh token of the user is burned (used_at set), none can rotate.
    const rows = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.userId, userId));
    expect(rows.some((r) => r.id.startsWith('ac_'))).toBe(true);
    expect(rows.every((r) => r.usedAt !== null)).toBe(true);
  });
});
