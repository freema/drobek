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
import {
  loginViaEmail,
  resetDcrIpRateLimit,
  skipUnlessLocal,
  uniqueEmail,
} from './helpers/auth';
import { callTool, mcpClient, rawInitialize } from './helpers/mcp';
import { personalWorkspaceOf, seedApp, workspaceIdBySlug } from './helpers/seed';

/**
 * U5 + M0-04 acceptance: the MCP OAuth 2.1 flow end-to-end against the local
 * compose stack — discovery → DCR → browser consent (PKCE S256, the three
 * scope checkboxes, NO workspace choice) → token → Bearer MCP call — plus the
 * security negatives: unauthenticated 401, a foreign `resource` → invalid_target,
 * RFC 9207 `iss` on every authorization response, single-use code, and refresh
 * rotation + reuse detection. The token is USER-bound: list_apps spans every
 * workspace of the user, and a non-member gets not_found.
 * CIMD, the DCR rate limit, the RS audience check and API keys live in
 * mcp-cimd.spec.ts.
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
  await resetDcrIpRateLimit();
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

function authorizeQuery(opts: {
  clientId: string;
  challenge: string;
  resource: string;
  state: string;
  scope?: string;
}): string {
  return new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    scope: opts.scope ?? 'read',
    resource: opts.resource,
    state: opts.state,
  }).toString();
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
  await page.goto(`/oauth/authorize?${authorizeQuery(opts)}`);
  await expect(page.getByTestId('consent-approve')).toBeVisible();
  // M0-04: the grant is user-bound — no workspace picker on the consent screen.
  await expect(page.getByTestId('workspace-select')).toHaveCount(0);

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
  // RFC 9207: the authorization response names its issuer.
  expect(url.searchParams.get('iss')).toBe(BASE_URL_WEB.replace(/\/+$/, ''));
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

async function mcpResource(request: APIRequestContext): Promise<string> {
  const res = await request.get(
    `${BASE_URL_MCP}/.well-known/oauth-protected-resource`
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { resource: string };
  return body.resource;
}

test('MCP OAuth 2.1 end-to-end: discovery → register → consent → token → list_apps @local', async ({
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
    scopes_supported: string[];
  };
  expect(prm.authorization_servers.length).toBeGreaterThan(0);
  expect(prm.scopes_supported).toEqual(['read', 'write', 'publish']);
  const resource = prm.resource;

  // (2) authorization-server metadata (+ CIMD and RFC 9207 support flags).
  const asRes = await request.get(
    `${BASE_URL_WEB}/.well-known/oauth-authorization-server`
  );
  expect(asRes.status()).toBe(200);
  const as = (await asRes.json()) as Record<string, unknown>;
  expect(as.authorization_endpoint).toContain('/oauth/authorize');
  expect(as.token_endpoint).toContain('/oauth/token');
  expect(as.registration_endpoint).toContain('/oauth/register');
  expect(as.code_challenge_methods_supported).toContain('S256');
  expect(as.scopes_supported).toEqual(['read', 'write', 'publish']);
  expect(as.client_id_metadata_document_supported).toBe(true);
  expect(as.authorization_response_iss_parameter_supported).toBe(true);

  // (3) DCR.
  const clientId = await registerClient(request);

  // (4) log in + consent (read only) → code (+ iss asserted in the helper).
  const email = uniqueEmail('mcp-oauth');
  await loginViaEmail(page, request, email);
  const { verifier, challenge } = pkcePair();
  const code = await consentAndGetCode(page, {
    clientId,
    challenge,
    resource,
    state: 'state-xyz',
    scope: 'read',
  });

  // (5) token exchange.
  const tok = await exchangeCode(request, { code, verifier, clientId });
  expect(tok.status).toBe(200);
  expect(tok.body.token_type).toBe('Bearer');
  expect(tok.body.access_token).toBeTruthy();
  expect(tok.body.refresh_token).toBeTruthy();
  expect(tok.body.scope).toBe('read');
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
    // read was granted → the read tools are exposed; write was not → no write tools.
    expect(names.sort()).toEqual(['get_app', 'get_logs', 'list_apps', 'query_data', 'read_file', 'skill_info']);

    const listed = await callTool(client, 'list_apps', {});
    expect(listed.isError).toBe(false);
    expect(listed.json.user).toEqual({ email });
    const workspaces = listed.json.workspaces as { kind: string; role: string }[];
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({ kind: 'personal', role: 'workspace-admin' });
    expect(listed.json.apps).toEqual([]);
  } finally {
    await transport.close();
  }
});

test('MCP OAuth negatives: no-token 401, invalid_target, deny, refresh rotation + reuse, burned + replayed code @local', async ({
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

  // A resource that is not this MCP endpoint → redirected back with
  // invalid_target (+ state + iss) before any login or consent.
  {
    const { challenge } = pkcePair();
    const res = await request.get(
      `${BASE_URL_WEB}/oauth/authorize?${authorizeQuery({
        clientId,
        challenge,
        resource: 'https://wrong.example/mcp',
        state: 'neg-target',
      })}`,
      { maxRedirects: 0 }
    );
    expect(res.status()).toBe(302);
    const loc = new URL(res.headers()['location']);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT_URI);
    expect(loc.searchParams.get('error')).toBe('invalid_target');
    expect(loc.searchParams.get('state')).toBe('neg-target');
    expect(loc.searchParams.get('iss')).toBe(BASE_URL_WEB.replace(/\/+$/, ''));
    expect(loc.searchParams.get('code')).toBeNull();
  }

  const email = uniqueEmail('mcp-neg');
  await loginViaEmail(page, request, email);

  // Deny → access_denied, still carrying iss.
  {
    const { challenge } = pkcePair();
    await page.goto(
      `/oauth/authorize?${authorizeQuery({ clientId, challenge, resource, state: 'neg-deny' })}`
    );
    const captured = new Promise<string>((resolve) => {
      void page.route('http://127.0.0.1:9977/**', (route) => {
        const url = route.request().url();
        void route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' });
        resolve(url);
      });
    });
    await page.getByTestId('consent-deny').click();
    const denied = new URL(await captured);
    await page.unroute('http://127.0.0.1:9977/**');
    expect(denied.searchParams.get('error')).toBe('access_denied');
    expect(denied.searchParams.get('iss')).toBe(BASE_URL_WEB.replace(/\/+$/, ''));
    expect(denied.searchParams.get('code')).toBeNull();
  }

  // --- single-use code + refresh rotation/reuse ---
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

    // …as is every access token of the grant.
    const dead = await rawInitialize(request, {
      Authorization: `Bearer ${rot.body.access_token}`,
    });
    expect(dead.status()).toBe(401);
  }

  // --- a failed exchange burns the code (NSO-332) ---
  {
    const { verifier, challenge } = pkcePair();
    const code = await consentAndGetCode(page, {
      clientId,
      challenge,
      resource,
      state: 'neg-b',
    });

    const wrong = await exchangeCode(request, {
      code,
      verifier: pkcePair().verifier,
      clientId,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_grant');

    // The right verifier no longer helps: the code was consumed.
    const right = await exchangeCode(request, { code, verifier, clientId });
    expect(right.status).toBe(400);
    expect(right.body.error).toBe('invalid_grant');
  }

  // --- replaying an exchanged code revokes what it minted (NSO-332) ---
  {
    const { verifier, challenge } = pkcePair();
    const code = await consentAndGetCode(page, {
      clientId,
      challenge,
      resource,
      state: 'neg-c',
    });

    const first = await exchangeCode(request, { code, verifier, clientId });
    expect(first.status).toBe(200);
    const live = await rawInitialize(request, {
      Authorization: `Bearer ${first.body.access_token}`,
    });
    expect(live.status()).toBe(200);

    // Replaying the same code → invalid_grant (single-use)…
    const replay = await exchangeCode(request, { code, verifier, clientId });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');

    // …and the refresh token + access token it was exchanged for are dead.
    const burned = await refresh(request, {
      refreshToken: first.body.refresh_token as string,
      clientId,
    });
    expect(burned.status).toBe(400);
    expect(burned.body.error).toBe('invalid_grant');
    const dead = await rawInitialize(request, {
      Authorization: `Bearer ${first.body.access_token}`,
    });
    expect(dead.status()).toBe(401);
  }
});

test('MCP token is USER-bound: list_apps spans both of the user’s workspaces; a non-member gets not_found @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();
  const salt = randomBytes(5).toString('hex');
  const email = uniqueEmail('mcp-team');
  const teamName = `MCP Team ${salt}`;
  const teamSlug = `mcp-team-${salt}`;

  // Log in → personal workspace materializes → create a TEAM workspace.
  await loginViaEmail(page, request, email);
  await page.goto('/workspaces');
  await page.getByLabel('Team name').fill(teamName);
  await page.getByLabel('Slug').fill(teamSlug);
  await page.getByRole('button', { name: 'Create team' }).click();
  await page.waitForURL(new RegExp(`/workspaces/${teamSlug}$`));

  // One app in each workspace.
  const personal = await personalWorkspaceOf(email);
  const personalApp = await seedApp({ workspaceId: personal.id });
  const teamApp = await seedApp({ workspaceId: await workspaceIdBySlug(teamSlug) });

  // One consent, no workspace choice → the token reaches both workspaces.
  const mcp = await mcpClient(page, request, { email, signedIn: true, scope: 'read' });
  try {
    expect(mcp.workspace).toBe(personal.slug);
    expect(mcp.workspaces.map((w) => [w.slug, w.kind, w.role])).toEqual([
      [personal.slug, 'personal', 'workspace-admin'],
      [teamSlug, 'team', 'workspace-admin'],
    ]);

    const listed = await callTool(mcp.client, 'list_apps', {});
    const all = (listed.json.apps as { workspace: string; slug: string }[]).map(
      (a) => `${a.workspace}/${a.slug}`
    );
    expect(all).toEqual([`${personal.slug}/${personalApp.slug}`, `${teamSlug}/${teamApp.slug}`]);

    const onlyTeam = await callTool(mcp.client, 'list_apps', { workspace: teamSlug });
    expect((onlyTeam.json.apps as { slug: string }[]).map((a) => a.slug)).toEqual([teamApp.slug]);

    // Per-call authorization: apps in both workspaces are reachable with this token.
    for (const app of [personalApp, teamApp]) {
      const r = await callTool(mcp.client, 'get_app', { app_id: app.id });
      expect(r.isError, JSON.stringify(r.json)).toBe(false);
      expect(r.json.slug).toBe(app.slug);
    }
  } finally {
    await mcp.transport.close();
  }

  // A different user (not a member of either workspace) → not_found, the same
  // answer as an app that does not exist.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const other = await mcpClient(pageB, request, { tag: 'mcp-outsider', scope: 'read' });
  try {
    const cross = await callTool(other.client, 'get_app', { app_id: teamApp.id });
    const missing = await callTool(other.client, 'get_app', { app_id: 'e2e-no-such-app' });
    expect(cross.isError).toBe(true);
    expect(cross.json).toEqual(missing.json);
    expect(cross.json.code).toBe('not_found');

    const foreignList = await callTool(other.client, 'list_apps', { workspace: teamSlug });
    expect(foreignList.isError).toBe(true);
    expect(foreignList.json.code).toBe('not_found');
    const own = await callTool(other.client, 'list_apps', {});
    expect(own.json.apps).toEqual([]);
  } finally {
    await other.transport.close();
    await pageB.close();
    await ctxB.close();
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

/**
 * M1a coherence, READ-ONLY — safe against ANY target (local OR beta/prod).
 * Proves the self-host/beta discovery chain is internally consistent without a
 * single write or a login email: the RS advertises the drobek AS, the AS
 * advertises PKCE-S256 + the three OAuth endpoints, and both health surfaces
 * are live. This is the beta-safe half of the M1a acceptance.
 */
test('M1a discovery chain is coherent (RS ↔ AS ↔ health) @smoke', async ({
  request,
}) => {
  // Web + MCP are both live.
  const webHealth = await request.get(`${BASE_URL_WEB}/healthz`);
  expect(webHealth.status()).toBe(200);
  const mcpHealth = await request.get(`${BASE_URL_MCP}/health`);
  expect(mcpHealth.status()).toBe(200);
  expect((await mcpHealth.json()).ok).toBe(true);

  // Protected-resource metadata (RFC 9728): the RS points at an AS + declares
  // the app/data scope surface the MCP tools need.
  const prmRes = await request.get(
    `${BASE_URL_MCP}/.well-known/oauth-protected-resource`
  );
  expect(prmRes.status()).toBe(200);
  const prm = (await prmRes.json()) as {
    resource: string;
    authorization_servers: string[];
    scopes_supported: string[];
  };
  expect(prm.resource).toBeTruthy();
  expect(prm.authorization_servers.length).toBeGreaterThan(0);
  expect(prm.scopes_supported).toContain('read');
  expect(prm.scopes_supported).toContain('write');

  // Authorization-server metadata (RFC 8414): the AS advertised by the RS
  // actually serves the three OAuth 2.1 endpoints + PKCE S256.
  const asIssuer = prm.authorization_servers[0].replace(/\/+$/, '');
  const asRes = await request.get(
    `${asIssuer}/.well-known/oauth-authorization-server`
  );
  expect(asRes.status()).toBe(200);
  const as = (await asRes.json()) as Record<string, string[] | string>;
  expect(String(as.authorization_endpoint)).toContain('/oauth/authorize');
  expect(String(as.token_endpoint)).toContain('/oauth/token');
  expect(String(as.registration_endpoint)).toContain('/oauth/register');
  expect(as.code_challenge_methods_supported).toContain('S256');
});
