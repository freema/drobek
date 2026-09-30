#!/usr/bin/env node
/**
 * Mock OpenID Connect provider — tests-e2e ONLY (NSO-351). Never ships in the
 * image. The oidc module reaches it like any IdP: an app's
 * `providers.oidc.issuer` (or AUTH_OIDC_ISSUER) names it, and the dev compose
 * lets the module call it over http from the container
 * (AUTH_OIDC_DEV_ORIGINS=http://host.docker.internal:3050 for discovery, token
 * and keys, http://localhost:3050 for the authorization endpoint; ignored in
 * production).
 *
 * Endpoints (dependency-free node:http + node:crypto):
 *   GET  /.well-known/openid-configuration — discovery (issuer = MOCK_OIDC_ISSUER)
 *   GET  /jwks       — the RS256 public key made at start (a new `kid` per start)
 *   GET  /authorize  — a consent page (or `mock_approve=1`: 302 at once); needs
 *                      response_type=code, client_id, redirect_uri, state,
 *                      nonce and an S256 code_challenge
 *   POST /authorize  — the consent form → 302 redirect_uri?code=…&state=…&iss=…
 *   POST /token      — code → { id_token (RS256, nonce, aud = client_id),
 *                      access_token }; checks the client (basic or post, secret
 *                      MOCK_OIDC_CLIENT_SECRET), the redirect_uri and the PKCE
 *                      verifier; a code works once
 *   GET  /userinfo   — the identity for the Bearer access token
 *   GET  /           — "mock-oidc ok"
 *
 * Canned identity per flow — /authorize query params (they prefill the
 * consent form): mock_email (default mock-user@example.com),
 * mock_email_verified ("0"/"false" → false), mock_sub (default
 * "mock-sub-<email>"), mock_name, mock_email_in=userinfo (the address only
 * in /userinfo, not in the ID token), mock_approve=1.
 *
 * Config: MOCK_OIDC_PORT (3050); MOCK_OIDC_ISSUER — the issuer and the
 * server-side endpoints (default http://host.docker.internal:<port>, what the
 * drobek container reaches); MOCK_OIDC_BROWSER_URL — the authorization
 * endpoint's origin, opened by the browser (default http://localhost:<port>);
 * MOCK_OIDC_CLIENT_SECRET (default local-dev-secret).
 *
 * Run: `task mock:oidc`. `node tests-e2e/mock-oidc.mjs --self-check` runs one
 * sign-in against itself (discovery → authorize → token → signature, nonce and
 * PKCE checked) and exits 0.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, timingSafeEqual, verify, createPublicKey } from 'node:crypto';
import { createServer } from 'node:http';

const SELF_CHECK = process.argv.includes('--self-check');
const PORT = SELF_CHECK ? 0 : Number(process.env.MOCK_OIDC_PORT || 3050);
const SECRET = process.env.MOCK_OIDC_CLIENT_SECRET || 'local-dev-secret';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = randomBytes(6).toString('hex');
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };

let issuer = '';
let browserUrl = '';

/** code → the authorization request + identity (single use) */
const codes = new Map();
/** access_token → identity */
const tokens = new Map();

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const sha256url = (v) => createHash('sha256').update(v).digest('base64url');
const sameText = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

function signIdToken(claims) {
  const input = `${b64url({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64url(claims)}`;
  return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function identityFrom(params) {
  const email = params.get('mock_email')?.trim() || 'mock-user@example.com';
  const verifiedRaw = (params.get('mock_email_verified') ?? '').trim().toLowerCase();
  return {
    sub: params.get('mock_sub')?.trim() || `mock-sub-${email}`,
    email,
    email_verified: !(verifiedRaw === '0' || verifiedRaw === 'false'),
    name: params.get('mock_name')?.trim() || 'Mock User',
    emailIn: params.get('mock_email_in') === 'userinfo' ? 'userinfo' : 'id_token',
  };
}

const REQUIRED = ['response_type', 'client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge', 'code_challenge_method'];

function badAuthorize(params) {
  for (const k of REQUIRED) if (!params.get(k)) return `missing ${k}`;
  if (params.get('response_type') !== 'code') return 'response_type must be code';
  if (params.get('code_challenge_method') !== 'S256') return 'code_challenge_method must be S256';
  return null;
}

function issueCode(res, params) {
  const bad = badAuthorize(params);
  if (bad) return text(res, 400, bad);
  const code = randomBytes(16).toString('hex');
  codes.set(code, {
    clientId: params.get('client_id'),
    redirectUri: params.get('redirect_uri'),
    nonce: params.get('nonce'),
    challenge: params.get('code_challenge'),
    identity: identityFrom(params),
  });
  const to = new URL(params.get('redirect_uri'));
  to.searchParams.set('code', code);
  to.searchParams.set('state', params.get('state'));
  to.searchParams.set('iss', issuer);
  res.writeHead(302, { location: to.toString() });
  res.end();
}

function consentPage(params) {
  const id = identityFrom(params);
  const hidden = REQUIRED.map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params.get(k) ?? '')}">`).join('\n    ');
  const field = (name, label, value) => `<p><label>${label} <input name="${name}" value="${escapeHtml(value)}" style="width:100%"></label></p>`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Mock OIDC sign-in</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 24rem; margin: 3rem auto;">
  <h1>Mock OIDC</h1>
  <p>Sign in to <b>${escapeHtml(params.get('client_id') ?? 'unknown client')}</b>?</p>
  <form method="post" action="/authorize">
    ${hidden}
    <input type="hidden" name="mock_email_in" value="${id.emailIn}">
    ${field('mock_email', 'Email', id.email)}
    ${field('mock_email_verified', 'Email verified', id.email_verified ? '1' : '0')}
    ${field('mock_sub', 'Subject', params.get('mock_sub') ?? '')}
    ${field('mock_name', 'Name', id.name)}
    <button type="submit" style="padding:0.5rem 1.5rem">Approve</button>
  </form>
</body>
</html>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 65536) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function text(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(body);
}

/** The client of a token request: HTTP Basic (form-encoded parts) or client_id + client_secret in the body. */
function clientOf(req, form) {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Basic ')) {
    const [id, secret] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
    const decode = (v) => decodeURIComponent(String(v ?? '').replace(/\+/g, ' '));
    return { id: decode(id), secret: decode(secret) };
  }
  return { id: form.get('client_id') ?? '', secret: form.get('client_secret') ?? '' };
}

async function token(req, res) {
  const form = new URLSearchParams(await readBody(req));
  const grant = codes.get(form.get('code') ?? '');
  if (form.get('grant_type') !== 'authorization_code' || !grant) return json(res, 400, { error: 'invalid_grant' });
  codes.delete(form.get('code'));
  const client = clientOf(req, form);
  if (client.id !== grant.clientId || !sameText(client.secret, SECRET)) return json(res, 401, { error: 'invalid_client' });
  if (form.get('redirect_uri') !== grant.redirectUri) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri' });
  if (sha256url(form.get('code_verifier') ?? '') !== grant.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'pkce' });
  const { identity } = grant;
  const now = Math.floor(Date.now() / 1000);
  const accessToken = randomBytes(24).toString('hex');
  tokens.set(accessToken, identity);
  const claims = { iss: issuer, sub: identity.sub, aud: grant.clientId, iat: now, exp: now + 300, nonce: grant.nonce, name: identity.name };
  if (identity.emailIn === 'id_token') Object.assign(claims, { email: identity.email, email_verified: identity.email_verified });
  return json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 3600, id_token: signIdToken(claims) });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://mock');
  try {
    if (req.method === 'GET' && url.pathname === '/') return text(res, 200, 'mock-oidc ok');
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${browserUrl}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        scopes_supported: ['openid', 'email', 'profile'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
    }
    if (req.method === 'GET' && url.pathname === '/jwks') return json(res, 200, { keys: [JWK] });
    if (req.method === 'GET' && url.pathname === '/authorize') {
      if (url.searchParams.get('mock_approve') === '1') return issueCode(res, url.searchParams);
      const bad = badAuthorize(url.searchParams);
      if (bad) return text(res, 400, bad);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(consentPage(url.searchParams));
    }
    if (req.method === 'POST' && url.pathname === '/authorize') return issueCode(res, new URLSearchParams(await readBody(req)));
    if (req.method === 'POST' && url.pathname === '/token') return await token(req, res);
    if (req.method === 'GET' && url.pathname === '/userinfo') {
      const auth = req.headers.authorization ?? '';
      const identity = tokens.get(auth.startsWith('Bearer ') ? auth.slice(7) : '');
      if (!identity) return json(res, 401, { error: 'invalid_token' });
      return json(res, 200, { sub: identity.sub, email: identity.email, email_verified: identity.email_verified, name: identity.name });
    }
    return text(res, 404, 'not found');
  } catch {
    return text(res, 400, 'bad request');
  }
});

/** One sign-in against this server, the way the oidc module does it. */
async function selfCheck() {
  const client = 'self-check';
  const doc = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
  if (doc.issuer !== issuer) throw new Error('discovery issuer');
  const verifier = randomBytes(32).toString('base64url');
  const nonce = randomBytes(12).toString('base64url');
  const authorize = new URL(doc.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: client, redirect_uri: 'https://dash.example/cb', scope: 'openid email', state: 's1', nonce, code_challenge: sha256url(verifier), code_challenge_method: 'S256', mock_approve: '1', mock_email: 'ana@example.com' })) {
    authorize.searchParams.set(k, v);
  }
  const back = new URL((await fetch(authorize, { redirect: 'manual' })).headers.get('location'));
  if (back.searchParams.get('state') !== 's1' || back.searchParams.get('iss') !== issuer) throw new Error('authorize redirect');
  const exchange = (codeVerifier) =>
    fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${client}:${SECRET}`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: 'https://dash.example/cb', code_verifier: codeVerifier }),
    });
  const tokenRes = await exchange(verifier);
  if (tokenRes.status !== 200) throw new Error(`token ${tokenRes.status}`);
  const { id_token: idToken } = await tokenRes.json();
  const [h, p, s] = idToken.split('.');
  const key = createPublicKey({ key: (await (await fetch(doc.jwks_uri)).json()).keys[0], format: 'jwk' });
  if (!verify('sha256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) throw new Error('signature');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  if (claims.nonce !== nonce || claims.aud !== client || claims.email !== 'ana@example.com') throw new Error('claims');
  if ((await exchange(verifier)).status !== 400) throw new Error('a code works twice');
  console.log('mock-oidc self-check ok');
}

server.listen(PORT, SELF_CHECK ? '127.0.0.1' : '0.0.0.0', () => {
  const port = server.address().port;
  issuer = SELF_CHECK ? `http://127.0.0.1:${port}` : (process.env.MOCK_OIDC_ISSUER || `http://host.docker.internal:${port}`).replace(/\/+$/, '');
  browserUrl = SELF_CHECK ? issuer : (process.env.MOCK_OIDC_BROWSER_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  if (!SELF_CHECK) {
    console.log(`mock-oidc listening on http://0.0.0.0:${port} (issuer ${issuer}, authorize ${browserUrl}/authorize)`);
    return;
  }
  selfCheck().then(
    () => server.close(() => process.exit(0)),
    (err) => {
      console.error(`mock-oidc self-check failed: ${err.message}`);
      process.exit(1);
    }
  );
});
