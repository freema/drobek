import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { APPS_URL_SCHEME, BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, urlOf, type Raw } from './helpers/apps-host';
import { loginViaEmail, mailpitMessagesFor, pollLoginCode, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { callTool, mcpClient, type McpClient } from './helpers/mcp';
import { withDb } from './helpers/seed';

/**
 * M1-02 (NSO-294): the built-in platform module `auth` end to end on the apps
 * host (DROBEK_MODULES=hello,auth in both composes, relaxed AUTH_* limits):
 *
 *  - skill_info('auth') carries the <LoginGate> example; an agent writes it
 *    as src/main.tsx of a react-ts app and it compiles (drobek/auth is built
 *    into the app with the app's own React);
 *  - configure_module sets the allowlist + adminEmails; allow.anyone waits
 *    for the owner;
 *  - an address outside the allowlist → 403 email_not_allowed, no e-mail;
 *  - a real browser signs in through <LoginGate> with the Mailpit code and
 *    sees the gated content; the session cookie is host-only (not sent to
 *    another app's host), HttpOnly, SameSite=Lax (Secure + __Host- on https);
 *  - wrong codes → invalid_code, then too_many_attempts (PHY-76 #1);
 *  - adminEmails → role admin;
 *  - the owner's dashboard API revokes every session of the app (guards as
 *    the confirm API; audit end_users.sessions_revoke, actor_kind user);
 *  - other modules see the user as they are NOW (core asks auth on every
 *    request): adminEmails changes, a disabled user and a removed domain
 *    show up on the hello module's /whoami at once, without any me();
 *  - a POST without X-Drobek-SDK → 403 csrf_rejected.
 */

interface Created {
  app_id: string;
  slug: string;
  workspace: string;
}

interface PublicUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
}

const SECURE = APPS_URL_SCHEME === 'https';
const COOKIE = SECURE ? '__Host-drobek_eu' : 'drobek_eu';
const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const DOMAIN = `team-${STAMP}.example.org`;
const ANA = `e2e-auth-ana-${STAMP}@example.com`;
const BOSS = `e2e-auth-boss-${STAMP}@example.com`;
const EVE = `e2e-auth-eve-${STAMP}@example.com`;
const BOB = `bob-${STAMP}@${DOMAIN}`;
const DAVE = `dave-${STAMP}@${DOMAIN}`;
const ERIN = `erin-${STAMP}@${DOMAIN}`;

function sdkHeaders(host: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'Content-Type': 'application/json', Origin: urlOf(host), 'X-Drobek-SDK': '1', ...extra };
}

function post(host: string, path: string, body: unknown, headers = sdkHeaders(host)): Promise<Raw> {
  return hostRequest(host, `/__drobek/v1/auth${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function setCookieOf(r: Raw): string {
  const sc = r.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : sc ? [sc] : []).join('\n');
}

/** `name=value` of the session cookie in a Set-Cookie header. */
function cookiePair(setCookie: string): string {
  const m = new RegExp(`(?:^|\\n)(${COOKIE.replace(/[-]/g, '\\-')}=[0-9a-f]{64})`).exec(setCookie);
  expect(m, `session cookie in: ${setCookie}`).toBeTruthy();
  return m![1];
}

function expectSessionCookieAttributes(setCookie: string): void {
  expect(setCookie).toMatch(new RegExp(`^${COOKIE}=[0-9a-f]{64}; `));
  expect(setCookie).toContain('; Path=/');
  expect(setCookie).toContain('; HttpOnly');
  expect(setCookie).toContain('; SameSite=Lax');
  expect(setCookie).toMatch(/; Max-Age=2592000(;|$)/);
  expect(setCookie.toLowerCase()).not.toContain('domain=');
  if (SECURE) expect(setCookie).toContain('; Secure');
  else expect(setCookie).not.toContain('Secure');
}

/** The visitor as ANOTHER module sees them (hello's /whoami reads ctx.principal). */
async function whoami(host: string, cookie: string): Promise<{ signed_in: boolean; email?: string; role?: string }> {
  const r = await hostRequest(host, '/__drobek/v1/hello/whoami', { headers: { Cookie: cookie } });
  expect(r.status, r.body).toBe(200);
  expect(r.headers['set-cookie']).toBeUndefined(); // only the auth module writes the cookie
  return JSON.parse(r.body) as { signed_in: boolean; email?: string; role?: string };
}

async function me(host: string, cookie: string): Promise<PublicUser | null> {
  const r = await hostRequest(host, '/__drobek/v1/auth/me', { headers: { Cookie: cookie } });
  expect(r.status, r.body).toBe(200);
  return (JSON.parse(r.body) as { user: PublicUser | null }).user;
}

/** send-code → the Mailpit code → verify; returns the Cookie header value and the user. */
async function apiSignIn(request: APIRequestContext, host: string, email: string): Promise<{ cookie: string; user: PublicUser }> {
  const sent = await post(host, '/send-code', { email });
  expect(sent.status, sent.body).toBe(200);
  expect(JSON.parse(sent.body)).toMatchObject({ sent: true, email });
  const code = await pollLoginCode(request, email);
  const verified = await post(host, '/verify', { email, code });
  expect(verified.status, verified.body).toBe(200);
  const setCookie = setCookieOf(verified);
  expectSessionCookieAttributes(setCookie);
  return { cookie: cookiePair(setCookie), user: (JSON.parse(verified.body) as { user: PublicUser }).user };
}

async function createApp(mcp: McpClient, name: string, mainTsx: string): Promise<Created> {
  const created = await callTool(mcp.client, 'create_app', { name, template: 'react-ts' });
  expect(created.isError, JSON.stringify(created.json)).toBe(false);
  const app = created.json as unknown as Created;
  const w = await callTool(mcp.client, 'write_files', {
    app_id: app.app_id,
    files: [{ path: 'src/main.tsx', content: mainTsx }],
    reasoning: 'Gate the app behind the auth module (skill example)',
  });
  expect(w.isError, JSON.stringify(w.json)).toBe(false);
  expect((w.json.compile as { ok: boolean }).ok, JSON.stringify(w.json.compile)).toBe(true);
  return app;
}

function revoke(api: APIRequestContext, appId: string, origin: string | null = BASE_URL_WEB) {
  return api.post(`${BASE_URL_WEB}/api/apps/${appId}/end-user-sessions/revoke`, {
    headers: origin ? { Origin: origin } : {},
    maxRedirects: 0,
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('platform module auth — end-user sign-in (M1-02) @local', () => {
  let mcp: McpClient;
  let owner: BrowserContext;
  /** The browser of the end user ANA (kept across tests: the revoke test signs it out). */
  let endUser: BrowserContext;
  let example: string;
  let appA: Created;
  let appB: Created;
  let bossCookie: string;
  let anaCookie: string;

  test.afterAll(async () => {
    await mcp?.client.close();
    await owner?.close();
    await endUser?.close();
  });

  test("skill_info('auth') carries the LoginGate example, and the example compiles in a react-ts app", async ({ page, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'auth-module' });
    owner = await page.context().browser()!.newContext({ storageState: await page.context().storageState() });

    const list = await callTool(mcp.client, 'skill_info', {});
    expect((list.json.skills as { name: string }[]).map((s) => s.name)).toEqual(expect.arrayContaining(['hello', 'auth']));

    const info = await callTool(mcp.client, 'skill_info', { name: 'auth' });
    expect(info.isError, JSON.stringify(info.json)).toBe(false);
    expect(info.json).toMatchObject({ name: 'auth', kind: 'module', sdk: { import: "import { drobek } from 'drobek';" } });
    expect(JSON.stringify((info.json.sdk as Record<string, unknown>).inline)).toContain('drobek/auth');
    const content = String(info.json.content);
    expect(content).toContain('<LoginGate');
    expect(content.split('\n').length).toBeLessThanOrEqual(150);
    const limits = (info.json.limits as { name: string }[]).map((l) => l.name);
    expect(limits).toEqual(expect.arrayContaining(['AUTH_CODES_PER_IP_15MIN', 'AUTH_ATTEMPTS_PER_IP_15MIN', 'END_USERS_MAX_PER_APP']));

    const block = /```tsx\n([\s\S]*?)```/.exec(content);
    expect(block, 'a ```tsx example in the skill').toBeTruthy();
    example = block![1];
    expect(example).toContain("from 'drobek/auth'");
    appA = await createApp(mcp, 'Auth board A', example);
    appB = await createApp(mcp, 'Auth board B', example);
  });

  test('configure_module: allowlist + adminEmails apply; allow.anyone waits for the owner', async () => {
    skipUnlessLocal();
    const bad = await callTool(mcp.client, 'configure_module', {
      app_id: appA.app_id,
      module: 'auth',
      config: { allow: { emails: ['not-an-address'] } },
    });
    expect(bad.isError).toBe(true);
    expect(bad.json).toMatchObject({ code: 'invalid_params', issues: [{ path: 'allow.emails[0]' }] });

    const ok = await callTool(mcp.client, 'configure_module', {
      app_id: appA.app_id,
      module: 'auth',
      config: { allow: { emails: [ANA.toUpperCase()], domains: [DOMAIN] }, adminEmails: [BOSS] },
    });
    expect(ok.isError, JSON.stringify(ok.json)).toBe(false);
    expect(ok.json).toMatchObject({
      applied: true,
      config: { allow: { emails: [ANA], domains: [DOMAIN], anyone: false }, adminEmails: [BOSS] },
    });

    const anyone = await callTool(mcp.client, 'configure_module', { app_id: appA.app_id, module: 'auth', config: { allow: { anyone: true } } });
    expect(anyone.isError, JSON.stringify(anyone.json)).toBe(false);
    expect(anyone.json).toMatchObject({ applied: false });
    expect(String(anyone.json.confirm_url)).toContain(`/apps/${appA.slug}/modules/auth`);
    // Drop the pending change again (the owner rejects it).
    const rej = await owner.request.post(`${BASE_URL_WEB}/api/apps/${appA.app_id}/modules/auth/reject`, {
      headers: { Origin: BASE_URL_WEB },
      maxRedirects: 0,
    });
    expect(rej.status(), await rej.text()).toBe(200);
  });

  test('an address outside the allowlist → 403 email_not_allowed and no e-mail', async ({ request }) => {
    skipUnlessLocal();
    const host = previewHost(appA.slug);
    const r = await post(host, '/send-code', { email: EVE });
    expect(r.status, r.body).toBe(403);
    expect(JSON.parse(r.body)).toMatchObject({ error: 'email_not_allowed' });
    // App B has no allowlist at all: only the workspace editors may sign in there.
    const b = await post(previewHost(appB.slug), '/send-code', { email: ANA });
    expect(b.status, b.body).toBe(403);
    await new Promise((res) => setTimeout(res, 1500));
    expect(await mailpitMessagesFor(request, EVE)).toHaveLength(0);
    expect(await mailpitMessagesFor(request, ANA)).toHaveLength(0);
  });

  test('a browser signs in through <LoginGate> with the Mailpit code; the cookie stays on its host', async ({ browser, request }) => {
    skipUnlessLocal();
    endUser = await browser.newContext();
    const page = await endUser.newPage();
    const hostA = previewHost(appA.slug);
    await page.goto(urlOf(hostA));
    await page.getByLabel('Email').fill(ANA);
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByLabel('Code')).toBeVisible();

    const code = await pollLoginCode(request, ANA);
    const [mail] = await mailpitMessagesFor(request, ANA);
    expect(mail.Subject).toBe(`${code} is your sign-in code for Auth board A`);

    await page.getByLabel('Code').fill(code);
    const verified = page.waitForResponse((r) => r.url().endsWith('/__drobek/v1/auth/verify'));
    await page.getByRole('button', { name: 'Sign in' }).click();
    const res = await verified;
    expect(res.status()).toBe(200);
    const setCookie = (await res.headerValue('set-cookie')) ?? '';
    expectSessionCookieAttributes(setCookie);
    anaCookie = cookiePair(setCookie);
    await expect(page.locator('#who')).toHaveText(`Signed in as ${ANA} (user)`);
    await expect(page.getByRole('heading', { name: 'Team board' })).toBeVisible();

    // A reload keeps the session: the browser sends the cookie to THIS host.
    const meA = page.waitForRequest((r) => r.url().endsWith('/__drobek/v1/auth/me'));
    await page.reload();
    expect((await (await meA).allHeaders()).cookie ?? '').toContain(`${COOKIE}=`);
    await expect(page.locator('#who')).toHaveText(`Signed in as ${ANA} (user)`);

    // Another app's host never gets it (host-only cookie): signed out there.
    const meB = page.waitForRequest((r) => r.url().endsWith('/__drobek/v1/auth/me'));
    await page.goto(urlOf(previewHost(appB.slug)));
    const req = await meB;
    expect(new URL(req.url()).host).toBe(previewHost(appB.slug));
    expect((await req.allHeaders()).cookie ?? '').not.toContain('drobek_eu');
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.locator('#who')).toHaveCount(0);
    expect(await me(previewHost(appB.slug), anaCookie)).toBeNull();
    expect(await me(hostA, anaCookie)).toMatchObject({ email: ANA, role: 'user' });
    await page.close();
  });

  test('wrong codes → invalid_code, then too_many_attempts (even for the right code)', async ({ request }) => {
    skipUnlessLocal();
    const host = previewHost(appA.slug);
    const sent = await post(host, '/send-code', { email: BOB });
    expect(sent.status, sent.body).toBe(200);
    const code = await pollLoginCode(request, BOB);
    const wrong = code === '000000' ? '111111' : '000000';
    const errors: string[] = [];
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await post(host, '/verify', { email: BOB, code: wrong });
      statuses.push(r.status);
      errors.push((JSON.parse(r.body) as { error: string }).error);
    }
    expect(errors).toEqual(['invalid_code', 'invalid_code', 'invalid_code', 'invalid_code', 'too_many_attempts', 'too_many_attempts']);
    expect(statuses).toEqual([400, 400, 400, 400, 429, 429]);
    const right = await post(host, '/verify', { email: BOB, code });
    expect(right.status).toBe(429);
    expect(JSON.parse(right.body)).toMatchObject({ error: 'too_many_attempts' });
    expect(setCookieOf(right)).toBe('');
  });

  test('adminEmails → role admin', async ({ request }) => {
    skipUnlessLocal();
    const host = previewHost(appA.slug);
    const boss = await apiSignIn(request, host, BOSS);
    expect(boss.user).toMatchObject({ email: BOSS, role: 'admin' });
    expect(boss.user.id).toMatch(/^eu_[0-9a-f]{24}$/);
    bossCookie = boss.cookie;
    expect(await me(host, bossCookie)).toMatchObject({ email: BOSS, role: 'admin' });
    const rows = await withDb(async (c) =>
      (await c.query(`SELECT email, role FROM mod_auth_users WHERE app_id = $1 ORDER BY email`, [appA.app_id])).rows
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { email: ANA, role: 'user' },
        { email: BOSS, role: 'admin' },
      ])
    );
  });

  test('the owner revokes every session of the app (dashboard API guards, audit actor user)', async ({ browser, request }) => {
    skipUnlessLocal();
    const host = previewHost(appA.slug);
    const api = owner.request;
    // Guards: no Origin → 403; an app host Origin → 403; anonymous → 401; unknown app → 404; GET → 405.
    expect((await revoke(api, appA.app_id, null)).status()).toBe(403);
    expect((await revoke(api, appA.app_id, urlOf(host))).status()).toBe(403);
    expect((await revoke(request, appA.app_id)).status()).toBe(401);
    expect((await revoke(api, 'no-such-app')).status()).toBe(404);
    expect((await api.get(`${BASE_URL_WEB}/api/apps/${appA.app_id}/end-user-sessions/revoke`, { maxRedirects: 0 })).status()).toBe(405);
    // Another dashboard user: the same 404 as an unknown app (anti-enumeration).
    const otherPage = await browser.newPage();
    try {
      await loginViaEmail(otherPage, request, uniqueEmail('auth-other'));
      const res = await revoke(otherPage.request, appA.app_id);
      expect(res.status()).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'not_found' });
    } finally {
      await otherPage.close();
    }
    // Nothing was revoked by the refused calls.
    expect(await me(host, bossCookie)).toMatchObject({ email: BOSS });
    expect(await me(host, anaCookie)).toMatchObject({ email: ANA });

    const res = await revoke(api, appA.app_id);
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, app_id: appA.app_id, epoch: expect.any(Number) });

    expect(await me(host, bossCookie)).toBeNull();
    expect(await me(host, anaCookie)).toBeNull();
    const page = await endUser.newPage();
    await page.goto(urlOf(host));
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.locator('#who')).toHaveCount(0);
    await page.close();

    const rows = await withDb(async (c) =>
      (
        await c.query(`SELECT actor_kind, meta FROM audit_log WHERE target = $1 AND action = 'end_users.sessions_revoke'`, [
          appA.slug,
        ])
      ).rows as { actor_kind: string; meta: { epoch: number } }[]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_kind).toBe('user');
    // Sign-ins are audited too.
    const signIns = await withDb(async (c) =>
      (await c.query(`SELECT count(*)::int AS n FROM audit_log WHERE target = $1 AND action = 'auth.sign_in'`, [appA.slug])).rows[0]
        .n as number
    );
    expect(signIns).toBeGreaterThanOrEqual(2);

    // A new sign-in works after the revocation.
    const again = await apiSignIn(request, host, `carol-${STAMP}@${DOMAIN}`);
    expect(again.user.role).toBe('user');
    expect(await me(host, again.cookie)).toMatchObject({ role: 'user' });
  });

  test('other modules see the user as they are NOW: adminEmails, disabled, allowlist — no me() needed', async ({ request }) => {
    skipUnlessLocal();
    const host = previewHost(appA.slug);
    const configure = async (config: Record<string, unknown>) => {
      const r = await callTool(mcp.client, 'configure_module', { app_id: appA.app_id, module: 'auth', config });
      expect(r.isError, JSON.stringify(r.json)).toBe(false);
      expect(r.json).toMatchObject({ applied: true });
    };
    const dave = await apiSignIn(request, host, DAVE);
    expect(await whoami(host, dave.cookie)).toEqual({ signed_in: true, id: dave.user.id, email: DAVE, role: 'user' });
    expect(await whoami(previewHost(appB.slug), dave.cookie)).toEqual({ signed_in: false });

    await configure({ adminEmails: [BOSS, DAVE] });
    expect(await whoami(host, dave.cookie)).toMatchObject({ signed_in: true, role: 'admin' });
    await configure({ adminEmails: [BOSS] });
    expect(await whoami(host, dave.cookie)).toMatchObject({ signed_in: true, role: 'user' });

    // Disabled in the database → anonymous on the next request, and the session is gone for good.
    const erin = await apiSignIn(request, host, ERIN);
    expect(await whoami(host, erin.cookie)).toMatchObject({ signed_in: true, email: ERIN });
    const setDisabled = (on: boolean) =>
      withDb((c) =>
        c.query(`UPDATE mod_auth_users SET disabled_at = ${on ? 'now()' : 'NULL'} WHERE app_id = $1 AND email = $2`, [appA.app_id, ERIN])
      );
    await setDisabled(true);
    expect(await whoami(host, erin.cookie)).toEqual({ signed_in: false });
    await setDisabled(false);
    expect(await whoami(host, erin.cookie)).toEqual({ signed_in: false });
    expect(await me(host, erin.cookie)).toBeNull();

    // The domain leaves the allowlist → its users are anonymous at once.
    await configure({ allow: { domains: [] } });
    expect(await whoami(host, dave.cookie)).toEqual({ signed_in: false });
    expect(await me(host, dave.cookie)).toBeNull();
    await configure({ allow: { domains: [DOMAIN] } });
  });

  test('a POST without X-Drobek-SDK (or from another origin) → 403 csrf_rejected', async () => {
    skipUnlessLocal();
    const host = previewHost(appA.slug);
    const noHeader = await post(host, '/send-code', { email: ANA }, { 'Content-Type': 'application/json', Origin: urlOf(host) });
    expect(noHeader.status).toBe(403);
    expect(JSON.parse(noHeader.body)).toMatchObject({ error: 'csrf_rejected' });
    const foreign = await post(host, '/verify', { email: ANA, code: '123456' }, sdkHeaders(host, { Origin: 'https://evil.example' }));
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body)).toMatchObject({ error: 'csrf_rejected' });
    const logout = await post(host, '/logout', {}, { 'Content-Type': 'application/json', Origin: urlOf(host) });
    expect(logout.status).toBe(403);
  });
});
