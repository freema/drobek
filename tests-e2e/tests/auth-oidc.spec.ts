import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { BASE_URL_WEB, TARGET_PRODUCTION, TEST_ENV } from '../playwright.config';
import { hostRequest, previewHost, urlOf, type Raw } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient, type McpClient } from './helpers/mcp';
import { personalWorkspaceOf, withDb } from './helpers/seed';

/**
 * Sign-in with a company account through the built-in `oidc`
 * provider module, end to end against the mock IdP (tests-e2e/mock-oidc.mjs,
 * spawned here like auth-google.spec.ts spawns its mock, or reused when
 * `task mock:oidc` runs).
 *
 * DEV STACK ONLY: the IdP must be public https; the dev compose admits the
 * http mock through AUTH_OIDC_DEV_ORIGINS (its host.docker.internal:3050 and
 * localhost:3050 origins), which production ignores — the e2e image runs
 * NODE_ENV=production, so there the whole spec is skipped.
 *
 *  - the agent turns the provider on with configure_module('auth', { providers:
 *    { oidc: { enabled, issuer, clientId } } }) → pending; the owner confirms
 *    it and sets OIDC_CLIENT_SECRET in the dashboard;
 *  - the app is the oidc skill's first ```tsx block (<LoginGate>);
 *  - a browser: "Continue with Company account" → the mock's consent → the
 *    callback on the DASHBOARD host → the handoff → the host-only session
 *    cookie on the app host → auth/me (what drobek.auth.me() calls) answers
 *    the user with the role the allowlist gives (adminEmails → admin); the
 *    installed acmecrm module's `auth.signedIn` observer recorded the contact;
 *  - an address outside the allowlist → the 403 page, no session;
 *  - email_verified=false without trustEmail → the 403 "not verified" page
 *    (audited `auth.sign_in_denied { reason: email_not_verified }`);
 *  - a forged state → the 400 "Sign-in expired" page (invalid_state);
 *  - a handoff code used twice → the second is the 400 "Sign-in expired"
 *    page without a cookie (docs/MODULES.md → The flow);
 *  - `return_to: '//evil.example'` → begin answers invalid_request.
 */

const MOCK_PORT = Number(process.env.MOCK_OIDC_PORT ?? 3050);
const MOCK_URL = `http://localhost:${MOCK_PORT}`;
const MOCK_SCRIPT = fileURLToPath(new URL('../mock-oidc.mjs', import.meta.url));
/** What the drobek container reaches (the mock's default issuer, AUTH_OIDC_DEV_ORIGINS). */
const ISSUER = process.env.MOCK_OIDC_ISSUER ?? `http://host.docker.internal:${MOCK_PORT}`;
const CLIENT_ID = 'drobek-e2e';
/** The mock's client secret (MOCK_OIDC_CLIENT_SECRET default) — a test value, not a real secret. */
const CLIENT_SECRET = process.env.MOCK_OIDC_CLIENT_SECRET ?? 'local-dev-secret';

const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const DOMAIN = `acme-${STAMP}.example.org`;
const BOSS = `boss-${STAMP}@${DOMAIN}`;
const ANA = `ana-${STAMP}@${DOMAIN}`;
const OUTSIDER = `outsider-${STAMP}@example.net`;
const LABEL = 'Continue with Company account';

let spawnedMock: ChildProcess | null = null;

async function mockIsUp(): Promise<boolean> {
  try {
    return (await fetch(`${MOCK_URL}/`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  if (TEST_ENV !== 'local' || TARGET_PRODUCTION) return;
  if (await mockIsUp()) return;
  spawnedMock = spawn(process.execPath, [MOCK_SCRIPT], { env: { ...process.env, MOCK_OIDC_PORT: String(MOCK_PORT) }, stdio: 'ignore' });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await mockIsUp()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`mock-oidc did not become ready on ${MOCK_URL}`);
});

test.afterAll(() => {
  spawnedMock?.kill();
  spawnedMock = null;
});

function skipUnlessDevStack(): void {
  skipUnlessLocal();
  test.skip(TARGET_PRODUCTION, 'production ignores AUTH_OIDC_DEV_ORIGINS: the http mock IdP runs on the dev stack only');
}

function sdkHeaders(host: string, cookie?: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Origin: urlOf(host), 'X-Drobek-SDK': '1', ...(cookie ? { Cookie: cookie } : {}) };
}

function setCookies(r: Raw): string[] {
  const sc = r.headers['set-cookie'];
  return Array.isArray(sc) ? sc : sc ? [sc] : [];
}

/** `name=value` of the first Set-Cookie whose name matches. */
function cookieOf(r: Raw, name: RegExp): string | null {
  for (const c of setCookies(r)) {
    const pair = c.split(';')[0];
    if (name.test(pair.split('=')[0])) return pair;
  }
  return null;
}

interface Created {
  app_id: string;
  slug: string;
  workspace: string;
}

test.describe.configure({ mode: 'serial' });

test.describe('auth provider oidc against the mock IdP @local', () => {
  let mcp: McpClient;
  let owner: BrowserContext;
  let app: Created;
  let host: string;

  test.afterAll(async () => {
    await mcp?.client.close();
    await owner?.close();
  });

  /** The app in a fresh browser: the provider button → the mock consent as `email` → back. */
  async function signInThroughIdp(page: Page, email: string, opts: { verified?: boolean } = {}): Promise<void> {
    await page.goto(urlOf(host));
    await page.getByRole('button', { name: LABEL }).click();
    await page.waitForURL(new RegExp(`^${MOCK_URL}/authorize`));
    await page.getByLabel('Email', { exact: true }).fill(email);
    if (opts.verified === false) await page.getByLabel('Email verified').fill('0');
    await page.getByRole('button', { name: 'Approve' }).click();
  }

  test('the agent enables the provider → pending; the owner confirms it and sets OIDC_CLIENT_SECRET', async ({ page, request }) => {
    skipUnlessDevStack();
    mcp = await mcpClient(page, request, { tag: 'auth-oidc' });
    owner = await page.context().browser()!.newContext({ storageState: await page.context().storageState() });

    const info = await callTool(mcp.client, 'skill_info', { name: 'oidc' });
    expect(info.isError, info.text).toBe(false);
    const block = /```tsx\n([\s\S]*?)```/.exec(String(info.json.content));
    expect(block, 'a ```tsx example in the oidc skill').toBeTruthy();
    expect(block![1]).toContain('<LoginGate');

    const created = await callTool(mcp.client, 'create_app', { name: 'Acme handbook', template: 'react-ts' });
    expect(created.isError, created.text).toBe(false);
    app = created.json as unknown as Created;
    host = previewHost(app.slug);
    const w = await callTool(mcp.client, 'write_files', {
      app_id: app.app_id,
      files: [{ path: 'src/main.tsx', content: block![1] }],
      reasoning: 'Company sign-in (the oidc skill example)',
    });
    expect(w.isError, w.text).toBe(false);
    expect((w.json.compile as { ok: boolean }).ok, JSON.stringify(w.json.compile)).toBe(true);
    // The installed acmecrm module observes sign-ins where it is on for the workspace.
    const ws = await personalWorkspaceOf(mcp.email);
    await withDb((c) => c.query(`INSERT INTO workspace_modules (workspace_id, module) VALUES ($1, 'acmecrm') ON CONFLICT DO NOTHING`, [ws.id]));

    const held = await callTool(mcp.client, 'configure_module', {
      app_id: app.app_id,
      module: 'auth',
      config: { allow: { domains: [DOMAIN] }, adminEmails: [BOSS], providers: { oidc: { enabled: true, issuer: ISSUER, clientId: CLIENT_ID } } },
    });
    expect(held.isError, held.text).toBe(false);
    expect(held.json).toMatchObject({ applied: false });
    expect(JSON.stringify(held.json.pending_confirmation)).toContain('oidc');
    const list = await hostRequest(host, '/__drobek/v1/auth/providers');
    expect(JSON.parse(list.body)).toEqual({ providers: [{ id: 'emailCode', label: 'E-mail code' }] });

    const op = await owner.newPage();
    await op.goto(String(held.json.confirm_url));
    await op.getByTestId('pending-panel').getByTestId('pending-confirm').click();
    await expect(op.getByTestId('done-notice')).toHaveAttribute('data-done', 'confirmed');
    const secret = op.locator('[data-testid="secret-row"][data-name="OIDC_CLIENT_SECRET"]');
    await secret.getByTestId('secret-input-OIDC_CLIENT_SECRET').fill(CLIENT_SECRET);
    await secret.getByTestId('secret-set-OIDC_CLIENT_SECRET').click();
    await expect(op.getByTestId('done-notice')).toHaveAttribute('data-done', 'secret-set');
    await op.close();

    const got = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
    const auth = (got.json.modules as Record<string, { pending: boolean; secrets: { name: string; hasSecret: boolean }[] }>).auth;
    expect(auth.pending).toBe(false);
    expect(auth.secrets).toContainEqual({ name: 'OIDC_CLIENT_SECRET', hasSecret: true });
    const after = await hostRequest(host, '/__drobek/v1/auth/providers');
    expect(JSON.parse(after.body).providers).toContainEqual({ id: 'oidc', label: 'Company account' });
  });

  test('a browser: Continue with Company account → mock consent → dashboard-host callback → handoff → signed in on the app host as admin; acmecrm recorded the contact', async ({ browser }) => {
    skipUnlessDevStack();
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const hops: string[] = [];
      page.on('request', (r) => {
        if (r.isNavigationRequest()) hops.push(r.url());
      });
      await signInThroughIdp(page, BOSS);
      await expect(page.getByText(`Signed in as ${BOSS}`)).toBeVisible();

      const callback = hops.find((u) => u.startsWith(`${BASE_URL_WEB}/__drobek/auth/callback/oidc?`));
      expect(callback, hops.join('\n')).toBeTruthy();
      const handoff = hops.find((u) => u.startsWith(`${urlOf(host)}/__drobek/v1/auth/complete?code=`));
      expect(handoff, hops.join('\n')).toBeTruthy();

      const me = await page.evaluate(async () => (await fetch('/__drobek/v1/auth/me')).json());
      expect(me.user).toMatchObject({ email: BOSS, role: 'admin' });
      const appCookies = await ctx.cookies(urlOf(host));
      expect(appCookies.map((c) => c.name)).toContain('drobek_eu');
      expect(await ctx.cookies(BASE_URL_WEB)).not.toContainEqual(expect.objectContaining({ name: 'drobek_eu' }));

      await expect
        .poll(async () =>
          withDb(async (c) => (await c.query(`SELECT source, name FROM mod_acmecrm_contacts WHERE app_id = $1 AND email = $2`, [app.app_id, BOSS])).rows)
        )
        .toEqual([{ source: 'sign-in', name: 'Mock User' }]);
      const audit = await withDb(async (c) =>
        (await c.query(`SELECT meta FROM audit_log WHERE target = $1 AND action = 'auth.sign_in' ORDER BY created_at DESC LIMIT 1`, [app.slug])).rows
      );
      expect(audit[0]?.meta).toMatchObject({ provider: 'oidc', role: 'admin' });
    } finally {
      await ctx.close();
    }
  });

  test('an address outside the allowlist → the 403 page, no session', async ({ browser }) => {
    skipUnlessDevStack();
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const callback = page.waitForResponse((r) => r.url().startsWith(`${BASE_URL_WEB}/__drobek/auth/callback/oidc`));
      await signInThroughIdp(page, OUTSIDER);
      expect((await callback).status()).toBe(403);
      await expect(page.getByRole('heading', { name: 'Not allowed' })).toBeVisible();
      expect((await ctx.cookies(urlOf(host))).map((c) => c.name)).not.toContain('drobek_eu');
      expect(JSON.parse((await hostRequest(host, '/__drobek/v1/auth/me')).body)).toEqual({ user: null });
    } finally {
      await ctx.close();
    }
  });

  test('email_verified=false without trustEmail → the "not verified" page (email_not_verified), no session', async ({ browser }) => {
    skipUnlessDevStack();
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const callback = page.waitForResponse((r) => r.url().startsWith(`${BASE_URL_WEB}/__drobek/auth/callback/oidc`));
      await signInThroughIdp(page, ANA, { verified: false });
      expect((await callback).status()).toBe(403);
      await expect(page.getByRole('heading', { name: 'E-mail address not verified' })).toBeVisible();
      expect((await ctx.cookies(urlOf(host))).map((c) => c.name)).not.toContain('drobek_eu');
      const denied = await withDb(async (c) =>
        (await c.query(`SELECT meta FROM audit_log WHERE target = $1 AND action = 'auth.sign_in_denied' ORDER BY created_at`, [app.slug])).rows
      );
      expect(denied.map((r) => r.meta)).toContainEqual(expect.objectContaining({ provider: 'oidc', reason: 'email_not_verified' }));
    } finally {
      await ctx.close();
    }
  });

  /** begin → the IdP URL (+ the flow cookie). */
  async function begin(returnTo = '/'): Promise<{ url: URL; flow: string }> {
    const r = await hostRequest(host, '/__drobek/v1/auth/begin', {
      method: 'POST',
      headers: sdkHeaders(host),
      body: JSON.stringify({ provider: 'oidc', return_to: returnTo }),
    });
    expect(r.status, r.body).toBe(200);
    const flow = cookieOf(r, /drobek_eu_flow$/);
    expect(flow, 'the flow cookie').toBeTruthy();
    return { url: new URL((JSON.parse(r.body) as { url: string }).url), flow: flow! };
  }

  test('a forged state → the 400 "Sign-in expired" page (invalid_state), no cookie', async ({ request }) => {
    skipUnlessDevStack();
    const { url } = await begin();
    const [id] = String(url.searchParams.get('state')).split('.');
    const forged = await request.get(`${BASE_URL_WEB}/__drobek/auth/callback/oidc?state=${id}.${'A'.repeat(43)}&code=x`, { maxRedirects: 0 });
    expect(forged.status()).toBe(400);
    expect(await forged.text()).toContain('Sign-in expired');
    expect(forged.headers()['set-cookie']).toBeUndefined();
  });

  test('a handoff code works once: the second complete is the 400 "Sign-in expired" page without a cookie', async ({ request }) => {
    skipUnlessDevStack();
    const { url, flow } = await begin('/after');
    url.searchParams.set('mock_approve', '1');
    url.searchParams.set('mock_email', ANA);
    const idp = await fetch(url, { redirect: 'manual' });
    expect(idp.status).toBe(302);
    const toCallback = idp.headers.get('location')!;
    expect(toCallback.startsWith(`${BASE_URL_WEB}/__drobek/auth/callback/oidc?`)).toBe(true);
    const cb = await request.get(toCallback, { maxRedirects: 0 });
    expect(cb.status(), await cb.text()).toBe(302);
    const complete = new URL(cb.headers()['location']);
    expect(complete.host).toBe(host);
    expect(complete.pathname).toBe('/__drobek/v1/auth/complete');

    const first = await hostRequest(host, `${complete.pathname}${complete.search}`, { headers: { Cookie: flow } });
    expect(first.status, first.body).toBe(302);
    expect(first.headers.location).toBe('/after');
    expect(cookieOf(first, /^(__Host-)?drobek_eu$/)).toBeTruthy();

    const again = await hostRequest(host, `${complete.pathname}${complete.search}`, { headers: { Cookie: flow } });
    expect(again.status).toBe(400);
    expect(again.body).toContain('Sign-in expired');
    expect(cookieOf(again, /^(__Host-)?drobek_eu$/)).toBeNull();
  });

  test('begin refuses return_to "//evil.example" (invalid_request)', async () => {
    skipUnlessDevStack();
    for (const bad of ['//evil.example', '//evil.example/path', 'https://evil.example/']) {
      const r = await hostRequest(host, '/__drobek/v1/auth/begin', {
        method: 'POST',
        headers: sdkHeaders(host),
        body: JSON.stringify({ provider: 'oidc', return_to: bad }),
      });
      expect(r.status, bad).toBe(400);
      expect(JSON.parse(r.body)).toMatchObject({ error: 'invalid_request', details: [{ path: 'return_to' }] });
      expect(cookieOf(r, /drobek_eu_flow$/)).toBeNull();
    }
  });
});
