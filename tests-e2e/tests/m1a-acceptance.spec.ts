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
import {
  callTool,
  file,
  indexHtml,
  initUploadCommit,
  waitForState,
} from './helpers/deploy';

/**
 * M1a ACCEPTANCE (PHY-74) — the ONE canonical end-to-end that ties the whole
 * milestone together, exactly as the ROADMAP states it:
 *
 *   "deploy a static app from Claude Code over MCP → it serves on its URL,
 *    rollback works, the app is visible in the dashboard apps list, and
 *    docker compose up brings the whole stack up self-hosted."
 *
 * One user drives the full journey a real operator would:
 *   (a) log in with an email magic-code (U2) → personal workspace materializes,
 *       then create a TEAM workspace (U4);
 *   (b) an MCP client does the REAL OAuth 2.1 dance (U5): DCR → PKCE
 *       authorize + consent (binding the token to the TEAM workspace, granting
 *       deploy:write) → token exchange → connected Streamable-HTTP MCP client —
 *       i.e. what Claude Code does end to end;
 *   (c) deploy a tiny static app v1 (index.html + one asset) over MCP (U6):
 *       deploy_init → PUT the missing blobs → deploy_commit → deploy_status ready;
 *   (d) GET the served URL /:ws/app/:slug (U7) → v1 content, strict CSP + nosniff;
 *   (e) deploy v2 → serve → v2;
 *   (f) ROLLBACK via the MCP rollback tool → serve → v1 again;
 *   (g) the app is VISIBLE in the dashboard apps list + its deploy history (U8),
 *       and the dashboard reflects the rolled-back active version.
 *
 * Self-cleaning: unique email + unique team slug + salted app slug per run.
 * Requires the local compose stack (web+mcp+postgres+redis+mailpit+worker).
 */

const REDIRECT_URI = 'http://127.0.0.1:9966/callback';

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Dynamic Client Registration (RFC 7591) — returns the minted client_id. */
async function registerClient(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${BASE_URL_WEB}/oauth/register`, {
    data: {
      client_name: 'drobek M1a acceptance (Claude Code)',
      redirect_uris: [REDIRECT_URI],
    },
  });
  expect(res.status(), 'DCR register').toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** The RS's canonical resource identifier (== the required token audience). */
async function mcpResource(request: APIRequestContext): Promise<string> {
  const res = await request.get(
    `${BASE_URL_MCP}/.well-known/oauth-protected-resource`
  );
  expect(res.status()).toBe(200);
  return ((await res.json()) as { resource: string }).resource;
}

/**
 * Drive the browser consent screen, SELECTING the team workspace (so the token
 * binds there, not to the personal workspace), and capture the auth code from
 * the intercepted loopback redirect.
 */
async function consentForTeam(
  page: Page,
  opts: {
    clientId: string;
    challenge: string;
    resource: string;
    scope: string;
    teamLabel: string;
  }
): Promise<string> {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    scope: opts.scope,
    resource: opts.resource,
    state: 'm1a-state',
  });
  await page.goto(`/oauth/authorize?${params.toString()}`);
  await expect(page.getByTestId('consent-approve')).toBeVisible();

  // Bind the token to the TEAM workspace (label is "<name> (<role>)").
  await page.getByTestId('workspace-select').selectOption({ label: opts.teamLabel });
  // deploy:write is requested + default-checked; confirm before approving.
  await expect(page.getByTestId('scope-deploy:write')).toBeChecked();

  const captured = new Promise<string>((resolve) => {
    void page.route(`${REDIRECT_URI.replace('/callback', '')}/**`, (route) => {
      const url = route.request().url();
      void route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' });
      resolve(url);
    });
  });
  await page.getByTestId('consent-approve').click();
  const capturedUrl = await captured;
  await page.unroute(`${REDIRECT_URI.replace('/callback', '')}/**`);
  const url = new URL(capturedUrl);
  expect(url.searchParams.get('state')).toBe('m1a-state');
  const code = url.searchParams.get('code');
  expect(code, 'authorization code present in redirect').toBeTruthy();
  return code as string;
}

async function exchangeCode(
  request: APIRequestContext,
  opts: { code: string; verifier: string; clientId: string }
): Promise<string> {
  const res = await request.post(`${BASE_URL_WEB}/oauth/token`, {
    form: {
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: opts.verifier,
      client_id: opts.clientId,
    },
  });
  expect(res.status(), 'token exchange').toBe(200);
  const body = (await res.json()) as { access_token?: string; scope?: string };
  expect(body.access_token, 'access token issued').toBeTruthy();
  expect(body.scope, 'deploy:write granted').toContain('deploy:write');
  return body.access_token as string;
}

test('M1a acceptance: login → team → MCP OAuth → deploy → serve → v2 → rollback → dashboard @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  test.setTimeout(120_000);

  const salt = randomBytes(5).toString('hex');
  const email = uniqueEmail('m1a');
  const teamName = `M1a Team ${salt}`;
  const teamSlug = `m1a-team-${salt}`;
  const appSlug = `m1a-app-${salt}`;

  // ── (a) log in (U2) → personal workspace materializes → create a team (U4) ──
  await loginViaEmail(page, request, email);

  await page.goto('/workspaces');
  const items = page.getByTestId('workspace-item');
  await expect(items).toHaveCount(1);
  await expect(items.first().getByTestId('role-badge')).toHaveText(
    'workspace-admin'
  );
  await expect(items.first()).toContainText('personal');

  await page.getByLabel('Team name').fill(teamName);
  await page.getByLabel('Slug').fill(teamSlug);
  await page.getByRole('button', { name: 'Create team' }).click();
  await page.waitForURL(new RegExp(`/workspaces/${teamSlug}$`));
  await expect(page.getByTestId('my-role')).toHaveText('workspace-admin');

  // ── (b) MCP client does the REAL OAuth 2.1 flow, bound to the TEAM ws ──────
  const resource = await mcpResource(request);
  const clientId = await registerClient(request);
  const { verifier, challenge } = pkcePair();
  const code = await consentForTeam(page, {
    clientId,
    challenge,
    resource,
    scope: 'mcp:whoami apps:read deploy:write',
    teamLabel: `${teamName} (workspace-admin)`,
  });
  const accessToken = await exchangeCode(request, { code, verifier, clientId });

  const transport = new StreamableHTTPClientTransport(
    new URL(`${BASE_URL_MCP}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }
  );
  const client = new Client({ name: 'drobek-m1a-acceptance', version: '0.0.0' });
  await client.connect(transport);

  try {
    // The connected client is exactly Claude Code's view: the deploy tools are
    // exposed and the token is bound to the TEAM workspace.
    const toolNames = (await client.listTools()).tools.map((t) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'whoami',
        'list_apps',
        'deploy_init',
        'deploy_commit',
        'deploy_status',
        'rollback',
      ])
    );
    const who = await callTool(client, 'whoami', {});
    expect(who.json.email).toBe(email);
    expect(who.json.workspace).toBe(teamSlug);
    expect(who.json.role).toBe('workspace-admin');

    // ── (c) deploy a tiny static app v1 (index.html + one asset) over MCP ────
    const assetPath = `assets/app-${salt}.js`;
    const v1 = await initUploadCommit(client, request, {
      name: `M1a App ${salt}`,
      slug: appSlug,
      files: [
        indexHtml(`v1 ${salt}`),
        file(assetPath, `console.log("m1a v1 ${salt}");`, 'application/javascript'),
      ],
    });
    // The deploy landed in the TEAM workspace (token binding proven).
    expect(v1.workspaceSlug).toBe(teamSlug);
    expect(v1.appSlug).toBe(appSlug);
    expect(v1.url).toContain(`/${teamSlug}/app/${appSlug}`);

    const v1ready = await waitForState(client, v1.deployId, 'ready');
    expect(v1ready.active, 'v1 is the active deploy').toBe(true);

    // ── (d) GET the served URL → v1 content, strict CSP + nosniff ────────────
    const serveV1 = await page.request.get(v1.url);
    expect(serveV1.status()).toBe(200);
    const h1 = serveV1.headers();
    expect(h1['content-security-policy']).toContain("default-src 'self'");
    expect(h1['content-security-policy']).toContain("object-src 'none'");
    expect(h1['x-content-type-options']).toBe('nosniff');
    expect(h1['content-type']).toContain('text/html');
    expect(await serveV1.text()).toContain(`v1 ${salt}`);

    // The served app response must NOT leak the dashboard session cookie.
    const leaks = serveV1
      .headersArray()
      .filter((x) => x.name.toLowerCase() === 'set-cookie')
      .some((x) => x.value.includes('drobek_session'));
    expect(leaks, 'no dashboard session cookie on the served app').toBe(false);

    // ── (e) deploy v2 (same slug) → serves v2 ────────────────────────────────
    const v2 = await initUploadCommit(client, request, {
      slug: appSlug,
      files: [
        indexHtml(`v2 ${salt}`),
        file(assetPath, `console.log("m1a v2 ${salt}");`, 'application/javascript'),
      ],
    });
    expect(v2.appSlug).toBe(appSlug);
    const v2ready = await waitForState(client, v2.deployId, 'ready');
    expect(v2ready.active, 'v2 is now the active deploy').toBe(true);

    const serveV2 = await page.request.get(v1.url);
    expect(serveV2.status()).toBe(200);
    expect(await serveV2.text()).toContain(`v2 ${salt}`);

    // ── (f) ROLLBACK via the MCP rollback tool → serves v1 again ─────────────
    const rb = await callTool(client, 'rollback', { slug: appSlug });
    expect(rb.isError, JSON.stringify(rb.json)).toBe(false);
    expect(rb.json.restoredDeployId).toBe(v1.deployId);

    const v1status = await callTool(client, 'deploy_status', {
      deployId: v1.deployId,
    });
    expect(v1status.json.active, 'v1 active after rollback').toBe(true);
    const v2status = await callTool(client, 'deploy_status', {
      deployId: v2.deployId,
    });
    expect(v2status.json.active, 'v2 inactive after rollback').toBe(false);

    const serveAfter = await page.request.get(v1.url);
    expect(serveAfter.status()).toBe(200);
    expect(await serveAfter.text()).toContain(`v1 ${salt}`);

    // ── (g) the app is VISIBLE in the dashboard apps list + deploy history ────
    await page.goto(`/workspaces/${teamSlug}/apps`);
    const appRow = page.locator(
      `[data-testid="app-row"][data-app-slug="${appSlug}"]`
    );
    await expect(appRow).toHaveCount(1);
    await expect(
      appRow.locator('[data-testid="app-live-url"]')
    ).toHaveAttribute('href', `/${teamSlug}/app/${appSlug}`);

    await appRow.locator('[data-testid="app-detail-link"]').click();
    await page.waitForURL(
      new RegExp(`/workspaces/${teamSlug}/apps/${appSlug}$`)
    );

    // Deploy history shows BOTH versions; v1 is flagged active (post-rollback).
    const v1row = page.locator(
      `[data-testid="deploy-row"][data-deploy-id="${v1.deployId}"]`
    );
    const v2row = page.locator(
      `[data-testid="deploy-row"][data-deploy-id="${v2.deployId}"]`
    );
    await expect(v1row).toHaveCount(1);
    await expect(v2row).toHaveCount(1);
    await expect(v1row.locator('[data-testid="deploy-active"]')).toBeVisible();
    await expect(
      v2row.locator('[data-testid="deploy-active"]')
    ).toHaveCount(0);
  } finally {
    await transport.close();
  }
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
  // the deploy scope surface M1a needs.
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
  expect(prm.scopes_supported).toContain('deploy:write');

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
