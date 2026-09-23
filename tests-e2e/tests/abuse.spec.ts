import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { hostRequest, prodHost, previewHost, versionHost } from './helpers/apps-host';
import {
  MAILPIT_URL,
  loginViaEmail,
  mailpitMessagesFor,
  resetRateLimitBucket,
  skipUnlessLocal,
  uniqueEmail,
} from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';
import { withDb } from './helpers/seed';

/**
 * M4-02 (NSO-293): abuse and moderation end to end on the local stack.
 *
 *  - the publish heuristic flags a "bank login" app (password field + "bank"
 *    in the title/h1) into the queue and does NOT flag a calculator — neither
 *    publish is blocked;
 *  - every app host answers /.well-known/drobek-report (the report form on
 *    the dashboard origin) and sends X-Drobek-App;
 *  - an anonymous report through the form stores a row, audits
 *    `abuse.report` and e-mails the super-admins; the honeypot stores nothing;
 *  - the queue is super-admin only (403); a takedown → 451 with the terms
 *    link on the prod, preview AND version hosts, `write_files` →
 *    `app_locked_by_admin`, get_app `locked_by_admin`, the owner is e-mailed,
 *    audit `admin.takedown`;
 *  - a restore lifts it (not republished: prod says "not published", preview
 *    serves again, write_files works), owner e-mailed, audit `admin.restore`;
 *  - the form allows 5 valid reports per IP per hour (the 6th → 429).
 *
 * The super-admin is `e2e-superadmin@drobek.test` — docker-compose.yml appends
 * it to SUPERADMIN_EMAIL in dev, docker-compose.e2e.yaml sets it.
 */

const SUPER_ADMIN = 'e2e-superadmin@drobek.test';
const DASHBOARD = new URL(BASE_URL_WEB).origin;
const TERMS = process.env.E2E_TERMS_URL ?? `${DASHBOARD}/terms`;
const REPORT_BUCKET = 'abuse-report-ip';
/** resetRateLimitBucket only works against a local Redis (see helpers/auth.ts). */
const REDIS_RESETTABLE = (() => {
  try {
    return ['localhost', '127.0.0.1', 'redis'].includes(new URL(process.env.REDIS_URL ?? '').hostname);
  } catch {
    return false;
  }
})();

const BANK_TSX = [
  "import { createRoot } from 'react-dom/client';",
  "import './styles.css';",
  '',
  'function App() {',
  '  return (',
  '    <form>',
  '      <h1>Bank login</h1>',
  '      <input name="client" placeholder="Client number" />',
  '      <input name="pin" type="password" />',
  '      <button>Sign in</button>',
  '    </form>',
  '  );',
  '}',
  '',
  "createRoot(document.getElementById('root')!).render(<App />);",
  '',
].join('\n');

const CALC_TSX = [
  "import { useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import './styles.css';",
  '',
  'function App() {',
  '  const [a, setA] = useState(0);',
  '  const [b, setB] = useState(0);',
  '  return (',
  '    <main>',
  '      <h1>Calculator</h1>',
  '      <input type="number" value={a} onChange={(e) => setA(Number(e.target.value))} />',
  '      <input type="number" value={b} onChange={(e) => setB(Number(e.target.value))} />',
  '      <p>= {a + b}</p>',
  '    </main>',
  '  );',
  '}',
  '',
  "createRoot(document.getElementById('root')!).render(<App />);",
  '',
].join('\n');

interface Created {
  app_id: string;
  slug: string;
}

interface MailDetail {
  Subject: string;
  Text: string;
}

async function reportsOf(appId: string): Promise<{ id: string; reason: string; status: string; host: string; details: string }[]> {
  return withDb(async (c) =>
    (
      await c.query(
        `SELECT id, reason, status, host, details FROM abuse_reports WHERE app_id = $1 ORDER BY created_at, id`,
        [appId]
      )
    ).rows
  );
}

async function auditOf(slug: string, action: string): Promise<{ actor_kind: string; meta: Record<string, unknown> | null }[]> {
  return withDb(async (c) =>
    (
      await c.query(
        `SELECT actor_kind, meta FROM audit_log WHERE subject_type = 'app' AND target = $1 AND action = $2 ORDER BY created_at`,
        [slug, action]
      )
    ).rows
  );
}

async function pollMail(request: APIRequestContext, email: string, subject: string): Promise<MailDetail> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const metas = (await mailpitMessagesFor(request, email.toLowerCase())).filter((m) => (m.Subject ?? '').includes(subject));
    if (metas.length > 0) {
      const res = await request.get(`${MAILPIT_URL}/api/v1/message/${metas[0].ID}`);
      expect(res.ok()).toBeTruthy();
      const mail = (await res.json()) as MailDetail;
      return { ...mail, Text: mail.Text.replace(/\r\n/g, '\n') };
    }
    if (Date.now() > deadline) throw new Error(`no mail "${subject}" for ${email} within 20 s`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function createAndPublish(mcp: McpClient, name: string, mainTsx: string): Promise<Created> {
  const created = await callTool(mcp.client, 'create_app', { name, workspace: mcp.workspace });
  expect(created.isError, created.text).toBe(false);
  const app = created.json as unknown as Created;
  const w = await callTool(mcp.client, 'write_files', {
    app_id: app.app_id,
    files: [{ path: 'src/main.tsx', content: mainTsx }],
    reasoning: `${name} UI`,
  });
  expect(w.isError, w.text).toBe(false);
  expect((w.json.compile as { ok: boolean }).ok, w.text).toBe(true);
  const p = await callTool(mcp.client, 'publish', { app_id: app.app_id });
  expect(p.isError, p.text).toBe(false);
  return app;
}

test.describe.configure({ mode: 'serial' });

test.describe('abuse: reports, takedown/restore, publish heuristic (M4-02) @local', () => {
  let owner: McpClient;
  let bank: Created;
  let calc: Created;
  let admin: BrowserContext | null = null;

  test.afterAll(async () => {
    await owner?.client.close().catch(() => {});
    await admin?.close().catch(() => {});
  });

  test('publish heuristic: flags the "bank login" app, not the calculator; neither is blocked', async ({ page, request }) => {
    skipUnlessLocal();
    owner = await mcpClient(page, request, { tag: 'abuse-owner', scope: FULL_SCOPE });
    bank = await createAndPublish(owner, 'Bank Login', BANK_TSX);
    calc = await createAndPublish(owner, 'Calculator', CALC_TSX);

    const flagged = await reportsOf(bank.app_id);
    expect(flagged, 'the bank login app lands in the queue').toHaveLength(1);
    expect(flagged[0]).toMatchObject({ reason: 'heuristic', status: 'open', host: prodHost(bank.slug) });
    expect(flagged[0].details).toMatch(/password field .*"bank"/);
    expect(await reportsOf(calc.app_id), 'the calculator is not flagged').toHaveLength(0);

    // Both are live (a flag never blocks).
    const live = await hostRequest(prodHost(bank.slug), '/');
    expect(live.status).toBe(200);
    expect((await hostRequest(prodHost(calc.slug), '/')).status).toBe(200);
    // X-Drobek-App on every app-host response.
    expect(live.headers['x-drobek-app']).toBe(bank.slug);
    expect((await hostRequest(previewHost(calc.slug), '/nope.js')).headers['x-drobek-app']).toBe(calc.slug);
  });

  test('/.well-known/drobek-report on every app host points at the form on the dashboard origin', async () => {
    skipUnlessLocal();
    for (const host of [prodHost(bank.slug), previewHost(bank.slug), versionHost(bank.slug, 2)]) {
      const r = await hostRequest(host, '/.well-known/drobek-report');
      expect(r.status, host).toBe(200);
      expect(r.headers['content-type']).toMatch(/^application\/json/);
      expect(r.headers['cache-control']).toBe('public, max-age=3600');
      expect(r.headers['x-drobek-app']).toBe(bank.slug);
      expect(JSON.parse(r.body)).toEqual({
        report_url: `${DASHBOARD}/report?host=${encodeURIComponent(host)}`,
        app: bank.slug,
        terms_url: TERMS,
      });
    }
  });

  test('an anonymous report stores a row, audits abuse.report and e-mails the super-admins; the honeypot stores nothing', async ({
    browser,
    request,
  }) => {
    skipUnlessLocal();
    await resetRateLimitBucket(REPORT_BUCKET);
    const host = prodHost(bank.slug);
    const pointer = JSON.parse((await hostRequest(host, '/.well-known/drobek-report')).body) as { report_url: string };

    const anon = await browser.newContext();
    try {
      const page = await anon.newPage();
      await page.goto(pointer.report_url);
      await expect(page.getByTestId('report-host')).toHaveValue(host);
      await page.getByTestId('report-reason').selectOption('phishing');
      await page.getByTestId('report-details').fill('Fake bank login page asking for my PIN.');
      await page.getByTestId('report-email').fill('Reporter.E2E@example.com');
      await page.getByTestId('report-submit').click();
      await expect(page.getByTestId('report-thanks')).toBeVisible();
    } finally {
      await anon.close();
    }

    const rows = await reportsOf(bank.app_id);
    const report = rows.find((r) => r.reason === 'phishing');
    expect(report, 'the report row').toBeTruthy();
    expect(report).toMatchObject({ status: 'open', host, details: 'Fake bank login page asking for my PIN.' });
    const reporter = await withDb(async (c) =>
      (await c.query(`SELECT reporter_email, ip_hash FROM abuse_reports WHERE id = $1`, [report!.id])).rows[0]
    );
    expect(reporter.reporter_email).toBe('reporter.e2e@example.com');
    const audit = await auditOf(bank.slug, 'abuse.report');
    expect(audit.at(-1)?.meta).toMatchObject({ reportId: report!.id, reason: 'phishing' });
    expect(JSON.stringify(audit.at(-1)?.meta)).not.toContain('reporter');

    const mail = await pollMail(request, SUPER_ADMIN, `Abuse report: ${host}`);
    expect(mail.Subject).toContain('(phishing)');
    expect(mail.Text).toContain(`App: ${bank.slug} in workspace ${owner.workspace}`);
    expect(mail.Text).toContain('Fake bank login page asking for my PIN.');
    expect(mail.Text).toContain(`${DASHBOARD}/admin/abuse`);

    // Honeypot: a bot that fills `website` gets a thank-you, nothing is stored.
    const before = (await reportsOf(calc.app_id)).length;
    const bot = await request.post('/report', {
      form: { host: prodHost(calc.slug), reason: 'spam', details: 'bot', email: '', website: 'http://spam.example' },
    });
    expect(bot.status()).toBe(200);
    expect((await reportsOf(calc.app_id)).length).toBe(before);
  });

  test('the queue is super-admin only; a takedown → 451 everywhere, app_locked_by_admin, owner e-mail, audit', async ({
    page,
    browser,
    request,
  }) => {
    skipUnlessLocal();
    // A signed-in user who is not a super-admin → 403 (no session → /login).
    await loginViaEmail(page, request, uniqueEmail('abuse-nonadmin'));
    const denied = await page.goto('/admin/abuse');
    expect(denied?.status()).toBe(403);

    admin = await browser.newContext();
    const ap = await admin.newPage();
    await loginViaEmail(ap, request, SUPER_ADMIN);
    const queue = await ap.goto('/admin/abuse');
    expect(queue?.status()).toBe(200);
    const row = ap.locator(`[data-testid="abuse-report"][data-host="${prodHost(bank.slug)}"][data-reason="phishing"]`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId('abuse-app')).toHaveText(bank.slug);
    await expect(row.getByTestId('abuse-details')).toContainText('Fake bank login page');
    await row.getByTestId('takedown-reason').selectOption('phishing');
    await row.getByTestId('takedown').click();
    await expect(ap.getByTestId('abuse-result')).toContainText(`${bank.slug} was taken down`);
    await expect(ap.locator(`[data-testid="locked-app"][data-app-slug="${bank.slug}"]`)).toBeVisible();

    // Every host of the app: 451 + the terms link (the page and every path).
    for (const [host, path] of [
      [prodHost(bank.slug), '/'],
      [previewHost(bank.slug), '/'],
      [previewHost(bank.slug), '/main.js'],
      [versionHost(bank.slug, 1), '/'],
      [versionHost(bank.slug, 2), '/deep/link'],
    ] as const) {
      const r = await hostRequest(host, path);
      expect(r.status, `${host}${path}`).toBe(451);
      expect(r.headers['x-drobek-app']).toBe(bank.slug);
      expect(r.headers['link']).toBe(`<${TERMS}>; rel="blocked-by"`);
      expect(r.body).toContain(`href="${TERMS}"`);
      expect(r.body).toContain('This app is unavailable');
    }
    const sdk = await hostRequest(previewHost(bank.slug), '/__drobek/sdk.js');
    expect(sdk.status).toBe(451);
    expect(JSON.parse(sdk.body)).toMatchObject({ error: 'app_locked_by_admin', details: { reason: 'phishing' } });

    // The agent is refused (not the lease's app_locked).
    const w = await callTool(owner.client, 'write_files', {
      app_id: bank.app_id,
      files: [{ path: 'src/extra.ts', content: 'export {}' }],
      reasoning: 'try to keep going',
    });
    expect(w.isError).toBe(true);
    expect(w.json).toMatchObject({ code: 'app_locked_by_admin', reason: 'phishing' });
    const pub = await callTool(owner.client, 'publish', { app_id: bank.app_id });
    expect(pub.json).toMatchObject({ code: 'app_locked_by_admin' });
    const got = await callTool(owner.client, 'get_app', { app_id: bank.app_id });
    expect(got.json).toMatchObject({ locked_by_admin: true, locked_reason: 'phishing' });
    expect(got.json.published_url).toBeUndefined();

    const mail = await pollMail(request, owner.email, `Your app ${bank.slug} was taken down`);
    expect(mail.Text).toContain('Phishing or credential theft');
    expect(mail.Text).not.toContain('Fake bank login page'); // never the reporter's text
    expect(mail.Text).toContain(TERMS);

    const audit = await auditOf(bank.slug, 'admin.takedown');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_kind: 'user', meta: { reason: 'phishing' } });
    // The app's open reports (the heuristic flag + the phishing report) are resolved.
    expect((await reportsOf(bank.app_id)).every((r) => r.status === 'resolved')).toBe(true);
  });

  test('a restore lifts the lock without republishing; owner e-mail; audit admin.restore', async ({ request }) => {
    skipUnlessLocal();
    expect(admin, 'the super-admin context from the takedown test').toBeTruthy();
    const ap = await admin!.newPage();
    await ap.goto('/admin/abuse');
    const locked = ap.locator(`[data-testid="locked-app"][data-app-slug="${bank.slug}"]`);
    await locked.getByTestId('restore').click();
    await expect(ap.getByTestId('abuse-result')).toContainText(`${bank.slug} was restored`);
    await expect(locked).toHaveCount(0);

    const prod = await hostRequest(prodHost(bank.slug), '/');
    expect(prod.status, 'not republished').toBe(404);
    expect(prod.body).toContain('Not published yet');
    expect((await hostRequest(previewHost(bank.slug), '/')).status).toBe(200);

    const got = await callTool(owner.client, 'get_app', { app_id: bank.app_id });
    expect(got.json.locked_by_admin).toBeUndefined();
    const w = await callTool(owner.client, 'write_files', {
      app_id: bank.app_id,
      files: [{ path: 'src/extra.ts', content: 'export {}' }],
      reasoning: 'writable again',
    });
    expect(w.isError, w.text).toBe(false);

    const mail = await pollMail(request, owner.email, `Your app ${bank.slug} was restored`);
    expect(mail.Text).toContain('It is NOT published');
    const audit = await auditOf(bank.slug, 'admin.restore');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_kind: 'user', meta: { reason: 'phishing' } });
  });

  test('the report form allows 5 valid reports per IP per hour; the 6th → 429', async ({ request }) => {
    skipUnlessLocal();
    await resetRateLimitBucket(REPORT_BUCKET);
    const form = { host: prodHost(calc.slug), reason: 'spam', details: 'rate limit probe', email: '', website: '' };
    // An invalid submission is refused (400) and does not count.
    const invalid = await request.post('/report', { form: { ...form, reason: 'not-a-reason' } });
    expect(invalid.status()).toBe(400);
    let accepted = 0;
    let limited = 0;
    for (let i = 0; i < 6 && limited === 0; i++) {
      const r = await request.post('/report', { form });
      if (r.status() === 429) limited = r.status();
      else {
        expect(r.status(), `report ${i + 1}`).toBe(200);
        accepted++;
      }
    }
    expect(limited, 'the limit trips within 6 reports').toBe(429);
    if (REDIS_RESETTABLE) {
      // The bucket was reset above: exactly 5 went through.
      expect(accepted).toBe(5);
    } else {
      // No Redis access (the image flow): the report of the earlier test counts too.
      expect(accepted).toBeLessThanOrEqual(5);
    }
    expect((await reportsOf(calc.app_id)).filter((r) => r.details === 'rate limit probe')).toHaveLength(accepted);
    await resetRateLimitBucket(REPORT_BUCKET);
  });
});
