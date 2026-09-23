import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, urlOf } from './helpers/apps-host';
import { MAILPIT_URL, loginViaEmail, mailpitMessagesFor, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { callTool, mcpClient, type McpClient } from './helpers/mcp';
import { addMembership, userIdByEmail, withDb, workspaceIdBySlug } from './helpers/seed';

/**
 * M2-02 (NSO-291): the dashboard Modules tab end to end — an agent drives
 * configure_module over MCP, the owner (and a viewer) use the UI:
 *
 *  - the agent opens `create` of a data collection to `public` → the
 *    confirm_url page shows the pending change with its diff and a risk note,
 *    the app header shows "1 change awaits confirmation"; Confirm → the rule
 *    is in force (a visitor can add a record), audit module.pending (agent) +
 *    module.confirm (user);
 *  - the owner gets ONE e-mail about pending changes (Mailpit), with the
 *    module, the change and the confirm URL; a second proposal within the hour
 *    sends none (1/h per app);
 *  - a secret entered in the form → `hasSecret: true` in get_app, and the
 *    value appears in no API response (get_app, skill_info, the page's loader
 *    data) and no HTML;
 *  - the generated form refuses a config outside the module's schema with the
 *    error at the field (nothing stored), then saves a valid one;
 *  - a viewer sees the configuration, the pending change and the secret
 *    status, but no button or input; a direct POST is 403.
 */

interface Created {
  app_id: string;
  slug: string;
  workspace: string;
}

const SECRET = `e2e-module-secret-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const ROTATED = `${SECRET}-rotated`;
const APP_NAME = 'Module desk';
const PENDING_SUBJECT = 'awaits your confirmation';

interface MailDetail {
  Subject: string;
  Text: string;
  To: { Address: string }[];
}

async function configure(mcp: McpClient, appId: string, module: string, config: unknown) {
  const r = await callTool(mcp.client, 'configure_module', { app_id: appId, module, config });
  expect(r.isError, JSON.stringify(r.json)).toBe(false);
  return r.json;
}

async function auditRows(slug: string): Promise<{ action: string; actor_kind: string; meta: Record<string, unknown> | null }[]> {
  return withDb(async (c) => {
    const r = await c.query(`SELECT action, actor_kind, meta FROM audit_log WHERE target = $1 AND action LIKE 'module.%' ORDER BY created_at`, [slug]);
    return r.rows as { action: string; actor_kind: string; meta: Record<string, unknown> | null }[];
  });
}

async function pendingMails(request: APIRequestContext, email: string): Promise<MailDetail[]> {
  const metas = (await mailpitMessagesFor(request, email.toLowerCase())).filter((m) => (m.Subject ?? '').includes(PENDING_SUBJECT));
  return Promise.all(
    metas.map(async (m) => {
      const res = await request.get(`${MAILPIT_URL}/api/v1/message/${m.ID}`);
      expect(res.ok()).toBeTruthy();
      const d = (await res.json()) as MailDetail;
      return { ...d, Text: d.Text.replace(/\r\n/g, '\n') };
    })
  );
}

/** The page's HTML + its loader data (React Router single fetch: `<path>.data`) — both must be secret-free. */
async function pageSources(api: APIRequestContext, path: string): Promise<string> {
  const html = await api.get(path);
  expect(html.status()).toBe(200);
  const loaderData = await api.get(`${path}.data`);
  expect(loaderData.status()).toBe(200);
  return `${await html.text()}\n${await loaderData.text()}`;
}

function modulePath(app: Created, module: string): string {
  return `/workspaces/${app.workspace}/apps/${app.slug}/modules/${module}`;
}

test.describe.configure({ mode: 'serial' });

test.describe('dashboard Modules tab (M2-02) @local', () => {
  let mcp: McpClient;
  let owner: BrowserContext;
  let ownerPage: Page;
  let app: Created;

  test.afterAll(async () => {
    await mcp?.client.close();
    await owner?.close();
  });

  test('setup: an agent creates the app; the Modules tab lists the modules', async ({ page, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'dash-modules' });
    owner = await page.context().browser()!.newContext({ storageState: await page.context().storageState() });
    ownerPage = await owner.newPage();
    const created = await callTool(mcp.client, 'create_app', { name: APP_NAME, template: 'html' });
    expect(created.isError, JSON.stringify(created.json)).toBe(false);
    app = created.json as unknown as Created;

    await ownerPage.goto(`/workspaces/${app.workspace}/apps/${app.slug}`);
    await ownerPage.getByTestId('app-modules-link').click();
    await expect(ownerPage).toHaveURL(new RegExp(`/apps/${app.slug}/modules$`));
    for (const m of ['hello', 'auth', 'email', 'forms', 'data', 'proxy']) {
      await expect(ownerPage.locator(`[data-testid="module-row"][data-module="${m}"]`)).toBeVisible();
    }
    await expect(ownerPage.getByTestId('pending-banner')).toHaveCount(0);
    // hello declares an optional secret: nothing is "missing".
    await expect(ownerPage.locator('[data-module="hello"] [data-testid="module-secrets-missing"]')).toHaveCount(0);
  });

  test("the agent sets create: 'public' → pending with a diff in the UI → Confirm → the rule is active, audited", async () => {
    skipUnlessLocal();
    const first = await configure(mcp, app.app_id, 'data', { collections: { notes: {} } });
    expect(first).toMatchObject({ applied: true, pending_confirmation: [] });
    const held = await configure(mcp, app.app_id, 'data', { collections: { notes: { rules: { create: 'public' } } } });
    expect(held.applied).toBe(false);
    expect(held.pending_confirmation).toEqual([
      'data.collections.notes.rules.create: "user" → "public" (anyone, signed in or not, may add records)',
    ]);
    const confirmUrl = String(held.confirm_url);
    expect(confirmUrl).toBe(`${BASE_URL_WEB}${modulePath(app, 'data')}`);

    // The app header announces it.
    await ownerPage.goto(`/workspaces/${app.workspace}/apps/${app.slug}`);
    const banner = ownerPage.getByTestId('pending-banner');
    await expect(banner).toContainText('1 change awaits confirmation');
    await expect(banner).toContainText('data');
    await banner.getByTestId('pending-banner-link').click();
    await expect(ownerPage).toHaveURL(new RegExp(`${modulePath(app, 'data')}$`));

    // The confirm_url page: the change, a plain-language risk note, the diff.
    await ownerPage.goto(confirmUrl);
    const panel = ownerPage.getByTestId('pending-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('pending-change')).toContainText('data.collections.notes.rules.create');
    await expect(panel.getByTestId('pending-risk')).toContainText('anyone on the internet');
    const row = panel.locator('[data-testid="pending-diff-row"][data-path="collections.notes.rules.create"]');
    await expect(row.getByTestId('pending-diff-before')).toHaveText('"user"');
    await expect(row.getByTestId('pending-diff-after')).toHaveText('"public"');
    // Not in force yet: the rule table still says "user", a visitor is refused.
    await expect(ownerPage.getByTestId('rule-notes-create-rule')).toHaveText('user');
    const host = previewHost(app.slug);
    const post = () =>
      hostRequest(host, '/__drobek/v1/data/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: urlOf(host), 'X-Drobek-SDK': '1' },
        body: JSON.stringify({ text: 'from a visitor' }),
      });
    expect((await post()).status).toBe(401);

    await panel.getByTestId('pending-confirm').click();
    await expect(ownerPage.getByTestId('done-notice')).toHaveAttribute('data-done', 'confirmed');
    await expect(ownerPage.getByTestId('pending-panel')).toHaveCount(0);
    await expect(ownerPage.getByTestId('pending-banner')).toHaveCount(0);
    await expect(ownerPage.getByTestId('rule-notes-create-rule')).toHaveText('public');
    await expect(ownerPage.getByTestId('rule-notes-create-public')).toBeChecked();

    // The rule is in force on the app host and in get_app.
    const added = await post();
    expect(added.status, added.body).toBe(201);
    const got = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
    expect((got.json.modules as Record<string, Record<string, unknown>>).data).toMatchObject({
      pending: false,
      config: { collections: { notes: { rules: { create: 'public' } } } },
    });

    const rows = await auditRows(app.slug);
    expect(rows.find((r) => r.action === 'module.pending')?.actor_kind).toBe('agent');
    const confirm = rows.find((r) => r.action === 'module.confirm');
    expect(confirm?.actor_kind).toBe('user');
    expect(confirm?.meta).toMatchObject({ module: 'data' });
  });

  test('the owner got ONE e-mail about the pending change (Mailpit); a second proposal within the hour sends none', async ({ request }) => {
    skipUnlessLocal();
    await expect
      .poll(async () => (await pendingMails(request, mcp.email)).length, { timeout: 20_000 })
      .toBe(1);
    const [mail] = await pendingMails(request, mcp.email);
    expect(mail.Subject).toBe(`[${APP_NAME}] 1 change awaits your confirmation`);
    expect(mail.To.map((t) => t.Address)).toEqual([mcp.email.toLowerCase()]);
    expect(mail.Text).toContain('Module data:');
    expect(mail.Text).toContain('data.collections.notes.rules.create: "user" → "public"');
    expect(mail.Text).toContain(`Review: ${BASE_URL_WEB}${modulePath(app, 'data')}`);

    // Another pending change (a new Reply-To) within the hour: aggregated, no second mail.
    const held = await configure(mcp, app.app_id, 'email', { replyTo: 'e2e-replies@example.com' });
    expect(held.applied).toBe(false);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await pendingMails(request, mcp.email)).toHaveLength(1);
  });

  test('a secret entered in the dashboard: hasSecret true; the value is in no API response and no HTML', async () => {
    skipUnlessLocal();
    const path = modulePath(app, 'hello');
    await ownerPage.goto(path);
    const row = ownerPage.locator('[data-testid="secret-row"][data-name="HELLO_SIGNATURE"]');
    await expect(row.getByTestId('secret-status')).toHaveText('not set');
    await row.getByTestId('secret-input-HELLO_SIGNATURE').fill(SECRET);
    await row.getByTestId('secret-set-HELLO_SIGNATURE').click();
    await expect(ownerPage.getByTestId('done-notice')).toHaveAttribute('data-done', 'secret-set');
    await expect(row.getByTestId('secret-status')).toHaveText('set');
    await expect(row.getByTestId('secret-input-HELLO_SIGNATURE')).toHaveValue('');
    expect(await ownerPage.content()).not.toContain(SECRET);

    // Rotate.
    await row.getByTestId('secret-input-HELLO_SIGNATURE').fill(ROTATED);
    await row.getByTestId('secret-set-HELLO_SIGNATURE').click();
    await expect(ownerPage.getByTestId('done-notice')).toHaveAttribute('data-done', 'secret-rotated');
    expect(await ownerPage.content()).not.toContain(SECRET);

    // get_app: hasSecret only.
    const got = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
    expect((got.json.modules as Record<string, { secrets?: unknown }>).hello.secrets).toEqual([{ name: 'HELLO_SIGNATURE', hasSecret: true }]);
    expect(got.text).not.toContain(SECRET);
    expect(JSON.stringify(got.json)).not.toContain(SECRET);
    const skill = await callTool(mcp.client, 'skill_info', { name: 'hello' });
    expect(skill.text).not.toContain(SECRET);
    const cfg = await configure(mcp, app.app_id, 'hello', { excited: true });
    expect(JSON.stringify(cfg)).not.toContain(SECRET);

    // The page HTML and its loader data, the Modules tab, the app page.
    const sources = [
      await pageSources(owner.request, path),
      await pageSources(owner.request, `/workspaces/${app.workspace}/apps/${app.slug}/modules`),
      await pageSources(owner.request, `/workspaces/${app.workspace}/apps/${app.slug}`),
    ].join('\n');
    expect(sources).toContain('HELLO_SIGNATURE');
    expect(sources).not.toContain(SECRET);

    // The module uses it server-side (the ping is signed) without ever returning it.
    const ping = await hostRequest(previewHost(app.slug), '/__drobek/v1/hello');
    expect(ping.status).toBe(200);
    expect(JSON.parse(ping.body)).toMatchObject({ signed: true });
    expect(ping.body).not.toContain(SECRET);

    // Audit: the name, never the value.
    const rows = await auditRows(app.slug);
    expect(rows.filter((r) => r.action === 'module.secret_set').map((r) => r.meta)).toEqual([
      { module: 'hello', name: 'HELLO_SIGNATURE', rotated: false },
      { module: 'hello', name: 'HELLO_SIGNATURE', rotated: true },
    ]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  test('the generated form refuses a config outside the schema with the error at the field; a valid one saves', async () => {
    skipUnlessLocal();
    await ownerPage.goto(modulePath(app, 'email'));
    const form = ownerPage.getByTestId('config-form');
    await form.getByTestId('field-fromName').fill('Bad <name>');
    await form.getByTestId('config-save').click();
    await expect(ownerPage.getByTestId('field-error-fromName')).toContainText('one plain line');
    await expect(ownerPage.getByTestId('field-fromName')).toHaveAttribute('aria-invalid', 'true');
    let got = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
    expect((got.json.modules as Record<string, { config: Record<string, unknown> }>).email.config.fromName).toBeUndefined();

    await ownerPage.getByTestId('field-fromName').fill(APP_NAME);
    await ownerPage.getByTestId('config-save').click();
    await expect(ownerPage.getByTestId('done-notice')).toHaveAttribute('data-done', 'applied');
    await expect(ownerPage.getByTestId('field-error-fromName')).toHaveCount(0);
    got = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
    const email = (got.json.modules as Record<string, { config: Record<string, unknown>; pending: boolean }>).email;
    expect(email.config.fromName).toBe(APP_NAME);
    // The agent's Reply-To still waits (a safe change keeps the pending one).
    expect(email.pending).toBe(true);
    await expect(ownerPage.getByTestId('pending-panel')).toContainText('replyTo');

    // hello: an empty greeting violates min(1) — the error sits at the field.
    await ownerPage.goto(modulePath(app, 'hello'));
    await ownerPage.getByTestId('field-greeting').fill('');
    await ownerPage.getByTestId('config-save').click();
    await expect(ownerPage.getByTestId('field-error-greeting')).toBeVisible();
  });

  test('a viewer sees the configuration, the pending change and the secret status — no buttons; a POST is 403', async ({ browser, request }) => {
    skipUnlessLocal();
    const viewerEmail = uniqueEmail('dash-modules-viewer');
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await loginViaEmail(page, request, viewerEmail);
      await addMembership(await userIdByEmail(viewerEmail), await workspaceIdBySlug(app.workspace), 'viewer');

      await page.goto(modulePath(app, 'email'));
      await expect(page.getByTestId('readonly-note')).toBeVisible();
      await expect(page.getByTestId('pending-panel')).toContainText('replyTo');
      await expect(page.getByTestId('pending-confirm')).toHaveCount(0);
      await expect(page.getByTestId('pending-reject')).toHaveCount(0);
      await expect(page.getByTestId('config-form')).toHaveAttribute('data-readonly', 'true');
      await expect(page.getByTestId('field-fromName')).toHaveValue(APP_NAME);
      await expect(page.getByTestId('field-fromName')).toBeDisabled();
      await expect(page.getByTestId('config-save')).toHaveCount(0);
      await expect(page.locator('main button')).toHaveCount(0);

      await page.goto(modulePath(app, 'hello'));
      await expect(page.locator('[data-name="HELLO_SIGNATURE"] [data-testid="secret-status"]')).toHaveText('set');
      await expect(page.getByTestId('secret-input-HELLO_SIGNATURE')).toHaveCount(0);
      await expect(page.locator('main button')).toHaveCount(0);

      await page.goto(modulePath(app, 'data'));
      await expect(page.getByTestId('rule-notes-create-public')).toBeDisabled();
      await expect(page.getByTestId('collection-save-notes')).toHaveCount(0);
      await expect(page.locator('main button')).toHaveCount(0);

      // The server refuses the viewer whatever the UI shows.
      const posts: Record<string, string>[] = [
        { intent: 'confirm' },
        { intent: 'set-secret', secret: 'HELLO_SIGNATURE', value: 'x' },
        { intent: 'save-config', 'cfg.fromName': 'Hijack' },
      ];
      for (const form of posts) {
        const res = await page.request.post(modulePath(app, 'email'), { form, maxRedirects: 0 });
        expect(res.status(), JSON.stringify(form)).toBe(403);
      }
      const got = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
      expect((got.json.modules as Record<string, { config: Record<string, unknown>; pending: boolean }>).email).toMatchObject({
        pending: true,
        config: { fromName: APP_NAME },
      });
    } finally {
      await ctx.close();
    }
  });
});
