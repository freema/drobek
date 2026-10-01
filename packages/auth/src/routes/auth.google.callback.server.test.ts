import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedis } from '../fake-redis.js';

let fake: FakeRedis;

vi.mock('@drobek/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/core')>();
  return {
    ...actual,
    getRedis: () => fake as unknown as ReturnType<typeof actual.getRedis>,
  };
});

vi.mock('../logger.server.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (err: unknown) => ({ message: String(err) }),
}));

vi.mock('../ensure-user.server.js', () => ({
  ensureUserFromGoogle: vi.fn(async () => ({ userId: 'user_1', email: 'ana@example.com' })),
}));

vi.mock('../session.server.js', () => ({
  createUserSession: vi.fn(async () => ({ setCookie: 'drobek_session=x; Path=/' })),
}));

import type { LoaderFunctionArgs } from 'react-router';
import { pkceChallenge } from '../google-oauth.server.js';
import { createUserSession } from '../session.server.js';
import { loader as callbackLoader } from './auth.google.callback.server.js';
import { loader as startLoader } from './auth.google.server.js';

const TOKEN_URL = 'https://idp.test/token';
const USERINFO_URL = 'https://idp.test/userinfo';

interface Issued {
  challenge: string;
  nonce: string;
}

/** A Google stand-in: each code carries its challenge + nonce; /token checks the verifier. */
let issued: Map<string, Issued>;
let tokenNonce: (nonce: string) => string | undefined;
let tokenCalls: number;

function jwt(payload: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc(payload)}.sig`;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function fakeGoogle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url === TOKEN_URL) {
    tokenCalls += 1;
    const params = new URLSearchParams(String(init?.body));
    const code = params.get('code') ?? '';
    const grant = issued.get(code);
    const verifier = params.get('code_verifier');
    if (!grant || !verifier || pkceChallenge(verifier) !== grant.challenge) return json(400, { error: 'invalid_grant' });
    issued.delete(code);
    return json(200, { access_token: 'at', id_token: jwt({ sub: 'g-1', nonce: tokenNonce(grant.nonce) }) });
  }
  if (url === USERINFO_URL) return json(200, { sub: 'g-1', email: 'ana@example.com', email_verified: true });
  return json(404, {});
}

function args(request: Request): LoaderFunctionArgs {
  return { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;
}

interface Started {
  state: string;
  cookie: string;
  code: string;
}

/** GET /auth/google → the state, its cookie and a code Google would issue for it. */
async function start(): Promise<Started> {
  const res = (await startLoader(args(new Request('http://localhost/auth/google')))) as Response;
  expect(res.status).toBe(302);
  const authorize = new URL(res.headers.get('Location') ?? '');
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  const code = `code-${issued.size + 1}-${Math.random()}`;
  issued.set(code, {
    challenge: authorize.searchParams.get('code_challenge') ?? '',
    nonce: authorize.searchParams.get('nonce') ?? '',
  });
  return {
    state: authorize.searchParams.get('state') ?? '',
    cookie: (res.headers.get('Set-Cookie') ?? '').split(';')[0],
    code,
  };
}

async function finish(f: Started): Promise<string | null> {
  const url = `http://localhost/auth/google/callback?code=${encodeURIComponent(f.code)}&state=${f.state}`;
  const res = (await callbackLoader(args(new Request(url, { headers: { Cookie: f.cookie } })))) as Response;
  expect(res.status).toBe(302);
  return res.headers.get('Location');
}

const key = (state: string) => `drobek:google-oauth:${state}`;

beforeEach(() => {
  fake = new FakeRedis();
  issued = new Map();
  tokenNonce = (n) => n;
  tokenCalls = 0;
  vi.stubEnv('GOOGLE_CLIENT_ID', 'client-1');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'secret-1');
  vi.stubEnv('GOOGLE_TOKEN_URL', TOKEN_URL);
  vi.stubEnv('GOOGLE_USERINFO_URL', USERINFO_URL);
  vi.stubGlobal('fetch', vi.fn(fakeGoogle));
  vi.mocked(createUserSession).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Google sign-in: PKCE, nonce and single-use state', () => {
  it('signs in with the verifier of its own state and the matching nonce, spending the record', async () => {
    expect(await finish(await start())).toBe('/me');
    expect(createUserSession).toHaveBeenCalledTimes(1);
    expect(fake.store.size).toBe(0);
  });

  it('keeps the verifier server-side: not in the cookie, only its S256 challenge on the authorize URL', async () => {
    const f = await start();
    const record = JSON.parse((await fake.get(key(f.state))) ?? '{}') as { verifier: string };
    expect(record.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.cookie).not.toContain(record.verifier);
    expect(issued.get(f.code)?.challenge).toBe(pkceChallenge(record.verifier));
    expect(await fake.ttl(key(f.state))).toBeLessThanOrEqual(600);
  });

  it('a replayed state is refused', async () => {
    const f = await start();
    const grant = issued.get(f.code);
    expect(await finish(f)).toBe('/me');
    if (grant) issued.set(f.code, grant);
    expect(await finish(f)).toBe('/login?error=google');
    expect(tokenCalls).toBe(1);
    expect(createUserSession).toHaveBeenCalledTimes(1);
  });

  it('a state without its record (expired or never begun here) is refused before the token exchange', async () => {
    const f = await start();
    await fake.del(key(f.state));
    expect(await finish(f)).toBe('/login?error=google');
    expect(tokenCalls).toBe(0);
    expect(createUserSession).not.toHaveBeenCalled();
  });

  it('a record without a verifier is refused before the token exchange', async () => {
    const f = await start();
    const { nonce } = JSON.parse((await fake.get(key(f.state))) ?? '{}') as { nonce: string };
    await fake.set(key(f.state), JSON.stringify({ nonce }), 'EX', 600);
    expect(await finish(f)).toBe('/login?error=google');
    expect(tokenCalls).toBe(0);
    expect(createUserSession).not.toHaveBeenCalled();
  });

  it("a foreign verifier (another sign-in's) is refused by the token endpoint", async () => {
    const mine = await start();
    const other = await start();
    await fake.set(key(mine.state), (await fake.get(key(other.state))) ?? '', 'EX', 600);
    expect(await finish(mine)).toBe('/login?error=google');
    expect(tokenCalls).toBe(1);
    expect(createUserSession).not.toHaveBeenCalled();
  });

  it('a code from another sign-in fails PKCE', async () => {
    const mine = await start();
    const other = await start();
    expect(await finish({ ...mine, code: other.code })).toBe('/login?error=google');
    expect(createUserSession).not.toHaveBeenCalled();
  });

  it('a nonce mismatch in the ID token is refused', async () => {
    tokenNonce = () => 'z'.repeat(43);
    expect(await finish(await start())).toBe('/login?error=google');
    expect(createUserSession).not.toHaveBeenCalled();
  });

  it('an ID token without a nonce is refused', async () => {
    tokenNonce = () => undefined;
    expect(await finish(await start())).toBe('/login?error=google');
    expect(createUserSession).not.toHaveBeenCalled();
  });

  it('a state param that does not match the cookie is refused and spends nothing', async () => {
    const f = await start();
    const other = await start();
    expect(await finish({ ...f, cookie: other.cookie })).toBe('/login?error=google');
    expect(await fake.exists(key(f.state))).toBe(1);
    expect(tokenCalls).toBe(0);
  });

  it('Redis down at the start → back to /login, no provider redirect', async () => {
    fake.failing = true;
    await expect(startLoader(args(new Request('http://localhost/auth/google')))).rejects.toMatchObject({
      status: 302,
    });
  });
});
