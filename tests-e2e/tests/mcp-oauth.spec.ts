import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { BASE_URL_MCP, BASE_URL_WEB } from '../playwright.config';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';

/**
 * U5 acceptance (PHY-71/PHY-53): the MCP OAuth 2.1 flow end-to-end against the
 * local compose stack — discovery → DCR → browser consent (PKCE S256) → token
 * → Bearer MCP call — plus the R6 security negatives: unauthenticated 401,
 * wrong-audience rejection (RFC 8707), single-use code, and refresh rotation +
 * reuse detection. Mirrors ROADMAP §5's e2e line for U5.
 */

// A loopback redirect_uri that nothing serves — the browser's cross-origin
// redirect to it is intercepted so we can read the ?code without a real client.
const REDIRECT_URI = 'http://127.0.0.1:9977/callback';

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${BASE_URL_WEB}/oauth/register`, {
    data: {
      client_name: 'drobek e2e MCP client',
      redirect_uris: [REDIRECT_URI],
    },
  });
  expect(res.status(), 'DCR register').toBe(201);
  const body = (await res.json()) as { client_id: string };
  expect(body.client_id).toBeTruthy();
  return body.client_id;
}

/** Drive the consent screen and capture the authorization code from redirect. */
async function consentAndGetCode(
  page: Page,
  opts: {
    clientId: string;
    challenge: string;
    resource: string;
    state: string;
    scope?: string;
  }
): Promise<string> {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    scope: opts.scope ?? 'mcp:whoami apps:read',
    resource: opts.resource,
    state: opts.state,
  });

  await page.goto(`/oauth/authorize?${params.toString()}`);
  await expect(page.getByTestId('consent-approve')).toBeVisible();

  const captured = new Promise<string>((resolve) => {
    void page.route('http://127.0.0.1:9977/**', (route) => {
      const url = route.request().url();
      void route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' });
      resolve(url);
    });
  });
  await page.getByTestId('consent-approve').click();
  const capturedUrl = await captured;
  await page.unroute('http://127.0.0.1:9977/**');

  const url = new URL(capturedUrl);
  expect(url.searchParams.get('state')).toBe(opts.state);
  const code = url.searchParams.get('code');
  expect(code, 'authorization code present in redirect').toBeTruthy();
  return code as string;
}

interface TokenResult {
  status: number;
  body: {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  };
}

async function exchangeCode(
  request: APIRequestContext,
  opts: { code: string; verifier: string; clientId: string }
): Promise<TokenResult> {
  const res = await request.post(`${BASE_URL_WEB}/oauth/token`, {
    form: {
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: opts.verifier,
      client_id: opts.clientId,
    },
  });
  return { status: res.status(), body: await res.json() };
}

async function refresh(
  request: APIRequestContext,
  opts: { refreshToken: string; clientId: string }
): Promise<TokenResult> {
  const res = await request.post(`${BASE_URL_WEB}/oauth/token`, {
    form: {
      grant_type: 'refresh_token',
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
    },
  });
  return { status: res.status(), body: await res.json() };
}

/** A raw MCP initialize POST — used for the auth negatives (no SDK). */
async function rawInitialize(
  request: APIRequestContext,
  headers: Record<string, string>
) {
  return request.post(`${BASE_URL_MCP}/mcp`, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'e2e-raw', version: '0' },
      },
    },
  });
}

async function mcpResource(request: APIRequestContext): Promise<string> {
  const res = await request.get(
    `${BASE_URL_MCP}/.well-known/oauth-protected-resource`
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { resource: string };
  return body.resource;
}

test('MCP OAuth 2.1 end-to-end: discovery → register → consent → token → whoami @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();

  // (1) protected-resource metadata → the AS + the resource identifier.
  const prmRes = await request.get(
    `${BASE_URL_MCP}/.well-known/oauth-protected-resource`
  );
  expect(prmRes.status()).toBe(200);
  const prm = (await prmRes.json()) as {
    resource: string;
    authorization_servers: string[];
  };
  expect(prm.authorization_servers.length).toBeGreaterThan(0);
  const resource = prm.resource;

  // (2) authorization-server metadata.
  const asRes = await request.get(
    `${BASE_URL_WEB}/.well-known/oauth-authorization-server`
  );
  expect(asRes.status()).toBe(200);
  const as = (await asRes.json()) as Record<string, string[] | string>;
  expect(as.authorization_endpoint).toContain('/oauth/authorize');
  expect(as.token_endpoint).toContain('/oauth/token');
  expect(as.registration_endpoint).toContain('/oauth/register');
  expect(as.code_challenge_methods_supported).toContain('S256');

  // (3) DCR.
  const clientId = await registerClient(request);

  // (4) log in + consent → code.
  const email = uniqueEmail('mcp-oauth');
  await loginViaEmail(page, request, email);
  const { verifier, challenge } = pkcePair();
  const code = await consentAndGetCode(page, {
    clientId,
    challenge,
    resource,
    state: 'state-xyz',
  });

  // (5) token exchange.
  const tok = await exchangeCode(request, { code, verifier, clientId });
  expect(tok.status).toBe(200);
  expect(tok.body.token_type).toBe('Bearer');
  expect(tok.body.access_token).toBeTruthy();
  expect(tok.body.refresh_token).toBeTruthy();
  const accessToken = tok.body.access_token as string;

  // (6) Bearer MCP call via the official SDK client.
  const transport = new StreamableHTTPClientTransport(
    new URL(`${BASE_URL_MCP}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }
  );
  const client = new Client({ name: 'drobek-e2e', version: '0.0.0' });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('whoami');
    // apps:read was granted → list_apps is exposed.
    expect(names).toContain('list_apps');

    const who = await client.callTool({ name: 'whoami', arguments: {} });
    const whoText = (who.content as { type: string; text: string }[])[0].text;
    const whoami = JSON.parse(whoText) as {
      email: string;
      role: string;
      workspace: string;
      scope: string;
    };
    expect(whoami.email).toBe(email);
    expect(whoami.role).toBe('workspace-admin');
    expect(whoami.scope).toContain('apps:read');

    const listed = await client.callTool({ name: 'list_apps', arguments: {} });
    const listedText = (listed.content as { type: string; text: string }[])[0]
      .text;
    const apps = JSON.parse(listedText) as { count: number };
    expect(apps.count).toBe(0);
  } finally {
    await transport.close();
  }
});

test('MCP OAuth negatives: no-token 401, wrong-audience reject, single-use code, refresh rotation + reuse @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const resource = await mcpResource(request);

  // No token → 401 + WWW-Authenticate resource_metadata pointer.
  const noToken = await rawInitialize(request, {});
  expect(noToken.status()).toBe(401);
  expect(noToken.headers()['www-authenticate']).toContain('resource_metadata=');

  const clientId = await registerClient(request);
  const email = uniqueEmail('mcp-neg');
  await loginViaEmail(page, request, email);

  // --- single-use code + refresh rotation/reuse (correct audience) ---
  {
    const { verifier, challenge } = pkcePair();
    const code = await consentAndGetCode(page, {
      clientId,
      challenge,
      resource,
      state: 'neg-a',
    });

    const first = await exchangeCode(request, { code, verifier, clientId });
    expect(first.status).toBe(200);

    // Replaying the same code → invalid_grant (single-use).
    const replay = await exchangeCode(request, { code, verifier, clientId });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');

    // Rotate the refresh token once (ok)…
    const rot = await refresh(request, {
      refreshToken: first.body.refresh_token as string,
      clientId,
    });
    expect(rot.status).toBe(200);
    expect(rot.body.access_token).toBeTruthy();
    expect(rot.body.refresh_token).not.toBe(first.body.refresh_token);

    // …reusing the OLD refresh token → invalid_grant (reuse detected)…
    const reuse = await refresh(request, {
      refreshToken: first.body.refresh_token as string,
      clientId,
    });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe('invalid_grant');

    // …and the lineage is burned: the rotated successor is now dead too.
    const burned = await refresh(request, {
      refreshToken: rot.body.refresh_token as string,
      clientId,
    });
    expect(burned.status).toBe(400);
    expect(burned.body.error).toBe('invalid_grant');
  }

  // --- wrong audience: a token minted for a different resource is rejected ---
  {
    const { verifier, challenge } = pkcePair();
    const code = await consentAndGetCode(page, {
      clientId,
      challenge,
      resource: 'https://wrong.example/mcp',
      state: 'neg-b',
    });
    const tok = await exchangeCode(request, { code, verifier, clientId });
    expect(tok.status).toBe(200);

    const rejected = await rawInitialize(request, {
      Authorization: `Bearer ${tok.body.access_token}`,
    });
    expect(rejected.status()).toBe(401);
  }
});

test('OAuth authorization-server discovery returns the authorize endpoint @smoke', async ({
  request,
}) => {
  const res = await request.get(
    `${BASE_URL_WEB}/.well-known/oauth-authorization-server`
  );
  expect(res.status()).toBe(200);
  const meta = (await res.json()) as Record<string, string[] | string>;
  expect(meta.authorization_endpoint).toBeTruthy();
  expect(meta.code_challenge_methods_supported).toContain('S256');
});
