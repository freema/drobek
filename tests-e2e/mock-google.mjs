#!/usr/bin/env node
/**
 * Mock Google OIDC provider — tests-e2e ONLY. Never ships in the app runtime
 * or its Docker image; the web app reaches it purely via env-driven URLs
 * (GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL / GOOGLE_USERINFO_URL — config, not a
 * code seam; ROADMAP §4).
 *
 * Endpoints (dependency-free node:http):
 *   GET  /authorize  — minimal consent page with an Approve button. The form
 *                      POSTs back to /authorize, which issues a single-use
 *                      code bound to the canned identity and 302s to
 *                      redirect_uri?code=…&state=….
 *   POST /token      — swaps code → access_token (JSON, Bearer).
 *   GET  /userinfo   — returns {sub, email, email_verified} for the Bearer
 *                      access_token.
 *   GET  /           — 200 "mock-google ok" readiness probe.
 *
 * CANNED-IDENTITY CONTROL (per flow) — append query params to the /authorize
 * request (they prefill the consent form; the form fields are also editable in
 * the browser, so a Playwright test can simply fill them before Approve):
 *   mock_email          desired userinfo email        (default mock-user@example.com)
 *   mock_email_verified "0"/"false" → email_verified=false   (default true)
 *   mock_sub            desired OIDC subject          (default "mock-sub-<email>")
 *   mock_approve        "1" → skip the consent page and 302 immediately
 *                       (handy for pure-API tests)
 * The identity is stored against the issued code at approval time; /token
 * moves it to the access_token; /userinfo returns it.
 *
 * Config: MOCK_GOOGLE_PORT (default 3049), listens on 0.0.0.0 so both the
 * host browser (localhost:3049) and the web container
 * (host.docker.internal:3049) can reach it.
 *
 * Run: `task mock:google` (foreground) — the @local Playwright spec
 * (tests/auth-google.spec.ts) spawns its own instance when none is running.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_GOOGLE_PORT || 3049);

/** code → identity (single-use) */
const codes = new Map();
/** access_token → identity */
const tokens = new Map();

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function identityFromParams(params) {
  const email = params.get('mock_email')?.trim() || 'mock-user@example.com';
  const verifiedRaw = (params.get('mock_email_verified') ?? '').trim().toLowerCase();
  const email_verified = !(verifiedRaw === '0' || verifiedRaw === 'false');
  // Default sub derives from the FINAL email (i.e. after any consent-form
  // edit), so distinct emails naturally get distinct subs unless a test pins
  // mock_sub explicitly.
  const sub = params.get('mock_sub')?.trim() || `mock-sub-${email}`;
  return { sub, email, email_verified };
}

function issueCodeAndRedirect(res, params) {
  const redirectUri = params.get('redirect_uri');
  const state = params.get('state') ?? '';
  if (!redirectUri) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('missing redirect_uri');
    return;
  }
  const code = randomBytes(16).toString('hex');
  codes.set(code, identityFromParams(params));
  const sep = redirectUri.includes('?') ? '&' : '?';
  const location = `${redirectUri}${sep}code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  res.writeHead(302, { location });
  res.end();
}

function consentPage(params) {
  const identity = identityFromParams(params);
  const hidden = (name) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(params.get(name) ?? '')}">`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Mock Google consent</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 24rem; margin: 3rem auto;">
  <h1>Mock Google</h1>
  <p>Sign in to <b>${escapeHtml(params.get('client_id') ?? 'unknown client')}</b>?</p>
  <form method="post" action="/authorize">
    ${hidden('redirect_uri')}
    ${hidden('state')}
    <p><label>Google email
      <input name="mock_email" value="${escapeHtml(identity.email)}" style="width:100%">
    </label></p>
    <p><label>Email verified
      <input name="mock_email_verified" value="${identity.email_verified ? '1' : '0'}" style="width:100%">
    </label></p>
    <p><label>Google sub
      <input name="mock_sub" value="${escapeHtml(params.get('mock_sub') ?? '')}"
        placeholder="empty = derived from the email" style="width:100%">
    </label></p>
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('mock-google ok');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/authorize') {
    if (url.searchParams.get('mock_approve') === '1') {
      issueCodeAndRedirect(res, url.searchParams);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(consentPage(url.searchParams));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/authorize') {
    const params = new URLSearchParams(await readBody(req));
    issueCodeAndRedirect(res, params);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/token') {
    const params = new URLSearchParams(await readBody(req));
    const code = params.get('code') ?? '';
    const identity = codes.get(code);
    if (params.get('grant_type') !== 'authorization_code' || !identity) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant' }));
      return;
    }
    codes.delete(code); // single-use
    const accessToken = randomBytes(24).toString('hex');
    tokens.set(accessToken, identity);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: 'mock-id-token',
      })
    );
    return;
  }

  if (req.method === 'GET' && url.pathname === '/userinfo') {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const identity = tokens.get(token);
    if (!identity) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(identity));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`mock-google listening on http://0.0.0.0:${PORT}`);
});
