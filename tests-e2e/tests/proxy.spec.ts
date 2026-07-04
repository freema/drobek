import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { expect, test } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { loginViaEmail, logout, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { indexHtml, initUploadCommit, mcpClient } from './helpers/deploy';

/**
 * PHY-59 acceptance (BFF proxy v1 — authed members). As a workspace-admin,
 * register an upstream pointing at the in-network echo target with a write-only
 * secret + allowed GET + a path prefix; then:
 *   - a member call to an allowed path returns the upstream response AND the
 *     injected auth header arrived (echoed back) while the client Cookie did NOT;
 *   - a disallowed method → 405, a path outside the prefix → 403;
 *   - the dashboard NEVER shows the secret (only "secret set");
 *   - an editor cannot configure (403 on the page + on a direct POST);
 *   - a flood trips the rate-limit (429);
 *   - SSRF: a private-IP base_url is REJECTED at registration; a host that
 *     resolves private (not allow-listed) is blocked at forward time (403); a
 *     redirect to an internal URL is returned verbatim, NOT followed;
 *   - an anonymous proxy call → 401.
 * Requires the local compose stack + worker + the proxy-echo service.
 */

const DEPLOY_SCOPE = 'mcp:whoami apps:read deploy:write';
const ECHO_BASE = 'http://proxy-echo:8099';
const SECRET = 'super-secret-token-123';
const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://drobek:drobek@localhost:5441/drobek';

async function withDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function workspaceIdFor(ws: string): Promise<string> {
  return withDb(async (c) => {
    const res = await c.query(`SELECT id FROM workspaces WHERE slug = $1`, [ws]);
    expect(res.rows.length, 'workspace exists').toBe(1);
    return res.rows[0].id as string;
  });
}

/** Register the `echo` upstream via the dashboard form (admin session on `page`). */
async function registerEcho(page: import('@playwright/test').Page, ws: string) {
  await page.goto(`/workspaces/${ws}/upstreams`);
  await page.getByTestId('field-name').fill('echo');
  await page.getByTestId('field-baseurl').fill(ECHO_BASE);
  await page.getByTestId('field-methods').fill('GET');
  await page.getByTestId('field-paths').fill('/echo /redirect');
  await page.getByTestId('field-authtype').selectOption('header');
  await page.getByTestId('field-headername').fill('X-Api-Key');
  await page.getByTestId('field-secret').fill(SECRET);
  await page.getByTestId('upstream-submit').click();
  await page.waitForURL(/\/upstreams$/);
  await expect(
    page.locator('[data-testid="upstream-row"][data-upstream-name="echo"]')
  ).toBeVisible();
}

test('proxy: register → member call injects the secret; method/path gate; secret never shown @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();

  // Admin session + a workspace (deploying an app makes the user workspace-admin).
  const { client, transport } = await mcpClient(page, request, {
    tag: 'proxy-admin',
    scope: DEPLOY_SCOPE,
  });
  let ws: string;
  try {
    const salt = randomBytes(6).toString('hex');
    const dep = await initUploadCommit(client, request, {
      name: `E2E Proxy ${salt}`,
      files: [indexHtml(`proxy ${salt}`)],
    });
    ws = dep.workspaceSlug;
  } finally {
    await transport.close();
  }

  await registerEcho(page, ws);

  // The dashboard NEVER renders the secret value — only "secret set".
  await expect(page.getByTestId('upstream-secret').first()).toContainText('secret set');
  expect(await page.content()).not.toContain(SECRET);

  // ── member call to an ALLOWED path → the upstream response + injected header ──
  const ok = await page.request.get(
    `${BASE_URL_WEB}/${ws}/api/proxy/echo/echo/thing?q=1`
  );
  expect(ok.status(), 'allowed GET returns the upstream response').toBe(200);
  const echoed = (await ok.json()) as {
    path: string;
    headers: Record<string, string>;
  };
  expect(echoed.path).toBe('/echo/thing');
  // The injected auth header ARRIVED at the upstream…
  expect(echoed.headers['x-api-key']).toBe(SECRET);
  // …and the drobek session cookie did NOT leak to the upstream.
  expect(echoed.headers['cookie']).toBeUndefined();
  // …nor did any client Authorization.
  expect(echoed.headers['authorization']).toBeUndefined();

  // ── a DISALLOWED method → 405 ────────────────────────────────────────────────
  const badMethod = await page.request.post(
    `${BASE_URL_WEB}/${ws}/api/proxy/echo/echo/thing`,
    { data: { x: 1 } }
  );
  expect(badMethod.status(), 'POST not in allowed methods → 405').toBe(405);

  // ── a path OUTSIDE the allowed prefix → 403 ─────────────────────────────────
  const badPath = await page.request.get(
    `${BASE_URL_WEB}/${ws}/api/proxy/echo/forbidden/thing`
  );
  expect(badPath.status(), 'path outside prefix → 403').toBe(403);

  // ── a redirect from the upstream to an INTERNAL URL is NOT followed ──────────
  const redir = await page.request.get(
    `${BASE_URL_WEB}/${ws}/api/proxy/echo/redirect`,
    { maxRedirects: 0 }
  );
  expect([301, 302, 303, 307, 308]).toContain(redir.status());
  // The 302 is relayed verbatim; drobek did NOT fetch the metadata endpoint.
  expect(redir.headers()['location']).toContain('169.254.169.254');

  // ── anonymous proxy call → 401 (no session on the `request` context) ─────────
  const anon = await request.get(`${BASE_URL_WEB}/${ws}/api/proxy/echo/echo/thing`);
  expect(anon.status(), 'anonymous proxy call → 401').toBe(401);
});

test('proxy: SSRF — private base_url rejected at registration; private-resolving host blocked at forward @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();

  const { client, transport } = await mcpClient(page, request, {
    tag: 'proxy-ssrf',
    scope: DEPLOY_SCOPE,
  });
  let ws: string;
  try {
    const salt = randomBytes(6).toString('hex');
    const dep = await initUploadCommit(client, request, {
      name: `E2E ProxySSRF ${salt}`,
      files: [indexHtml(`ssrf ${salt}`)],
    });
    ws = dep.workspaceSlug;
  } finally {
    await transport.close();
  }
  const createUrl = `${BASE_URL_WEB}/workspaces/${ws}/upstreams`;

  // Registering a base_url with a private/reserved IP LITERAL → 400 (rejected).
  for (const baseUrl of [
    'http://127.0.0.1',
    'http://169.254.169.254',
    'http://10.1.2.3',
    'http://localhost:9000',
  ]) {
    const res = await page.request.post(createUrl, {
      form: {
        intent: 'create',
        name: `bad-${randomBytes(3).toString('hex')}`,
        baseUrl,
        methods: 'GET',
        pathPrefixes: '/',
        authType: 'none',
      },
      maxRedirects: 0,
    });
    expect(res.status(), `registration of ${baseUrl} must be rejected`).toBe(400);
  }

  // A HOSTNAME that resolves to a private Docker IP (postgres) is allowed to
  // REGISTER (not a private literal) but BLOCKED at forward time by the SSRF
  // guard (it is not on PROXY_ALLOWED_HOSTS).
  const reg = await page.request.post(createUrl, {
    form: {
      intent: 'create',
      name: 'pg',
      baseUrl: 'http://postgres:5432',
      methods: 'GET',
      pathPrefixes: '/',
      authType: 'none',
    },
    maxRedirects: 0,
  });
  expect([302, 303], 'registering a public-looking hostname succeeds').toContain(
    reg.status()
  );

  const blocked = await page.request.get(`${BASE_URL_WEB}/${ws}/api/proxy/pg/anything`);
  expect(blocked.status(), 'forward to a private-resolving host → 403').toBe(403);
  const body = (await blocked.json()) as { error: string };
  expect(body.error).toBe('ssrf_blocked');
});

test('proxy: an editor cannot configure upstreams (page 403 + POST 403) @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();

  const { client, transport } = await mcpClient(page, request, {
    tag: 'proxy-owner',
    scope: DEPLOY_SCOPE,
  });
  let ws: string;
  try {
    const salt = randomBytes(6).toString('hex');
    const dep = await initUploadCommit(client, request, {
      name: `E2E ProxyRole ${salt}`,
      files: [indexHtml(`role ${salt}`)],
    });
    ws = dep.workspaceSlug;
  } finally {
    await transport.close();
  }
  const workspaceId = await workspaceIdFor(ws);

  // A different user signs in and is seeded as an EDITOR of the owner's workspace.
  const editorEmail = uniqueEmail('proxy-editor');
  await logout(page);
  await loginViaEmail(page, request, editorEmail);
  const editorUserId = await withDb(async (c) => {
    const res = await c.query(`SELECT id FROM users WHERE email = $1`, [editorEmail]);
    expect(res.rows.length, 'editor user exists').toBe(1);
    return res.rows[0].id as string;
  });
  await withDb((c) =>
    c.query(
      `INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'editor')`,
      [editorUserId, workspaceId]
    )
  );

  // The editor cannot even load the config page (admin-gated → 403).
  const pageRes = await page.request.get(`${BASE_URL_WEB}/workspaces/${ws}/upstreams`);
  expect(pageRes.status(), 'editor GET upstreams page → 403').toBe(403);

  // …and a direct create POST is rejected server-side.
  const post = await page.request.post(`${BASE_URL_WEB}/workspaces/${ws}/upstreams`, {
    form: {
      intent: 'create',
      name: 'sneaky',
      baseUrl: 'https://api.example.com',
      methods: 'GET',
      pathPrefixes: '/',
      authType: 'none',
    },
    maxRedirects: 0,
  });
  expect(post.status(), 'editor create POST → 403').toBe(403);
});

test('proxy: a flood of member calls trips the rate limit (429) @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();

  const { client, transport } = await mcpClient(page, request, {
    tag: 'proxy-flood',
    scope: DEPLOY_SCOPE,
  });
  let ws: string;
  try {
    const salt = randomBytes(6).toString('hex');
    const dep = await initUploadCommit(client, request, {
      name: `E2E ProxyFlood ${salt}`,
      files: [indexHtml(`flood ${salt}`)],
    });
    ws = dep.workspaceSlug;
  } finally {
    await transport.close();
  }
  await registerEcho(page, ws);

  // The dev compose caps PROXY_RATE_LIMIT low (15) → a flood trips 429.
  let got429 = false;
  for (let i = 0; i < 40; i++) {
    const res = await page.request.get(
      `${BASE_URL_WEB}/${ws}/api/proxy/echo/echo/thing`
    );
    if (res.status() === 429) {
      got429 = true;
      break;
    }
  }
  expect(got429, 'a proxy flood is eventually rate-limited (429)').toBe(true);
});

test('anonymous proxy call is unauthorized @smoke', async ({ request }) => {
  // Prod-safe: no upstream needed — auth is checked before upstream resolution.
  const res = await request.get(
    `${BASE_URL_WEB}/some-workspace/api/proxy/whatever/path`,
    { maxRedirects: 0 }
  );
  expect([401, 302, 303]).toContain(res.status());
});
