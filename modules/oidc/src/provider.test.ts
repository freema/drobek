/**
 * The oidc provider against a fake IdP (no network): discovery, the code
 * exchange (both client authentications, PKCE), the ID token checks, the key
 * cache, where the address comes from, trustEmail, the env fallback, and that
 * nothing of the client secret reaches a log line or an error.
 */
import { createHash, createHmac, createPublicKey, generateKeyPairSync, randomBytes, sign, constants, type KeyObject } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthProvider, AuthProviderBeginInput, AuthProviderCallbackInput } from '@drobek/modules';
import type { OidcConfig } from './config.js';
import type { IdpRequest, IdpResponse } from './http.js';
import { OidcError } from './errors.js';
import { createOidcProvider } from './provider.js';

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'client-123';
const SECRET = 'super-secret-value-9f8e7d';
const REDIRECT = 'https://dash.drobek.test/__drobek/auth/callback/oidc';

type Alg = 'RS256' | 'ES256' | 'PS256';

function keyPair(alg: Alg, kid: string): { kid: string; alg: Alg; privateKey: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = alg === 'ES256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, alg, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg } };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: KeyObject | null, alg: string): string {
  const input = `${b64(header)}.${b64(claims)}`;
  if (alg === 'none' || !key) return `${input}.`;
  const data = Buffer.from(input);
  if (alg === 'HS256') return `${input}.${createHmac('sha256', createPublicKey(key).export({ type: 'spki', format: 'pem' })).update(data).digest('base64url')}`;
  const sig =
    alg === 'ES256'
      ? sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })
      : alg === 'PS256'
        ? sign('sha256', data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST })
        : sign('sha256', data, key);
  return `${input}.${sig.toString('base64url')}`;
}

/** A fake IdP answering IdpFetch requests; tests tweak its state per case. */
class FakeIdp {
  now = Date.UTC(2026, 8, 30, 12, 0, 0);
  discovery: Record<string, unknown> = {};
  keys = [keyPair('RS256', 'k1')];
  signer = this.keys[0];
  requests: IdpRequest[] = [];
  /** code → { challenge, nonce } from the authorize URL. */
  codes = new Map<string, { challenge: string; nonce: string }>();
  claims: Record<string, unknown> = {};
  header: Record<string, unknown> | null = null;
  userinfo: Record<string, unknown> | null = null;
  tokenStatus = 200;

  constructor(readonly issuer = ISSUER) {
    this.reset();
  }

  reset() {
    this.discovery = {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize?tenant=x`,
      token_endpoint: `${this.issuer}/token`,
      jwks_uri: `${this.issuer}/jwks`,
      userinfo_endpoint: `${this.issuer}/userinfo`,
      code_challenge_methods_supported: ['S256'],
      id_token_signing_alg_values_supported: ['RS256', 'ES256', 'PS256', 'HS256', 'none'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    };
    this.claims = { email: 'Ana@Acme.example', email_verified: true, name: 'Ana Nováková' };
  }

  count(path: string) {
    return this.requests.filter((r) => r.url.pathname === path).length;
  }

  fetch = async (req: IdpRequest): Promise<IdpResponse> => {
    this.requests.push(req);
    const json = (status: number, body: unknown): IdpResponse => ({ status, body: Buffer.from(JSON.stringify(body)) });
    const path = req.url.pathname;
    if (path === '/.well-known/openid-configuration') return json(200, this.discovery);
    if (path === '/jwks') return json(200, { keys: this.keys.map((k) => k.jwk) });
    if (path === '/token') {
      if (this.tokenStatus !== 200) return json(this.tokenStatus, { error: 'invalid_client', error_description: `bad secret for ana@acme.example` });
      const form = new URLSearchParams(req.body);
      const grant = this.codes.get(form.get('code') ?? '');
      if (!grant) return json(400, { error: 'invalid_grant' });
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) return json(400, { error: 'invalid_grant' });
      const s = this.signer;
      const iat = Math.floor(this.now / 1000);
      const token = signJwt(this.header ?? { alg: s.alg, kid: s.kid, typ: 'JWT' }, { iss: this.issuer, sub: 'sub-1', aud: CLIENT_ID, iat, exp: iat + 300, nonce: grant.nonce, ...this.claims }, s.privateKey, String((this.header ?? { alg: s.alg }).alg));
      return json(200, { access_token: 'at-1', token_type: 'Bearer', id_token: token });
    }
    if (path === '/userinfo') {
      if (req.headers.authorization !== 'Bearer at-1') return json(401, { error: 'invalid_token' });
      return json(200, this.userinfo ?? { sub: 'sub-1' });
    }
    return json(404, {});
  };

  /** What the browser does at the IdP: remember the challenge and nonce under a new code. */
  authorize(url: string): string {
    const u = new URL(url);
    const code = randomBytes(8).toString('hex');
    this.codes.set(code, { challenge: u.searchParams.get('code_challenge')!, nonce: u.searchParams.get('nonce')! });
    return code;
  }
}

interface LogLine {
  level: string;
  message: string;
  meta?: unknown;
}

let idp: FakeIdp;
let provider: AuthProvider<OidcConfig>;
let logs: LogLine[];
let appSecret: string | null;

const log = {
  debug: (message: string, meta?: unknown) => logs.push({ level: 'debug', message, meta }),
  info: (message: string, meta?: unknown) => logs.push({ level: 'info', message, meta }),
  warn: (message: string, meta?: unknown) => logs.push({ level: 'warn', message, meta }),
  error: (message: string, meta?: unknown) => logs.push({ level: 'error', message, meta }),
};

function base(config: Partial<OidcConfig>, env: Record<string, string> = {}) {
  return {
    app: { id: 'app_1', slug: 'handbook', workspaceId: 'ws_1' },
    config: config as OidcConfig,
    secrets: {
      get: async (name: string) => {
        expect(name).toBe('OIDC_CLIENT_SECRET');
        return appSecret ?? env.AUTH_OIDC_CLIENT_SECRET ?? null;
      },
    },
    env,
    redirectUri: REDIRECT,
    state: 'st_1.sig',
    nonce: randomBytes(12).toString('base64url'),
    log,
  };
}

const VERIFIER = randomBytes(32).toString('base64url');
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const APP_CONFIG: Partial<OidcConfig> = { issuer: ISSUER, clientId: CLIENT_ID };

async function begin(config: Partial<OidcConfig> = APP_CONFIG, env: Record<string, string> = {}) {
  const input = { ...base(config, env), codeChallenge: CHALLENGE, codeChallengeMethod: 'S256' } as AuthProviderBeginInput<OidcConfig>;
  const { url } = await provider.begin(input);
  return { url, input };
}

/** begin → the IdP → callback, as auth drives it. */
async function signIn(config: Partial<OidcConfig> = APP_CONFIG, env: Record<string, string> = {}, query: Record<string, string> = {}) {
  const { url, input } = await begin(config, env);
  const code = idp.authorize(url);
  const cb = { ...input, query: { code, state: input.state, ...query }, body: null, codeVerifier: VERIFIER } as unknown as AuthProviderCallbackInput<OidcConfig>;
  return provider.callback(cb);
}

async function failure(work: Promise<unknown>): Promise<OidcError> {
  const err = await work.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(OidcError);
  return err as OidcError;
}

beforeEach(() => {
  idp = new FakeIdp();
  logs = [];
  appSecret = SECRET;
  provider = createOidcProvider({ fetch: idp.fetch, now: () => idp.now, discoveryCacheSec: () => 60 });
});

describe('discovery', () => {
  it('builds the authorization URL from the discovery document and caches the document', async () => {
    const { url, input } = await begin({ ...APP_CONFIG, prompt: 'select_account' });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      tenant: 'x',
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      scope: 'openid email profile',
      state: input.state,
      nonce: input.nonce,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    await begin();
    expect(idp.count('/.well-known/openid-configuration')).toBe(1);
    idp.now += 61_000;
    await begin();
    expect(idp.count('/.well-known/openid-configuration')).toBe(2);
    expect(idp.requests[0]).toMatchObject({ method: 'GET', allowPrivate: false, anyPort: false });
  });

  it('refuses a document that names another issuer (e.g. Microsoft /common)', async () => {
    idp.discovery.issuer = 'https://login.microsoftonline.com/{tenantid}/v2.0';
    const err = await failure(begin());
    expect(err.code).toBe('oidc_discovery_failed');
    expect(err.name).toBe('oidc_discovery_failed');
    expect(logs).toEqual([
      expect.objectContaining({ level: 'warn', message: 'oidc: sign-in begin failed', meta: expect.objectContaining({ app_id: 'app_1', error: 'oidc_discovery_failed' }) }),
    ]);
  });

  it('refuses a provider that lists PKCE methods without S256; one that lists none is used with S256', async () => {
    idp.discovery.code_challenge_methods_supported = ['plain'];
    expect((await failure(begin())).message).toMatch(/PKCE S256/);
    idp.reset();
    delete idp.discovery.code_challenge_methods_supported;
    provider = createOidcProvider({ fetch: idp.fetch, now: () => idp.now });
    expect(new URL((await begin()).url).searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('refuses endpoints that are not https, and an unreachable or broken document', async () => {
    idp.discovery.token_endpoint = 'http://idp.example.com/token';
    expect((await failure(begin())).message).toMatch(/token_endpoint is not https/);
    const broken = createOidcProvider({ fetch: async () => ({ status: 200, body: Buffer.from('<html>') }) });
    expect((await failure(broken.begin({ ...base(APP_CONFIG), codeChallenge: CHALLENGE, codeChallengeMethod: 'S256' }))).code).toBe('oidc_discovery_failed');
    const down = createOidcProvider({
      fetch: async () => {
        throw new Error('upstream host resolves to a private/reserved address');
      },
    });
    expect((await failure(down.begin({ ...base(APP_CONFIG), codeChallenge: CHALLENGE, codeChallengeMethod: 'S256' }))).message).toMatch(/blocked address/);
  });

  it('fails before leaving the page without a client secret (unless the IdP takes public clients)', async () => {
    appSecret = null;
    expect((await failure(begin())).message).toMatch(/no client secret/);
    (idp.discovery.token_endpoint_auth_methods_supported as string[]).push('none');
    provider = createOidcProvider({ fetch: idp.fetch, now: () => idp.now });
    await expect(begin()).resolves.toBeTruthy();
  });
});

describe('token exchange', () => {
  it('client_secret_basic: the secret in the Authorization header, the PKCE verifier in the body', async () => {
    await signIn();
    const token = idp.requests.find((r) => r.url.pathname === '/token')!;
    expect(token.method).toBe('POST');
    expect(token.headers.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')}`);
    const form = new URLSearchParams(token.body);
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'authorization_code', code: expect.any(String), redirect_uri: REDIRECT, code_verifier: VERIFIER });
  });

  it('client_secret_post when the IdP takes only that: client_id + client_secret in the body', async () => {
    idp.discovery.token_endpoint_auth_methods_supported = ['client_secret_post'];
    await signIn();
    const token = idp.requests.find((r) => r.url.pathname === '/token')!;
    expect(token.headers.authorization).toBeUndefined();
    const form = new URLSearchParams(token.body);
    expect(form.get('client_id')).toBe(CLIENT_ID);
    expect(form.get('client_secret')).toBe(SECRET);
  });

  it('a wrong PKCE verifier, an IdP error answer and another issuer in the answer fail', async () => {
    const { url, input } = await begin();
    const code = idp.authorize(url);
    const cb = (query: Record<string, string>, codeVerifier = VERIFIER) =>
      provider.callback({ ...input, query, body: null, codeVerifier } as unknown as AuthProviderCallbackInput<OidcConfig>);
    expect((await failure(cb({ code }, 'wrong-verifier'))).code).toBe('oidc_token_invalid');
    expect((await failure(cb({ error: 'access_denied' }))).message).toBe('the provider answered error=access_denied');
    expect((await failure(cb({ code, iss: 'https://evil.example' }))).message).toMatch(/another issuer/);
  });
});

describe('the ID token', () => {
  it('a valid RS256 token answers the identity (issuer, subject, lower-cased address, name)', async () => {
    await expect(signIn()).resolves.toEqual({ issuer: ISSUER, subject: 'sub-1', email: 'ana@acme.example', emailVerified: true, name: 'Ana Nováková' });
  });

  it('ES256 and PS256 tokens verify too', async () => {
    for (const alg of ['ES256', 'PS256'] as const) {
      idp.keys = [keyPair(alg, `k-${alg}`)];
      idp.signer = idp.keys[0];
      provider = createOidcProvider({ fetch: idp.fetch, now: () => idp.now });
      await expect(signIn()).resolves.toMatchObject({ subject: 'sub-1' });
    }
  });

  it('a signature by another key fails', async () => {
    const stranger = keyPair('RS256', 'k1');
    idp.signer = stranger;
    expect((await failure(signIn())).message).toBe('the ID token signature is invalid');
  });

  it('a wrong audience, several audiences without azp, an expired token, a far iat and a wrong nonce fail', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ aud: 'someone-else' }, /aud/],
      [{ aud: [CLIENT_ID, 'other'] }, /azp/],
      [{ exp: Math.floor(idp.now / 1000) - 1 }, /expired/],
      [{ iat: Math.floor(idp.now / 1000) - 3600 }, /iat/],
      [{ nonce: 'another-nonce' }, /nonce/],
      [{ iss: 'https://evil.example' }, /iss/],
    ];
    for (const [claims, reason] of cases) {
      idp.claims = { email: 'ana@acme.example', email_verified: true, ...claims };
      expect((await failure(signIn())).message, JSON.stringify(claims)).toMatch(reason);
    }
    idp.claims = { email: 'ana@acme.example', email_verified: true, aud: [CLIENT_ID, 'other'], azp: CLIENT_ID };
    await expect(signIn()).resolves.toMatchObject({ subject: 'sub-1' });
  });

  it('alg none and HS256 are refused even when the IdP advertises them', async () => {
    idp.header = { alg: 'none', kid: 'k1' };
    expect((await failure(signIn())).message).toMatch(/algorithm "none" is not allowed/);
    // HS256 keyed with the published public key — the classic key-confusion attack.
    idp.header = { alg: 'HS256', kid: 'k1' };
    expect((await failure(signIn())).message).toMatch(/algorithm "HS256" is not allowed/);
  });

  it('an algorithm the IdP does not advertise is refused', async () => {
    idp.discovery.id_token_signing_alg_values_supported = ['ES256'];
    expect((await failure(signIn())).message).toBe('the provider does not advertise RS256');
  });
});

describe('the key cache', () => {
  it('an unknown kid refetches the keys at most once a minute per issuer', async () => {
    await signIn();
    expect(idp.count('/jwks')).toBe(1);
    await signIn();
    expect(idp.count('/jwks')).toBe(1);

    // The IdP rotates: a token with a new kid refetches once (a minute after the last fetch) …
    const rotated = keyPair('RS256', 'k2');
    idp.keys = [idp.keys[0], rotated];
    idp.signer = rotated;
    idp.now += 61_000;
    await signIn();
    expect(idp.count('/jwks')).toBe(2);

    // … and a kid nobody publishes does not hammer the IdP within the minute.
    const ghost = keyPair('RS256', 'k-ghost');
    idp.signer = ghost;
    expect((await failure(signIn())).message).toMatch(/kid/);
    expect((await failure(signIn())).message).toMatch(/kid/);
    expect(idp.count('/jwks')).toBe(2);
    idp.now += 61_000;
    expect((await failure(signIn())).message).toMatch(/kid/);
    expect(idp.count('/jwks')).toBe(3);
  });
});

describe('the address', () => {
  it('comes from the ID token claim, else from userinfo (same sub, Bearer access token)', async () => {
    await signIn();
    expect(idp.count('/userinfo')).toBe(0);

    idp.claims = { name: 'Ana' };
    idp.userinfo = { sub: 'sub-1', email: 'ana@acme.example', email_verified: 'true' };
    await expect(signIn()).resolves.toMatchObject({ email: 'ana@acme.example', emailVerified: true, name: 'Ana' });
    expect(idp.count('/userinfo')).toBe(1);

    idp.userinfo = { sub: 'someone-else', email: 'eve@acme.example', email_verified: true };
    expect((await failure(signIn())).message).toMatch(/userinfo names another sub/);

    idp.userinfo = { sub: 'sub-1' };
    expect((await failure(signIn())).message).toMatch(/no e-mail address/);
  });

  it('claims.email names another claim (Entra: preferred_username)', async () => {
    idp.claims = { preferred_username: 'Ana@Acme.example' };
    await expect(signIn({ ...APP_CONFIG, claims: { email: 'preferred_username' }, trustEmail: true })).resolves.toMatchObject({ email: 'ana@acme.example', emailVerified: true });
  });

  it('trustEmail makes an unverified (or unstated) address verified', async () => {
    idp.claims = { email: 'ana@acme.example', email_verified: false };
    await expect(signIn()).resolves.toMatchObject({ emailVerified: false });
    idp.claims = { email: 'ana@acme.example' };
    await expect(signIn()).resolves.toMatchObject({ emailVerified: false });
    await expect(signIn({ ...APP_CONFIG, trustEmail: true })).resolves.toMatchObject({ emailVerified: true });
  });
});

describe('the env fallback (one IdP for the whole server)', () => {
  const ENV = { AUTH_OIDC_ISSUER: ISSUER, AUTH_OIDC_CLIENT_ID: CLIENT_ID, AUTH_OIDC_CLIENT_SECRET: SECRET };

  it('an app without an issuer uses AUTH_OIDC_ISSUER / _CLIENT_ID / _CLIENT_SECRET, and its host may be private', async () => {
    appSecret = null;
    await expect(signIn({}, ENV)).resolves.toMatchObject({ issuer: ISSUER, subject: 'sub-1' });
    expect(idp.requests.every((r) => r.allowPrivate && r.anyPort)).toBe(true);
    const token = idp.requests.find((r) => r.url.pathname === '/token')!;
    expect(token.headers.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')}`);
  });

  it("the app's own client at the server's issuer; the server's client never pairs with the app's issuer", async () => {
    await signIn({ clientId: CLIENT_ID }, { AUTH_OIDC_ISSUER: ISSUER, AUTH_OIDC_CLIENT_ID: 'server-client' });
    expect(new URLSearchParams(idp.requests.find((r) => r.url.pathname === '/token')!.body).get('code')).toBeTruthy();
    const other = new FakeIdp('https://other.example.com');
    provider = createOidcProvider({ fetch: other.fetch, now: () => other.now });
    expect((await failure(begin({ issuer: 'https://other.example.com' }, ENV))).message).toMatch(/no client id/);
    expect(other.requests).toHaveLength(0);
    expect((await failure(begin({}, {}))).message).toMatch(/no issuer/);
  });

  it('an app issuer never reaches a private address; a dev origin may use http (never in production)', async () => {
    await begin();
    expect(idp.requests[0]).toMatchObject({ allowPrivate: false });
    const dev = new FakeIdp('http://host.docker.internal:3050');
    provider = createOidcProvider({ fetch: dev.fetch, now: () => dev.now });
    expect((await failure(begin({ issuer: dev.issuer, clientId: CLIENT_ID }))).message).toMatch(/not https/);
    await begin({ issuer: dev.issuer, clientId: CLIENT_ID }, { AUTH_OIDC_DEV_ORIGINS: dev.issuer });
    expect(dev.requests[0]).toMatchObject({ allowPrivate: true, anyPort: true });
    // The cached document does not skip the check for an app without the dev origin.
    expect((await failure(begin({ issuer: dev.issuer, clientId: CLIENT_ID }))).message).toMatch(/not https/);
  });
});

describe('secrets and details stay out of errors and logs', () => {
  it('neither the client secret nor a token nor an address appears in a thrown error or a log line', async () => {
    idp.tokenStatus = 401;
    const err = await failure(signIn());
    expect(err.message).toBe('the token endpoint answered HTTP 401 (error=invalid_client)');
    idp.tokenStatus = 200;
    idp.userinfo = { sub: 'sub-1' };
    idp.claims = {};
    const noMail = await failure(signIn());
    idp.claims = { email: 'ana@acme.example', email_verified: true, nonce: 'x' };
    const badNonce = await failure(signIn());
    const text = JSON.stringify(logs) + [err, noMail, badNonce].map((e) => `${e.name} ${e.message} ${e.stack}`).join('\n');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64'));
    expect(text).not.toContain('at-1');
    expect(text).not.toContain('ana@acme.example');
    expect(logs.length).toBeGreaterThanOrEqual(3);
    expect(logs.every((l) => l.level === 'warn' && l.message === 'oidc: sign-in callback failed')).toBe(true);
  });
});
