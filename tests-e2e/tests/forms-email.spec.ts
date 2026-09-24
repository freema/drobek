import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { Redis } from 'ioredis';
import { APPS_URL_SCHEME, BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, urlOf, type Raw } from './helpers/apps-host';
import { MAILPIT_URL, mailpitMessagesFor, ownClientIpHeaders, resetRateLimitBucket, skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient, type McpClient } from './helpers/mcp';
import { withDb } from './helpers/seed';

/**
 * M1-04 (NSO-295): the built-in platform modules `forms` and `email` end to
 * end on the apps host (DROBEK_MODULES=hello,auth,email,forms in both
 * composes):
 *
 *  - skill_info('forms') / skill_info('email') carry React examples; an agent
 *    writes each as src/main.tsx of a react-ts app and it compiles;
 *  - a real browser submits <Form name="contact"> → a DB row + a Mailpit
 *    notification to the app's owner, the HTML escaped;
 *  - a filled honeypot → 200 "ok", nothing stored or sent, a counter in the
 *    server log; a submit < 2 s after its token → 429 submitted_too_fast;
 *  - the 11th submit from one IP within an hour → 429 (the spec sends its own
 *    X-Real-IP — on the dev stack a request without one has no per-IP bucket;
 *    behind Caddy every request is the runner's IP, so it resets the bucket
 *    before it counts and after);
 *  - notify.emails changed by the agent → pending; the owner confirms it
 *    through the dashboard confirm API; the address then gets the mail;
 *  - admins list the submissions and export CSV (formula-neutralized,
 *    no-store, audited); plain users and visitors are refused;
 *  - notifyAdmins through <LoginGate> in a browser, fromName applied; the
 *    21st call of the day → 429 limit_exceeded;
 *  - the operator-wide hourly e-mail budgets (NSO-320): notifications past
 *    theirs (forms of two apps) → notifications pause (503 email_paused)
 *    with a super-admin ALERT line, a form submission is still stored, and
 *    the auth module's send-code still delivers a code (own budget); one app
 *    past its hourly share → only that app's notifications are refused.
 */

interface Created {
  app_id: string;
  slug: string;
  workspace: string;
}

interface MailDetail {
  ID: string;
  Subject: string;
  From: { Name: string; Address: string };
  ReplyTo?: { Name: string; Address: string }[];
  To: { Address: string }[];
  Text: string;
  HTML: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECURE = APPS_URL_SCHEME === 'https';
const COOKIE = SECURE ? '__Host-drobek_eu' : 'drobek_eu';
const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const SALES = `e2e-forms-sales-${STAMP}@example.com`;
const ANA = `e2e-forms-ana-${STAMP}@example.com`;
const CAROL = `e2e-forms-carol-${STAMP}@example.com`;
const DAVE = `e2e-forms-dave-${STAMP}@example.com`;
// The operator-wide e-mail budgets (NSO-320, mail-guard.ts): Redis keys and
// the values both composes derive from EMAIL_GLOBAL_HOURLY_MAX 1000.
const MAIL_NOTIFY_COUNTER = 'drobek:rl:mail:notification';
const MAIL_NOTIFY_PAUSE = 'drobek:mail:paused:notification';
const MAIL_SIGNIN_PAUSE = 'drobek:mail:paused:sign_in';
const NOTIFY_BUDGET = 800;
const APP_SHARE = 200;
const FORMS_APP = `Forms bakery ${STAMP}`;
const EMAIL_APP = `Stock ${STAMP}`;

function sdkHeaders(host: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'Content-Type': 'application/json', Origin: urlOf(host), 'X-Drobek-SDK': '1', ...extra };
}

function post(host: string, path: string, body: unknown, extra: Record<string, string> = {}): Promise<Raw> {
  return hostRequest(host, `/__drobek/v1${path}`, { method: 'POST', headers: sdkHeaders(host, extra), body: JSON.stringify(body) });
}

function get(host: string, path: string, cookie?: string): Promise<Raw> {
  return hostRequest(host, `/__drobek/v1${path}`, { headers: cookie ? { Cookie: cookie } : {} });
}

async function formToken(host: string, form: string): Promise<string> {
  const r = await get(host, `/forms/${form}/token`);
  expect(r.status, r.body).toBe(200);
  const body = JSON.parse(r.body) as { token: string; min_wait_ms: number; expires_in: number };
  expect(body).toMatchObject({ min_wait_ms: 2000, expires_in: 7200 });
  return body.token;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function submissionsOf(appId: string, form: string): Promise<{ id: string; data: Record<string, unknown>; notified: boolean }[]> {
  return withDb(async (c) =>
    (
      await c.query(
        `SELECT id, data, notified_at IS NOT NULL AS notified FROM mod_forms_submissions WHERE app_id = $1 AND form = $2 ORDER BY created_at, id`,
        [appId, form]
      )
    ).rows as { id: string; data: Record<string, unknown>; notified: boolean }[]
  );
}

async function mailDetail(request: APIRequestContext, id: string): Promise<MailDetail> {
  const res = await request.get(`${MAILPIT_URL}/api/v1/message/${id}`);
  expect(res.ok()).toBeTruthy();
  const mail = (await res.json()) as MailDetail;
  return { ...mail, Text: mail.Text.replace(/\r\n/g, '\n') };
}

/** Mails to `email` whose subject contains `subject` (newest first). */
async function mailsWith(request: APIRequestContext, email: string, subject: string): Promise<MailDetail[]> {
  const metas = (await mailpitMessagesFor(request, email.toLowerCase())).filter((m) => (m.Subject ?? '').includes(subject));
  return Promise.all(metas.map((m) => mailDetail(request, m.ID)));
}

async function pollMails(request: APIRequestContext, email: string, subject: string, count = 1): Promise<MailDetail[]> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const got = await mailsWith(request, email, subject);
    if (got.length >= count || Date.now() > deadline) return got;
    await sleep(300);
  }
}

/** The server's log lines (JSON) since `sinceIso` that contain `needle`. */
function serverLogLines(sinceIso: string, needle: string): Record<string, unknown>[] {
  const out = execSync(`docker compose logs --no-color --no-log-prefix --since ${sinceIso} drobek`, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .filter((l) => l.includes(needle))
    .flatMap((l) => {
      try {
        return [JSON.parse(l.slice(l.indexOf('{'))) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

async function pollLog(sinceIso: string, needle: string): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const lines = serverLogLines(sinceIso, needle);
    if (lines.length > 0 || Date.now() > deadline) return lines;
    await sleep(500);
  }
}

/** A minute back, so a host/daemon clock skew never hides a line (lines are matched by a unique app id). */
function logSince(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

function setCookieOf(r: Raw): string {
  const sc = r.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : sc ? [sc] : []).join('\n');
}

/**
 * The sign-in code mailed to `email` for `appName` (the owner gets several
 * apps' codes and notifications in this spec: match the subject).
 */
async function pollCode(request: APIRequestContext, email: string, appName: string): Promise<string> {
  const [mail] = await pollMails(request, email, `is your sign-in code for ${appName}`);
  expect(mail, `a sign-in code for ${appName}`).toBeTruthy();
  return /^(\d{6}) /.exec(mail.Subject)![1];
}

/** send-code → the Mailpit code → verify; the Cookie header value. */
async function apiSignIn(request: APIRequestContext, host: string, email: string, appName: string): Promise<string> {
  const sent = await post(host, '/auth/send-code', { email });
  expect(sent.status, sent.body).toBe(200);
  const code = await pollCode(request, email, appName);
  const verified = await post(host, '/auth/verify', { email, code });
  expect(verified.status, verified.body).toBe(200);
  const m = new RegExp(`(${COOKIE.replace(/[-]/g, '\\-')}=[0-9a-f]{64})`).exec(setCookieOf(verified));
  expect(m).toBeTruthy();
  return m![1];
}

async function redisClient(): Promise<Redis> {
  const url = process.env.REDIS_URL;
  expect(url, 'REDIS_URL (the local stack)').toBeTruthy();
  const r = new Redis(url!, { maxRetriesPerRequest: 2, lazyConnect: true });
  await r.connect();
  return r;
}

async function createApp(mcp: McpClient, name: string, mainTsx: string): Promise<Created> {
  const created = await callTool(mcp.client, 'create_app', { name, template: 'react-ts' });
  expect(created.isError, JSON.stringify(created.json)).toBe(false);
  const app = created.json as unknown as Created;
  const w = await callTool(mcp.client, 'write_files', {
    app_id: app.app_id,
    files: [{ path: 'src/main.tsx', content: mainTsx }],
    reasoning: 'Use the module skill example',
  });
  expect(w.isError, JSON.stringify(w.json)).toBe(false);
  expect((w.json.compile as { ok: boolean }).ok, JSON.stringify(w.json.compile)).toBe(true);
  return app;
}

async function skillExample(mcp: McpClient, name: string, mustContain: string[]): Promise<string> {
  const info = await callTool(mcp.client, 'skill_info', { name });
  expect(info.isError, JSON.stringify(info.json)).toBe(false);
  expect(info.json).toMatchObject({ name, kind: 'module' });
  const content = String(info.json.content);
  expect(content.split('\n').length).toBeLessThanOrEqual(150);
  const block = /```tsx\n([\s\S]*?)```/.exec(content);
  expect(block, `a \`\`\`tsx example in skill_info('${name}')`).toBeTruthy();
  for (const s of mustContain) expect(block![1]).toContain(s);
  return block![1];
}

test.describe.configure({ mode: 'serial' });

test.describe('platform modules forms + email (M1-04) @local', () => {
  let mcp: McpClient;
  let owner: BrowserContext;
  let formsApp: Created;
  let emailApp: Created;
  let ownerFormsCookie: string;

  test.afterAll(async () => {
    await mcp?.client.close();
    await owner?.close();
  });

  test("skill_info('forms') and skill_info('email'): the React examples compile in react-ts apps", async ({ page, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'forms-module' });
    owner = await page.context().browser()!.newContext({ storageState: await page.context().storageState() });

    const list = await callTool(mcp.client, 'skill_info', {});
    expect((list.json.skills as { name: string }[]).map((s) => s.name)).toEqual(expect.arrayContaining(['hello', 'auth', 'email', 'forms']));

    const forms = await callTool(mcp.client, 'skill_info', { name: 'forms' });
    expect(JSON.stringify((forms.json.sdk as Record<string, unknown>).inline)).toContain('drobek/forms');
    expect((forms.json.limits as { name: string }[]).map((l) => l.name)).toEqual(
      expect.arrayContaining(['FORMS_SUBMITS_PER_IP_HOUR', 'FORMS_PER_APP_PER_DAY'])
    );
    const email = await callTool(mcp.client, 'skill_info', { name: 'email' });
    expect((email.json.limits as { name: string }[]).map((l) => l.name)).toEqual(
      expect.arrayContaining(['EMAIL_PER_APP_PER_DAY', 'EMAIL_NOTIFY_ADMINS_PER_DAY'])
    );

    formsApp = await createApp(mcp, FORMS_APP, await skillExample(mcp, 'forms', ["from 'drobek/forms'", '<Form name="contact"']));
    emailApp = await createApp(mcp, EMAIL_APP, await skillExample(mcp, 'email', ['drobek.email.notifyAdmins(', '<LoginGate']));
  });

  test('a browser submits <Form name="contact"> → a DB row + an escaped notification to the owner', async ({ browser, request }) => {
    skipUnlessLocal();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(urlOf(previewHost(formsApp.slug)));
      const message = 'Hello <script>alert("xss")</script> & <b>bold</b>\nsecond line';
      await page.getByLabel('Name').fill('Ana Nováková');
      await page.getByLabel('Email').fill(ANA);
      await page.getByLabel('Message').fill(message);
      const res = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/__drobek/v1/forms/contact'));
      await page.getByRole('button', { name: 'Send' }).click();
      const submitted = await res;
      expect(submitted.status()).toBe(200);
      const { id } = (await submitted.json()) as { ok: true; id: string };
      await expect(page.locator('#thanks')).toHaveText('Thanks, we will get back to you.');

      const rows = await submissionsOf(formsApp.app_id, 'contact');
      expect(rows).toEqual([{ id, data: { name: 'Ana Nováková', email: ANA, message }, notified: true }]);

      const [mail] = await pollMails(request, mcp.email, `New "contact" submission — ${FORMS_APP}`);
      expect(mail, 'the owner got the notification').toBeTruthy();
      expect(mail.To.map((t) => t.Address)).toEqual([mcp.email]);
      expect(mail.Text).toContain('message:\n  Hello <script>alert("xss")</script> & <b>bold</b>\n  second line');
      expect(mail.Text).toContain(`Submission ${id}`);
      expect(mail.HTML).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;');
      expect(mail.HTML).not.toContain('<script>');
      expect(mail.HTML).not.toContain('<b>bold');

      // The audit trail counts the e-mail without any address.
      const audit = await withDb(async (c) =>
        (await c.query(`SELECT meta FROM audit_log WHERE action = 'email.send' AND target = $1`, [formsApp.slug])).rows.map((r) => r.meta)
      );
      expect(audit).toEqual([expect.objectContaining({ module: 'forms', kind: 'notification', recipients: 1 })]);
      expect(JSON.stringify(audit)).not.toContain('@');
    } finally {
      await ctx.close();
    }
  });

  test('a filled honeypot → 200 "ok", nothing stored or sent, a counter in the log; < 2 s → 429', async ({ request }) => {
    skipUnlessLocal();
    const host = previewHost(formsApp.slug);
    const since = logSince();
    const before = (await mailsWith(request, mcp.email, 'submission')).length;
    const t = await formToken(host, 'contact');
    await sleep(2_100);
    const bot = await post(host, '/forms/contact', { _t: t, _hp: 'https://spam.example', name: 'bot-field-value' });
    expect(bot.status, bot.body).toBe(200);
    expect(JSON.parse(bot.body)).toEqual({ ok: true, id: expect.stringMatching(/^fs_[0-9a-f]{24}$/) });
    const [line] = await pollLog(since, `"forms_honeypot_drop"`).then((l) => l.filter((x) => x.app_id === formsApp.app_id));
    expect(line, 'a honeypot log line').toMatchObject({ level: 'info', event: 'forms_honeypot_drop', form: 'contact', dropped_today: 1 });
    expect(JSON.stringify(serverLogLines(since, formsApp.app_id))).not.toContain('bot-field-value');

    const fresh = await formToken(host, 'contact');
    const fast = await post(host, '/forms/contact', { _t: fresh, name: 'Too fast' });
    expect(fast.status, fast.body).toBe(429);
    expect(JSON.parse(fast.body)).toMatchObject({ error: 'submitted_too_fast', details: { min_wait_ms: 2000 } });
    expect(Number(fast.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    const forged = await post(host, '/forms/contact', { _t: `${fresh.slice(0, -2)}xx`, name: 'Forged' });
    expect(forged.status).toBe(400);
    expect(JSON.parse(forged.body)).toMatchObject({ error: 'invalid_form_token' });

    expect(await submissionsOf(formsApp.app_id, 'contact')).toHaveLength(1);
    await sleep(1_000);
    expect(await mailsWith(request, mcp.email, 'submission')).toHaveLength(before);
  });

  test('the 11th submit from one IP within an hour → 429 rate_limited', async () => {
    skipUnlessLocal();
    const host = previewHost(formsApp.slug);
    // Store-only form (no mail), applied at once: no confirmation for owners:false.
    const cfg = await callTool(mcp.client, 'configure_module', {
      app_id: formsApp.app_id,
      module: 'forms',
      config: { forms: { burst: { notify: { owners: false } } } },
    });
    expect(cfg.json, JSON.stringify(cfg.json)).toMatchObject({ applied: true });
    // Behind Caddy the earlier submits of this spec came from the same IP.
    await resetRateLimitBucket(`mod:forms:${formsApp.app_id}:submit-ip`);
    const ip = ownClientIpHeaders();
    const t = await formToken(host, 'burst');
    await sleep(2_100);
    const statuses: number[] = [];
    for (let i = 1; i <= 11; i++) statuses.push((await post(host, '/forms/burst', { _t: t, n: i }, ip)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 429]);
    const over = await post(host, '/forms/burst', { _t: t, n: 12 }, ip);
    expect(JSON.parse(over.body)).toMatchObject({ error: 'rate_limited', details: { limit: 10, window_seconds: 3600 } });
    expect(over.headers['retry-after']).toBeTruthy();
    expect(await submissionsOf(formsApp.app_id, 'burst')).toHaveLength(10);
    await resetRateLimitBucket(`mod:forms:${formsApp.app_id}:submit-ip`);
  });

  test('notify.emails set by the agent waits for the owner; confirmed → the address gets the mail', async ({ request }) => {
    skipUnlessLocal();
    const host = previewHost(formsApp.slug);
    const r = await callTool(mcp.client, 'configure_module', {
      app_id: formsApp.app_id,
      module: 'forms',
      config: { forms: { contact: { notify: { emails: [SALES] } } } },
    });
    expect(r.isError, JSON.stringify(r.json)).toBe(false);
    expect(r.json).toMatchObject({ applied: false });
    expect(JSON.stringify(r.json.pending_confirmation)).toContain(SALES);
    expect(String(r.json.confirm_url)).toContain(`/apps/${formsApp.slug}/modules/forms`);

    // Pending: a submission still reaches the owner only.
    const t = await formToken(host, 'contact');
    await sleep(2_100);
    expect((await post(host, '/forms/contact', { _t: t, name: 'Before confirm' })).status).toBe(200);
    await pollMails(request, mcp.email, 'submission', 2);
    expect(await mailsWith(request, SALES, 'submission')).toHaveLength(0);

    // An app host may not confirm (Origin guard); the owner's dashboard can.
    const foreign = await owner.request.post(`${BASE_URL_WEB}/api/apps/${formsApp.app_id}/modules/forms/confirm`, {
      headers: { Origin: urlOf(host) },
      maxRedirects: 0,
    });
    expect(foreign.status()).toBe(403);
    const ok = await owner.request.post(`${BASE_URL_WEB}/api/apps/${formsApp.app_id}/modules/forms/confirm`, {
      headers: { Origin: BASE_URL_WEB },
      maxRedirects: 0,
    });
    expect(ok.status(), await ok.text()).toBe(200);

    expect((await post(host, '/forms/contact', { _t: t, name: 'After confirm' })).status).toBe(200);
    const [mail] = await pollMails(request, SALES, `New "contact" submission — ${FORMS_APP}`);
    expect(mail, 'the confirmed address got the submission').toBeTruthy();
    expect(mail.Text).toContain('name: After confirm');
    // One message per address: recipients never see each other.
    expect(mail.To.map((x) => x.Address)).toEqual([SALES]);
  });

  test('admins list + export submissions (CSV formula-neutralized, no-store, audited); others are refused', async ({ request }) => {
    skipUnlessLocal();
    const host = previewHost(formsApp.slug);
    const t = await formToken(host, 'contact');
    await sleep(2_100);
    expect((await post(host, '/forms/contact', { _t: t, name: '=HYPERLINK("https://evil.example")', note: '@SUM(1)' })).status).toBe(200);

    expect((await get(host, '/forms/contact/submissions')).status).toBe(401);
    // A plain signed-in user (allow-listed, not an admin) → 403.
    const cfg = await callTool(mcp.client, 'configure_module', { app_id: formsApp.app_id, module: 'auth', config: { allow: { emails: [ANA] } } });
    expect(cfg.json, JSON.stringify(cfg.json)).toMatchObject({ applied: true });
    const ana = await apiSignIn(request, host, ANA, FORMS_APP);
    expect((await get(host, '/forms/contact/submissions', ana)).status).toBe(403);
    expect((await get(host, '/forms/contact/submissions.csv', ana)).status).toBe(403);

    // The owner (a workspace editor) signs in to the app as an admin.
    ownerFormsCookie = await apiSignIn(request, host, mcp.email, FORMS_APP);
    const list = await get(host, '/forms/contact/submissions?limit=2', ownerFormsCookie);
    expect(list.status, list.body).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(list.body) as { submissions: { data: Record<string, unknown> }[]; next_cursor: string | null };
    expect(body.submissions.map((s) => s.data.name)).toEqual(['=HYPERLINK("https://evil.example")', 'After confirm']);
    expect(body.next_cursor).toBeTruthy();
    const next = JSON.parse((await get(host, `/forms/contact/submissions?limit=50&before=${body.next_cursor}`, ownerFormsCookie)).body) as typeof body;
    expect(next.submissions.map((s) => s.data.name)).toEqual(['Before confirm', 'Ana Nováková']);

    const csv = await get(host, '/forms/contact/submissions.csv', ownerFormsCookie);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="contact-submissions.csv"');
    expect(csv.headers['cache-control']).toBe('no-store');
    const lines = csv.body.split('\r\n');
    expect(lines[0]).toBe('id,created_at,email,message,name,note');
    expect(csv.body).toContain(`,"'=HYPERLINK(""https://evil.example"")",'@SUM(1)`);
    expect(csv.body).not.toMatch(/(^|,)=HYPERLINK/m);
    const audit = await withDb(async (c) =>
      (await c.query(`SELECT meta FROM audit_log WHERE action = 'forms.export' AND target = $1`, [formsApp.slug])).rows.map((r) => r.meta)
    );
    expect(audit).toEqual([expect.objectContaining({ form: 'contact', rows: 4, module: 'forms' })]);
  });

  test('notifyAdmins through <LoginGate> in a browser (fromName applied); the 21st of the day → 429 limit_exceeded', async ({ browser, request }) => {
    skipUnlessLocal();
    const host = previewHost(emailApp.slug);
    const from = await callTool(mcp.client, 'configure_module', { app_id: emailApp.app_id, module: 'email', config: { fromName: 'Stock bot' } });
    expect(from.json, JSON.stringify(from.json)).toMatchObject({ applied: true, config: { fromName: 'Stock bot' } });
    const replyTo = await callTool(mcp.client, 'configure_module', { app_id: emailApp.app_id, module: 'email', config: { replyTo: SALES } });
    expect(replyTo.json).toMatchObject({ applied: false });

    const anon = await post(host, '/email/notify-admins', { subject: 'Hi', text: 'Anyone?' });
    expect(anon.status).toBe(401);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(urlOf(host));
      await page.getByLabel('Email').fill(mcp.email);
      await page.getByRole('button', { name: 'Send code' }).click();
      await expect(page.getByLabel('Code')).toBeVisible();
      await page.getByLabel('Code').fill(await pollCode(request, mcp.email, EMAIL_APP));
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.getByRole('button', { name: 'Ask the owners for access' }).click();
      await expect(page.getByRole('status')).toHaveText('The owners were notified.');
      const cookie = (await ctx.cookies(urlOf(host))).find((c) => c.name === COOKIE);
      expect(cookie).toBeTruthy();
      const cookieHeader = `${cookie!.name}=${cookie!.value}`;

      const [mail] = await pollMails(request, mcp.email, `[${EMAIL_APP}] Access request`);
      expect(mail, 'the owner got the notice').toBeTruthy();
      expect(mail.From.Name).toBe('Stock bot');
      expect(mail.ReplyTo ?? []).toEqual([]); // the pending replyTo is not applied
      expect(mail.Text).toContain('Please give me access to the stock list.');
      expect(mail.Text).toContain(mcp.email); // who sent it

      // Calls 2..20 succeed; the markup in the text is escaped in the HTML.
      for (let i = 2; i <= 20; i++) {
        const r = await post(host, '/email/notify-admins', { subject: `Ping ${i}`, text: '<img src=x onerror=alert(1)>' }, { Cookie: cookieHeader });
        expect(r.status, `#${i}: ${r.body}`).toBe(200);
        expect(JSON.parse(r.body)).toEqual({ sent: 1 });
      }
      const over = await post(host, '/email/notify-admins', { subject: 'Ping 21', text: 'x' }, { Cookie: cookieHeader });
      expect(over.status, over.body).toBe(429);
      expect(JSON.parse(over.body)).toMatchObject({ error: 'limit_exceeded', details: { limit: 'EMAIL_NOTIFY_ADMINS_PER_DAY', value: 20 } });
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);

      const pings = await pollMails(request, mcp.email, `[${EMAIL_APP}] Ping`, 19);
      expect(pings).toHaveLength(19);
      expect(pings[0].HTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(pings[0].HTML).not.toContain('<img src=x');
    } finally {
      await ctx.close();
    }
  });

  // NSO-320: EMAIL_GLOBAL_HOURLY_MAX 1000 in both composes → 200 reserved for
  // sign-in codes (EMAIL_SIGNIN_HOURLY_MAX), 800 for notifications, one app
  // at most 25 % of those (EMAIL_APP_HOURLY_SHARE) = 200.
  test('notifications past their hourly budget pause (503 email_paused + ALERT); sign-in codes keep going; submissions are still stored', async ({ request }) => {
    skipUnlessLocal();
    const formsHost = previewHost(formsApp.slug);
    const emailHost = previewHost(emailApp.slug);
    // Fresh allow-listed addresses: no sign-in cooldown can answer for the send.
    const allow = await callTool(mcp.client, 'configure_module', { app_id: formsApp.app_id, module: 'auth', config: { allow: { emails: [ANA, CAROL, DAVE] } } });
    expect(allow.json, JSON.stringify(allow.json)).toMatchObject({ applied: true });
    await resetRateLimitBucket(`mod:forms:${formsApp.app_id}:submit-ip`);
    await resetRateLimitBucket(`mod:forms:${emailApp.app_id}:submit-ip`);
    const redis = await redisClient();
    const since = logSince();
    try {
      // Pretend the server already sent all its hourly notifications but one.
      await redis.set(MAIL_NOTIFY_COUNTER, String(NOTIFY_BUDGET - 1), 'PX', 3_600_000);
      const t1 = await formToken(formsHost, 'budget');
      const t2 = await formToken(emailHost, 'budget');
      await sleep(2_100);

      // App 1's form: the last notification of the hour still goes out.
      const first = await post(formsHost, '/forms/budget', { _t: t1, name: 'Last one' });
      expect(first.status, first.body).toBe(200);
      expect(await submissionsOf(formsApp.app_id, 'budget')).toEqual([expect.objectContaining({ notified: true })]);
      expect(await pollMails(request, mcp.email, `New "budget" submission — ${FORMS_APP}`)).toHaveLength(1);

      // App 2's form: over the budget → notifications pause, the super-admin
      // ALERT line; the submission is stored, only its notification is skipped.
      const second = await post(emailHost, '/forms/budget', { _t: t2, name: 'One too many' });
      expect(second.status, second.body).toBe(200);
      expect(await submissionsOf(emailApp.app_id, 'budget')).toEqual([expect.objectContaining({ notified: false })]);
      expect(await redis.pttl(MAIL_NOTIFY_PAUSE)).toBeGreaterThan(0);
      const [alert] = (await pollLog(since, '"email_global_pause"')).filter((l) => l.app_id === emailApp.app_id);
      expect(alert, 'an ALERT line for the super admin').toMatchObject({
        level: 'error',
        alert: true,
        audience: 'super_admin',
        module: 'forms',
        kind: 'notification',
        class: 'notification',
        max: 1000,
        class_max: NOTIFY_BUDGET,
      });
      expect(String(alert.message)).toContain('ALERT');
      expect((await pollLog(since, '"forms_notify_failed"')).filter((l) => l.app_id === emailApp.app_id)).not.toHaveLength(0);

      // Every app's notifications are refused now: notifyAdmins on app 1 → 503 email_paused.
      const r = await post(formsHost, '/email/notify-admins', { subject: 'Cap', text: 'x' }, { Cookie: ownerFormsCookie });
      expect(r.status, r.body).toBe(503);
      expect(JSON.parse(r.body)).toMatchObject({ error: 'unavailable', details: { reason: 'email_paused', class: 'notification' } });
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      // Paused: even with the counter gone, notifications stay off until the pause ends.
      await redis.del(MAIL_NOTIFY_COUNTER);
      const again = await post(formsHost, '/email/notify-admins', { subject: 'Cap', text: 'x' }, { Cookie: ownerFormsCookie });
      expect(again.status).toBe(503);
      expect(JSON.parse(again.body)).toMatchObject({ details: { reason: 'email_paused' } });

      // Sign-in codes have their own budget: a fresh address still gets its code.
      const signIn = await post(formsHost, '/auth/send-code', { email: CAROL });
      expect(signIn.status, signIn.body).toBe(200);
      expect(await pollCode(request, CAROL, FORMS_APP)).toMatch(/^\d{6}$/);
      expect(await redis.pttl(MAIL_SIGNIN_PAUSE)).toBe(-2);
    } finally {
      await redis.del(MAIL_NOTIFY_COUNTER, MAIL_NOTIFY_PAUSE);
      redis.disconnect();
    }
    // Resumed. A header-injection attempt in the subject stays one line.
    const ok = await post(formsHost, '/email/notify-admins', { subject: 'Back\r\nBcc: e2e-bcc@example.com', text: 'x' }, { Cookie: ownerFormsCookie });
    expect(ok.status, ok.body).toBe(200);
    const [back] = await pollMails(request, mcp.email, `[${FORMS_APP}] Back`);
    expect(back.Subject).toBe(`[${FORMS_APP}] Back Bcc: e2e-bcc@example.com`);
    expect(back.To.map((x) => x.Address)).toEqual([mcp.email]);
    expect(await mailpitMessagesFor(request, 'e2e-bcc@example.com')).toHaveLength(0);
  });

  test("one app past its hourly share of notifications → its mail is refused (email_paused, EMAIL_APP_HOURLY_SHARE); other apps and sign-in continue", async ({ request }) => {
    skipUnlessLocal();
    const formsHost = previewHost(formsApp.slug);
    const emailHost = previewHost(emailApp.slug);
    await resetRateLimitBucket(`mod:forms:${emailApp.app_id}:submit-ip`);
    const appKey = `drobek:rl:mail:app:${formsApp.app_id}`;
    const redis = await redisClient();
    try {
      // Pretend app 1 already sent its whole hourly share.
      await redis.set(appKey, String(APP_SHARE), 'PX', 3_600_000);
      const r = await post(formsHost, '/email/notify-admins', { subject: 'Share', text: 'x' }, { Cookie: ownerFormsCookie });
      expect(r.status, r.body).toBe(503);
      expect(JSON.parse(r.body)).toMatchObject({
        error: 'unavailable',
        details: { reason: 'email_paused', class: 'notification', limit: 'EMAIL_APP_HOURLY_SHARE', value: APP_SHARE },
      });
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      // The server is not paused: app 2's form notification goes out.
      const t = await formToken(emailHost, 'share');
      await sleep(2_100);
      expect((await post(emailHost, '/forms/share', { _t: t, name: 'Other app' })).status).toBe(200);
      expect(await submissionsOf(emailApp.app_id, 'share')).toEqual([expect.objectContaining({ notified: true })]);
      expect(await pollMails(request, mcp.email, `New "share" submission — ${EMAIL_APP}`)).toHaveLength(1);
      expect(await redis.pttl(MAIL_NOTIFY_PAUSE)).toBe(-2);
      // Sign-in codes of app 1 are not part of its share.
      const signIn = await post(formsHost, '/auth/send-code', { email: DAVE });
      expect(signIn.status, signIn.body).toBe(200);
      expect(await pollCode(request, DAVE, FORMS_APP)).toMatch(/^\d{6}$/);
    } finally {
      await redis.del(appKey);
      redis.disconnect();
    }
    const ok = await post(formsHost, '/email/notify-admins', { subject: 'Share over', text: 'x' }, { Cookie: ownerFormsCookie });
    expect(ok.status, ok.body).toBe(200);
  });
});
