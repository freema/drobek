/**
 * /oauth/token against a real (PGlite) database. authorization_code: a failed
 * exchange burns the code, and replaying a consumed code revokes the refresh
 * lineage + access tokens it minted (the drizzle store's explicit
 * refresh-token id is the code → lineage link). refresh_token: a retry within
 * the grace gets a pair, reuse after it burns that lineage only, and every
 * refresh logs one line of ids.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ActionFunctionArgs } from 'react-router';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { oauthRefreshTokens, users } from '@drobek/db';
import { createClient } from '../clients.server.js';
import { issueAuthCode } from '../codes.server.js';
import { REFRESH_RETRY_GRACE_MS } from '../constants.js';
import { hashToken } from '../crypto.server.js';
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

describe('POST /oauth/token — authorization code replay', () => {
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

describe('POST /oauth/token — refresh_token', () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    const capture = (line: unknown) => {
      lines.push(String(line));
    };
    vi.spyOn(console, 'info').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function refreshLog(): Record<string, unknown>[] {
    return lines.flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return parsed.message === 'oauth refresh' ? [parsed] : [];
      } catch {
        return [];
      }
    });
  }

  async function lineage(): Promise<TokenBody> {
    const { code, verifier } = await newCode();
    const issued = await exchange(code, verifier);
    expect(issued.status).toBe(200);
    return issued.body;
  }

  it('the same refresh token sent twice within the grace answers 200 both times', async () => {
    const first = await lineage();
    const a = await refresh(first.refresh_token as string);
    const b = await refresh(first.refresh_token as string);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.refresh_token).not.toBe(a.body.refresh_token);
    for (const res of [a, b]) {
      expect(await validateAccessToken(res.body.access_token as string, { audience: AUD })).not.toBeNull();
    }
    // The newest pair keeps rotating normally.
    expect((await refresh(b.body.refresh_token as string)).status).toBe(200);

    const logged = refreshLog();
    expect(logged.map((l) => [l.level, l.outcome])).toEqual([
      ['info', 'rotated'],
      ['info', 'retried'],
      ['info', 'rotated'],
    ]);
    expect(logged[1]).toMatchObject({
      name: 'oauth',
      userId,
      oauthClientId: expect.any(String),
      refreshTokenId: expect.any(String),
      successorId: expect.any(String),
      hops: 1,
    });
  });

  it('reuse after the grace revokes that lineage only and logs ids, never a token', async () => {
    const one = await lineage();
    const two = await lineage();
    const rotated = await refresh(one.refresh_token as string);
    expect(rotated.status).toBe(200);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + REFRESH_RETRY_GRACE_MS + 1_000);
    const reuse = await refresh(one.refresh_token as string);
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe('invalid_grant');
    expect((await refresh('never-issued')).body.error).toBe('invalid_grant');

    expect(await validateAccessToken(rotated.body.access_token as string, { audience: AUD })).toBeNull();
    expect(await validateAccessToken(two.access_token as string, { audience: AUD })).not.toBeNull();
    const twoRotated = await refresh(two.refresh_token as string);
    expect(twoRotated.status).toBe(200);

    const logged = refreshLog();
    expect(logged.map((l) => [l.level, l.outcome])).toEqual([
      ['info', 'rotated'],
      ['warn', 'reuse'],
      ['info', 'unknown'],
      ['info', 'rotated'],
    ]);
    const all = lines.join('\n');
    const raws = [one, two, rotated.body, twoRotated.body].flatMap((b) => [
      b.access_token as string,
      b.refresh_token as string,
    ]);
    for (const raw of [...raws, 'never-issued']) {
      expect(all).not.toContain(raw);
      expect(all).not.toContain(hashToken(raw));
    }
  });
});
