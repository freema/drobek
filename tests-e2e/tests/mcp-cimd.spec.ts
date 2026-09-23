import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL_WEB, TARGET_PRODUCTION } from '../playwright.config';
import {
  loginViaEmail,
  resetDcrIpRateLimit,
  skipUnlessLocal,
  uniqueEmail,
} from './helpers/auth';
import {
  REDIRECT_URI,
  callTool,
  connectBearer,
  consentAndCapture,
  exchangeCode,
  mcpResource,
  pkcePair,
  rawInitialize,
} from './helpers/mcp';
import { personalWorkspaceOf, seedApp, userIdByEmail, withDb } from './helpers/seed';

/**
 * M0-04 (NSO-282) acceptance, the parts beyond the classic DCR flow:
 *  - CIMD: a Client ID Metadata Document served by the in-network proxy-echo
 *    mock (the ONLY origin OAUTH_CIMD_DEV_ORIGINS allows over http / from a
 *    private IP) → authorize → token → tools/list filtered by the granted
 *    scope; a document on any other private address, a document naming
 *    another URL, or one with a bad redirect_uri → invalid_client (shown);
 *  - DCR: the 11th registration from one IP within the hour → 429;
 *  - RS audience: a token issued for another resource → 401 invalid_token;
 *  - API keys: a drk_ key passes initialize + list_apps; revoked → 401.
 * Against a NODE_ENV=production target (the image flow, E2E_TARGET_PRODUCTION=1)
 * the dev allowance is off by design, so the same http proxy-echo documents
 * must be refused with "must use https" instead.
 */

const ECHO = 'http://proxy-echo:8099';

function cimdUrl(kind: 'cimd' | 'cimd-mismatch' | 'cimd-badredirect' = 'cimd'): string {
  return `${ECHO}/${kind}/${randomBytes(6).toString('hex')}/client.json`;
}

function authorizeUrl(clientId: string, resource: string): string {
  const { challenge } = pkcePair();
  return `/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'read',
    resource,
    state: 'cimd',
  }).toString()}`;
}

test('CIMD: a metadata-document client → consent → token → tools/list filtered by the granted scope @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const resource = await mcpResource(request);
  const clientId = cimdUrl();
  const email = uniqueEmail('cimd');
  await loginViaEmail(page, request, email);

  if (TARGET_PRODUCTION) {
    // Production ignores OAUTH_CIMD_DEV_ORIGINS: an http document is refused
    // before anything is fetched, and no client row is mirrored.
    await page.goto(authorizeUrl(clientId, resource));
    const box = page.getByTestId('oauth-error');
    await expect(box).toContainText('invalid_client');
    await expect(box).toContainText('client_id must use https');
    const rows = await withDb(async (c) =>
      (await c.query(`SELECT 1 FROM oauth_clients WHERE client_id = $1`, [clientId])).rows
    );
    expect(rows).toEqual([]);
    return;
  }

  // The client asks for read + write; the user grants only read.
  const { verifier, challenge } = pkcePair();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'read write',
    resource,
    state: 'cimd',
  });
  await page.goto(`/oauth/authorize?${params.toString()}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('drobek e2e CIMD client');
  await expect(page.getByText('proxy-echo:8099', { exact: true })).toBeVisible();
  await expect(page.getByTestId('scope-read')).toBeChecked();
  await expect(page.getByTestId('scope-write')).toBeChecked();
  await expect(page.getByTestId('scope-publish')).toBeDisabled();

  const redirect = await consentAndCapture(page, {
    clientId,
    challenge,
    resource,
    scope: 'read write',
    uncheck: ['write'],
  });
  expect(redirect.searchParams.get('iss')).toBe(BASE_URL_WEB.replace(/\/+$/, ''));
  const code = redirect.searchParams.get('code') as string;
  expect(code).toBeTruthy();

  // The token endpoint takes the URL client_id as-is.
  const tok = await exchangeCode(request, { code, verifier, clientId });
  expect(tok.status, JSON.stringify(tok.body)).toBe(200);
  expect(tok.body.scope).toBe('read');

  const { client, transport } = await connectBearer(tok.body.access_token as string);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_app', 'get_logs', 'list_apps', 'query_data', 'read_file', 'skill_info']);
    const who = await callTool(client, 'list_apps', {});
    expect(who.json.user).toEqual({ email });
    // A write tool is not callable with this grant.
    const write = await callTool(client, 'create_app', { name: 'Nope' });
    expect(write.isError).toBe(true);
  } finally {
    await transport.close();
  }

  // The client is mirrored as a cimd client and marked used.
  const row = await withDb(async (c) =>
    (await c.query(`SELECT source, last_used_at FROM oauth_clients WHERE client_id = $1`, [clientId]))
      .rows[0]
  );
  expect(row.source).toBe('cimd');
  expect(row.last_used_at).not.toBeNull();
});

test('CIMD: private-IP, non-allowed origin, mismatched client_id and bad redirect_uri → invalid_client @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const resource = await mcpResource(request);
  await loginViaEmail(page, request, uniqueEmail('cimd-neg'));

  const cases: Array<[string, RegExp]> = [
    // https, default port, but the host resolves to a PRIVATE docker IP — and
    // PROXY_ALLOWED_HOSTS (which lists proxy-echo for the BFF proxy) must not
    // widen the CIMD fetch.
    ['https://proxy-echo/cimd/x/client.json', /private or reserved/],
    ['https://mailpit/client.json', /private or reserved/],
    ['https://169.254.169.254/latest/meta-data', /private or reserved/],
    // The dev allowance is ONE exact origin: another port on the same host is out.
    ['http://proxy-echo:8098/cimd/x/client.json', /https/],
    // (Production refuses these http documents before fetching them.)
    [cimdUrl('cimd-mismatch'), TARGET_PRODUCTION ? /must use https/ : /does not match/],
    [cimdUrl('cimd-badredirect'), TARGET_PRODUCTION ? /must use https/ : /redirect_uri/],
  ];
  for (const [clientId, reason] of cases) {
    // Client errors are SHOWN (400), never redirected to an untrusted URI.
    const res = await request.get(`${BASE_URL_WEB}${authorizeUrl(clientId, resource)}`, {
      maxRedirects: 0,
    });
    expect(res.status(), clientId).toBe(400);
    await page.goto(authorizeUrl(clientId, resource));
    const box = page.getByTestId('oauth-error');
    await expect(box, clientId).toContainText('invalid_client');
    await expect(box, clientId).toContainText(reason);
  }
});

test('DCR: the 11th registration from one IP within the hour → 429 @local', async ({
  request,
}) => {
  skipUnlessLocal();
  const tag = `e2e-dcr-limit-${randomBytes(4).toString('hex')}`;
  await resetDcrIpRateLimit();
  try {
    for (let i = 1; i <= 10; i++) {
      const ok = await request.post(`${BASE_URL_WEB}/oauth/register`, {
        data: { client_name: tag, redirect_uris: [REDIRECT_URI] },
      });
      expect(ok.status(), `registration ${i}`).toBe(201);
    }
    const eleventh = await request.post(`${BASE_URL_WEB}/oauth/register`, {
      data: { client_name: tag, redirect_uris: [REDIRECT_URI] },
    });
    expect(eleventh.status()).toBe(429);
    expect(eleventh.headers()['retry-after']).toBeTruthy();
    expect(((await eleventh.json()) as { error: string }).error).toBe('rate_limited');
  } finally {
    // Leave no unused clients (they count toward the unused-client cap) and
    // no exhausted bucket behind.
    await withDb((c) => c.query(`DELETE FROM oauth_clients WHERE client_name = $1`, [tag]));
    await resetDcrIpRateLimit();
  }
});

test('RS audience: a token issued for another resource → 401 invalid_token @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('aud');
  await loginViaEmail(page, request, email);
  const userId = await userIdByEmail(email);

  // /authorize refuses a foreign resource (invalid_target), so a token with a
  // foreign audience can only exist in the store — seed one straight there.
  const token = randomBytes(32).toString('base64url');
  await withDb((c) =>
    c.query(
      `INSERT INTO oauth_access_tokens (id, token_hash, user_id, scope, audience, expires_at)
       VALUES ($1, $2, $3, 'read', 'https://other.example/mcp', now() + interval '1 hour')`,
      [
        `tok${randomBytes(8).toString('hex')}`,
        createHash('sha256').update(token).digest('hex'),
        userId,
      ]
    )
  );
  const res = await rawInitialize(request, { Authorization: `Bearer ${token}` });
  expect(res.status()).toBe(401);
  expect(res.headers()['www-authenticate']).toContain('error="invalid_token"');
  expect(res.headers()['www-authenticate']).toContain('resource_metadata=');
});

test('API key: a drk_ key passes initialize + list_apps; revoked → 401 @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('apikey');
  await loginViaEmail(page, request, email);
  const personal = await personalWorkspaceOf(email);
  const app = await seedApp({ workspaceId: personal.id });

  // Same shape `task api-key:create` produces; only the SHA-256 is stored.
  const key = `drk_${randomBytes(24).toString('base64url')}`;
  const keyId = `key${randomBytes(8).toString('hex')}`;
  await withDb(async (c) =>
    c.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, scopes) VALUES ($1, $2, 'e2e', $3, 'read')`,
      [keyId, await userIdByEmail(email), createHash('sha256').update(key).digest('hex')]
    )
  );

  const { client, transport } = await connectBearer(key);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('list_apps');
    expect(names).not.toContain('write_files');
    const listed = await callTool(client, 'list_apps', {});
    expect(listed.isError).toBe(false);
    expect(listed.json.user).toEqual({ email });
    expect((listed.json.apps as { slug: string }[]).map((a) => a.slug)).toEqual([app.slug]);
  } finally {
    await transport.close();
  }
  const lastUsed = await withDb(async (c) =>
    (await c.query(`SELECT last_used_at FROM api_keys WHERE id = $1`, [keyId])).rows[0].last_used_at
  );
  expect(lastUsed).not.toBeNull();

  await withDb((c) => c.query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1`, [keyId]));
  const revoked = await rawInitialize(request, { Authorization: `Bearer ${key}` });
  expect(revoked.status()).toBe(401);
  expect(revoked.headers()['www-authenticate']).toContain('error="invalid_token"');
});
