import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { APPS_URL_SCHEME, BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, urlOf, type Raw } from './helpers/apps-host';
import { loginViaEmail, mailpitMessagesFor, pollLoginCode, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';
import {
  addMembership,
  seedApp as seedAppRow,
  seedDataCollections,
  seedRecords,
  userIdByEmail,
  withDb,
  workspaceIdBySlug,
} from './helpers/seed';

/**
 * M2-03 (NSO-301): the owner's module tabs of an app in the dashboard.
 *
 *  - Data: a CSV import of 5 001 rows is refused and one with an invalid row
 *    names that row — in both cases NOTHING is stored (one transaction); a
 *    valid import lands typed by the schema; a record is edited as JSON
 *    (validated by the module); the collection is deleted after typing its
 *    name; every action is audited;
 *  - Forms: submissions filtered by form + date range, a CSV of the filter,
 *    delete (editor+), audited;
 *  - Users: an end user's role change applies to their NEXT request (the
 *    hello module's /whoami), "sign everyone out" (the session epoch) signs
 *    them out, block / unblock;
 *  - Uploads: list, an inline raster preview served by the dashboard with
 *    nosniff + a sandbox CSP (an SVG only as an attachment), delete;
 *  - Logs: an error raised on the preview host is on the Logs tab within 5 s
 *    of a refresh (the same readers as get_logs);
 *  - a workspace VIEWER sees every tab read-only and every mutation is 403.
 *
 * Requires the local compose stack (DROBEK_MODULES with hello, auth, forms,
 * data, files).
 */

interface Created {
  app_id: string;
  slug: string;
  workspace: string;
}

const SECURE = APPS_URL_SCHEME === 'https';
const COOKIE = SECURE ? '__Host-drobek_eu' : 'drobek_eu';
const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const ANA = `e2e-owner-tabs-ana-${STAMP}@example.com`;
const BOUNDARY = '----drobekE2eOwnerTabs';

/** A real 1×1 PNG (decodes in a browser); random trailing bytes keep it unique per run. */
const TINY_PNG = Buffer.concat([
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
  randomBytes(8),
]);
const SVG = Buffer.from(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><!-- ${STAMP} --><script>alert(1)</script></svg>`);

const SCHEMA = {
  type: 'object',
  required: ['title', 'done'],
  properties: {
    title: { type: 'string' },
    done: { type: 'boolean' },
    priority: { type: 'number' },
  },
};

/** A page that renders, then throws once. */
const FAILING_MAIN = [
  "import './styles.css';",
  '',
  "const root = document.getElementById('root')!;",
  "root.innerHTML = '<h1>Owner logs ready</h1>';",
  '',
  'function checkout(): void {',
  `  throw new TypeError('owner tab checkout failed ${STAMP}');`,
  '}',
  '',
  'setTimeout(checkout, 50);',
  '',
].join('\n');

function sdkHeaders(host: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Origin: urlOf(host), 'X-Drobek-SDK': '1', ...extra };
}

function json<T = Record<string, unknown>>(r: Raw): T {
  return JSON.parse(r.body) as T;
}

/** send-code → the Mailpit code → verify on `host`; the Cookie header value. */
async function signIn(request: APIRequestContext, host: string, address: string): Promise<string> {
  const headers = { ...sdkHeaders(host), 'Content-Type': 'application/json' };
  // The same address signs in several times in one test: ignore the codes it
  // already received, and outlast the per-e-mail send cooldown (send-code
  // answers 200 without a mail while it runs; OTP_EMAIL_COOLDOWN_MS = 5 s in dev).
  const seen = new Set((await mailpitMessagesFor(request, address)).map((m) => m.ID));
  let code: string | null = null;
  for (let attempt = 0; attempt < 4 && !code; attempt++) {
    const sent = await hostRequest(host, '/__drobek/v1/auth/send-code', { method: 'POST', headers, body: JSON.stringify({ email: address }) });
    expect(sent.status, sent.body).toBe(200);
    code = await pollLoginCode(request, address, 6_000, seen).catch(() => null);
  }
  expect(code, `no login code for ${address} after 4 send-code attempts`).toBeTruthy();
  const verified = await hostRequest(host, '/__drobek/v1/auth/verify', { method: 'POST', headers, body: JSON.stringify({ email: address, code: code! }) });
  expect(verified.status, verified.body).toBe(200);
  const sc = verified.headers['set-cookie'];
  const m = new RegExp(`(${COOKIE}=[0-9a-f]{64})`).exec((Array.isArray(sc) ? sc : sc ? [sc] : []).join('\n'));
  expect(m, String(sc)).toBeTruthy();
  return m![1];
}

/** The visitor as ANOTHER module sees them (hello's /whoami reads ctx.principal). */
async function whoami(host: string, cookie: string): Promise<{ signed_in: boolean; email?: string; role?: string }> {
  const r = await hostRequest(host, '/__drobek/v1/hello/whoami', { headers: { Cookie: cookie } });
  expect(r.status, r.body).toBe(200);
  return json(r);
}

function upload(host: string, cookie: string, content: Buffer, filename: string, type: string): Promise<Raw> {
  return hostRequest(host, '/__drobek/v1/files', {
    method: 'POST',
    headers: { ...sdkHeaders(host, { Cookie: cookie }), 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
    body: Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]),
  });
}

async function countRecords(appId: string, collection: string): Promise<number> {
  return withDb(async (c) => {
    const r = await c.query(`SELECT count(*)::int AS n FROM mod_data_documents WHERE app_id = $1 AND collection = $2`, [appId, collection]);
    return (r.rows[0] as { n: number }).n;
  });
}

async function auditActions(slug: string): Promise<string[]> {
  return withDb(async (c) => {
    const r = await c.query(`SELECT action FROM audit_log WHERE subject_type = 'app' AND target = $1 ORDER BY created_at`, [slug]);
    return (r.rows as { action: string }[]).map((x) => x.action);
  });
}

async function seedSubmission(appId: string, form: string, data: Record<string, unknown>, createdAt: string): Promise<string> {
  const id = `fs_${randomBytes(12).toString('hex')}`;
  await withDb((c) =>
    c.query(`INSERT INTO mod_forms_submissions (id, app_id, form, data, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)`, [
      id,
      appId,
      form,
      JSON.stringify(data),
      createdAt,
    ])
  );
  return id;
}

/** Upload a CSV through the Data tab's import form. */
async function importCsv(page: Page, csv: string): Promise<void> {
  await page.locator('[data-testid="import-file"]').setInputFiles({ name: 'rows.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.locator('[data-testid="import-submit"]').click();
}

test.describe.configure({ mode: 'serial' });

test.describe("dashboard: the owner's app tabs — data edits + import, forms, users, uploads, logs (M2-03) @local", () => {
  let mcp: McpClient;
  let owner: BrowserContext;
  let ownerPage: Page;
  let ws: string;
  let workspaceId: string;
  /** The SQL-seeded app of the Data + Forms tabs. */
  let dataApp: { id: string; slug: string };
  /** The MCP-created app of the Users + Uploads tabs (it has a host). */
  let hostApp: Created & { host: string };
  let anaCookie: string;
  let pngId: string;

  test.afterAll(async () => {
    await mcp?.client.close();
    await owner?.close();
  });

  test('data: 5 001 rows refused, an invalid row named by its line — nothing stored; valid import, JSON edit, collection delete; audited', async ({
    page,
    request,
  }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'owner-tabs', scope: FULL_SCOPE });
    owner = await page.context().browser()!.newContext({ storageState: await page.context().storageState() });
    ownerPage = await owner.newPage();
    ws = mcp.workspace;
    workspaceId = await workspaceIdBySlug(ws);
    dataApp = await seedAppRow({ workspaceId });
    await seedDataCollections(dataApp.id, { todos: { schema: SCHEMA, rules: { read: 'admin', create: 'admin', update: 'admin', delete: 'admin' } } });
    const [alphaId] = await seedRecords(dataApp.id, 'todos', [
      { title: 'alpha', done: false, priority: 3 },
      { title: 'bravo', done: true, priority: 1 },
    ]);
    const p = ownerPage;
    const coll = `/workspaces/${ws}/apps/${dataApp.slug}/data/todos`;

    // The app page links every tab (one nav line each).
    await p.goto(`/workspaces/${ws}/apps/${dataApp.slug}`);
    for (const tab of ['data', 'forms', 'end-users', 'uploads', 'logs']) {
      await expect(p.locator(`[data-testid="app-tab"][data-tab="${tab}"]`)).toBeVisible();
    }

    await p.goto(coll);
    await expect(p.locator('[data-testid="owner-tools"]')).toBeVisible();
    await expect(p.locator('[data-testid="app-subnav"]')).toBeVisible();

    // ── 5 001 rows → refused before any write ─────────────────────────────────
    const big = ['title,done', ...Array.from({ length: 5001 }, (_, i) => `row ${i},true`)].join('\n');
    await importCsv(p, big);
    await expect(p.locator('[data-testid="data-error"][data-intent="import"]')).toContainText('more than 5000 rows');
    expect(await countRecords(dataApp.id, 'todos')).toBe(2);

    // ── an invalid row (line 4: done is not a boolean) → the line, nothing stored ─
    await importCsv(p, 'title,done,priority\nc1,true,1\nc2,false,2\nc3,maybe,3\nc4,true,4\n');
    const invalid = p.locator('[data-testid="data-error"][data-intent="import"]');
    await expect(invalid).toContainText('Line 4');
    await expect(invalid).toContainText('Nothing was imported');
    expect(await countRecords(dataApp.id, 'todos')).toBe(2);

    // ── a valid import → every row stored, typed by the schema ────────────────
    await importCsv(p, 'title,done,priority\ncharlie,true,5\ndelta,false,\n"echo, the ""quoted""",true,2.5\n');
    await expect(p.locator('[data-testid="import-done"]')).toContainText('Imported 3 records');
    expect(await countRecords(dataApp.id, 'todos')).toBe(5);
    const typed = await withDb(async (c) =>
      (await c.query(`SELECT doc FROM mod_data_documents WHERE app_id = $1 AND doc->>'title' = 'echo, the "quoted"'`, [dataApp.id])).rows
    );
    expect(typed).toEqual([{ doc: { title: 'echo, the "quoted"', done: true, priority: 2.5 } }]);

    // ── edit a record as JSON: a schema violation is refused, a valid edit saved ─
    await p.goto(`${coll}?edit=${alphaId}`);
    await expect(p.locator('[data-testid="edit-form"]')).toBeVisible();
    await p.locator('[data-testid="edit-json"]').fill('{"title": "alpha", "done": "nope"}');
    await p.locator('[data-testid="edit-save"]').click();
    await expect(p.locator('[data-testid="data-error"][data-intent="update"]')).toBeVisible();
    await p.locator('[data-testid="edit-json"]').fill('{"title": "alpha edited", "done": true, "priority": 9}');
    await p.locator('[data-testid="edit-save"]').click();
    await expect(p.locator('[data-testid="record-json"]')).toContainText('"title": "alpha edited"');
    const edited = await withDb(async (c) => (await c.query(`SELECT doc FROM mod_data_documents WHERE id = $1`, [alphaId])).rows[0] as { doc: unknown });
    expect(edited.doc).toEqual({ title: 'alpha edited', done: true, priority: 9 });

    // ── delete the collection: the typed name must match ──────────────────────
    await p.goto(coll);
    await p.locator('[data-testid="drop-link"]').click();
    await p.locator('[data-testid="drop-confirm-name"]').fill('todo');
    await p.locator('[data-testid="drop-confirm"]').click();
    await expect(p.locator('[data-testid="data-error"][data-intent="drop-collection"]')).toBeVisible();
    expect(await countRecords(dataApp.id, 'todos')).toBe(5);
    await p.locator('[data-testid="drop-confirm-name"]').fill('todos');
    await p.locator('[data-testid="drop-confirm"]').click();
    await p.waitForURL(/\/data\?dropped=todos$/);
    await expect(p.locator('[data-testid="collection-dropped"]')).toContainText('todos');
    expect(await countRecords(dataApp.id, 'todos')).toBe(0);
    const config = await withDb(async (c) =>
      (await c.query(`SELECT config FROM module_configs WHERE app_id = $1 AND module = 'data'`, [dataApp.id])).rows[0] as { config: { collections?: Record<string, unknown> } }
    );
    expect(config.config.collections ?? {}).not.toHaveProperty('todos');

    expect(await auditActions(dataApp.slug)).toEqual(expect.arrayContaining(['data.import', 'data.record_update', 'data.collection_delete']));
  });

  test('forms: filter by form + date range, CSV of the filter, delete (audited)', async () => {
    skipUnlessLocal();
    const p = ownerPage;
    await seedSubmission(dataApp.id, 'contact', { email: 'old@example.com', message: 'hello' }, '2026-09-01T10:00:00Z');
    await seedSubmission(dataApp.id, 'contact', { email: 'new@example.com', message: '=cmd|calc' }, '2026-09-10T10:00:00Z');
    await seedSubmission(dataApp.id, 'newsletter', { email: 'sub@example.com' }, '2026-09-10T11:00:00Z');
    const base = `/workspaces/${ws}/apps/${dataApp.slug}/forms`;

    await p.goto(base);
    await expect(p.locator('[data-testid="submission-row"]')).toHaveCount(3);
    await p.locator('[data-testid="forms-filter-form"]').selectOption('contact');
    await p.locator('[data-testid="forms-filter-from"]').fill('2026-09-05');
    await p.locator('[data-testid="forms-filter-to"]').fill('2026-09-10');
    await p.locator('[data-testid="forms-filter-apply"]').click();
    await p.waitForURL(/form=contact/);
    await expect(p.locator('[data-testid="submission-row"]')).toHaveCount(1);
    await expect(p.locator('[data-testid="forms-total"]')).toContainText('1 submission');
    await expect(p.locator('[data-testid="submission-fields"]')).toContainText('new@example.com');

    // The CSV carries the same filter; formula cells are neutralized.
    const href = await p.locator('[data-testid="forms-csv"]').getAttribute('href');
    expect(href).toContain('form=contact');
    const csv = await p.request.get(href!);
    expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toContain('text/csv');
    expect(csv.headers()['content-disposition']).toContain('attachment');
    const lines = (await csv.text()).trim().split(/\r?\n/);
    expect(lines[0]).toBe('id,form,created_at,email,message');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('new@example.com');
    expect(lines[1]).toContain("'=cmd|calc");

    // Delete behind a confirm step.
    await p.locator('[data-testid="submission-delete"]').click();
    await p.locator('[data-testid="submission-delete-confirm"]').click();
    await expect(p.locator('[data-testid="submissions-empty"]')).toBeVisible();
    await p.goto(base);
    await expect(p.locator('[data-testid="submission-row"]')).toHaveCount(2);
    expect(await auditActions(dataApp.slug)).toEqual(expect.arrayContaining(['forms.submission_delete', 'forms.export']));
  });

  test('users: a role change applies to the next request; sign everyone out; block / unblock', async ({ request }) => {
    skipUnlessLocal();
    const p = ownerPage;
    const created = (await callTool(mcp.client, 'create_app', { name: `Owner tabs ${STAMP}`, template: 'html' })).json as unknown as Created;
    hostApp = { ...created, host: previewHost(created.slug) };
    const cfg = await callTool(mcp.client, 'configure_module', { app_id: hostApp.app_id, module: 'auth', config: { allow: { emails: [ANA] } } });
    expect(cfg.isError, JSON.stringify(cfg.json)).toBe(false);
    anaCookie = await signIn(request, hostApp.host, ANA);
    expect(await whoami(hostApp.host, anaCookie)).toMatchObject({ signed_in: true, email: ANA, role: 'user' });

    const base = `/workspaces/${ws}/apps/${hostApp.slug}/end-users`;
    await p.goto(base);
    const row = p.locator(`[data-testid="user-row"][data-email="${ANA}"]`);
    await expect(row.locator('[data-testid="user-role"]')).toContainText('user');
    await expect(row.locator('[data-testid="user-status"]')).toContainText('active');

    // user → admin: the very next module request sees the new role.
    await row.locator('[data-testid="role-toggle"]').click();
    await expect(row.locator('[data-testid="user-role"]')).toContainText('admin');
    expect(await whoami(hostApp.host, anaCookie)).toMatchObject({ signed_in: true, role: 'admin' });
    // …and back.
    await row.locator('[data-testid="role-toggle"]').click();
    await expect(row.locator('[data-testid="user-role"]')).toContainText('user');
    expect(await whoami(hostApp.host, anaCookie)).toMatchObject({ signed_in: true, role: 'user' });

    // Sign everyone out (the session epoch) → the cookie no longer signs in.
    await p.locator('[data-testid="revoke-link"]').click();
    await p.locator('[data-testid="revoke-confirm"]').click();
    await expect(p.locator('[data-testid="users-revoked"]')).toBeVisible();
    expect(await whoami(hostApp.host, anaCookie)).toMatchObject({ signed_in: false });

    // Block → anonymous on the next request; unblock → she can sign in again.
    anaCookie = await signIn(request, hostApp.host, ANA);
    await p.goto(base);
    await row.locator('[data-testid="block-toggle"]').click();
    await expect(row.locator('[data-testid="user-status"]')).toContainText('blocked');
    expect(await whoami(hostApp.host, anaCookie)).toMatchObject({ signed_in: false });
    await row.locator('[data-testid="block-toggle"]').click();
    await expect(row.locator('[data-testid="user-status"]')).toContainText('active');
    anaCookie = await signIn(request, hostApp.host, ANA);
    expect(await whoami(hostApp.host, anaCookie)).toMatchObject({ signed_in: true, role: 'user' });

    expect(await auditActions(hostApp.slug)).toEqual(
      expect.arrayContaining(['end_users.role', 'end_users.sessions_revoke', 'end_users.disable', 'end_users.enable'])
    );
  });

  test('uploads: list, inline raster preview with nosniff, SVG only as an attachment, delete', async () => {
    skipUnlessLocal();
    const p = ownerPage;
    const madePng = await upload(hostApp.host, anaCookie, TINY_PNG, 'dot.png', 'image/png');
    expect(madePng.status, madePng.body).toBe(201);
    pngId = json<{ id: string }>(madePng).id;
    const madeSvg = await upload(hostApp.host, anaCookie, SVG, 'logo.svg', 'image/svg+xml');
    expect(madeSvg.status, madeSvg.body).toBe(201);
    const svgId = json<{ id: string }>(madeSvg).id;

    const base = `/workspaces/${ws}/apps/${hostApp.slug}/uploads`;
    await p.goto(base);
    await expect(p.locator('[data-testid="upload-row"]')).toHaveCount(2);
    await expect(p.locator('[data-testid="uploads-usage"]')).toContainText('used');
    const pngRow = p.locator(`[data-testid="upload-row"][data-file-id="${pngId}"]`);
    const img = pngRow.locator('[data-testid="upload-preview"]');
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1);
    await expect(p.locator(`[data-testid="upload-row"][data-file-id="${svgId}"] [data-testid="upload-preview"]`)).toHaveCount(0);

    const inline = await p.request.get(`${base}/${pngId}`);
    expect(inline.status()).toBe(200);
    expect(inline.headers()['content-type']).toBe('image/png');
    expect(inline.headers()['x-content-type-options']).toBe('nosniff');
    expect(inline.headers()['content-disposition']).toMatch(/^inline; /);
    expect(inline.headers()['content-security-policy']).toContain('sandbox');
    expect(inline.headers()['cache-control']).toContain('no-store');
    expect(Buffer.compare(await inline.body(), TINY_PNG)).toBe(0);
    const download = await p.request.get(`${base}/${pngId}?download=1`);
    expect(download.headers()['content-disposition']).toMatch(/^attachment; filename="dot\.png"/);
    const svg = await p.request.get(`${base}/${svgId}`);
    expect(svg.headers()['content-type']).toBe('image/svg+xml');
    expect(svg.headers()['content-disposition']).toMatch(/^attachment; /);

    await pngRow.locator('[data-testid="upload-delete"]').click();
    await pngRow.locator('[data-testid="upload-delete-confirm"]').click();
    await expect(p.locator('[data-testid="upload-row"]')).toHaveCount(1);
    expect((await p.request.get(`${base}/${pngId}`)).status()).toBe(404);
    const gone = await hostRequest(hostApp.host, `/__drobek/v1/files/${pngId}`, { headers: { Cookie: anaCookie } });
    expect(gone.status).toBe(404);
    expect(await auditActions(hostApp.slug)).toEqual(expect.arrayContaining(['files.delete']));
  });

  test('logs: an error raised on the preview host is on the Logs tab within 5 s of a refresh', async ({ browser }) => {
    skipUnlessLocal();
    const p = ownerPage;
    const created = (await callTool(mcp.client, 'create_app', { name: 'Owner logs', template: 'react-ts' })).json as unknown as Created;
    const w = await callTool(mcp.client, 'write_files', {
      app_id: created.app_id,
      files: [{ path: 'src/main.tsx', content: FAILING_MAIN }],
      reasoning: 'A page that fails at runtime',
    });
    expect(w.isError, JSON.stringify(w.json)).toBe(false);
    expect((w.json.compile as { ok: boolean }).ok, JSON.stringify(w.json.compile)).toBe(true);

    const base = `/workspaces/${ws}/apps/${created.slug}/logs`;
    await p.goto(base);
    await expect(p.locator('[data-testid="compile-row"]').first()).toContainText('ok');
    await expect(p.locator('[data-testid="runtime-empty"]')).toBeVisible();

    const ctx = await browser.newContext();
    try {
      const tab = await ctx.newPage();
      await tab.goto(urlOf(previewHost(created.slug)));
      await expect(tab.getByRole('heading', { name: 'Owner logs ready' })).toBeVisible();
      // Refresh until the error is listed — within 5 s of the page having thrown.
      await expect(async () => {
        await p.locator('[data-testid="logs-refresh"]').click();
        await expect(p.locator('[data-testid="runtime-message"]').filter({ hasText: `owner tab checkout failed ${STAMP}` })).toHaveCount(1, {
          timeout: 800,
        });
      }).toPass({ timeout: 5_000, intervals: [250, 500, 500, 1000] });
    } finally {
      await ctx.close();
    }
    await p.locator('[data-testid="logs-since"]').selectOption('1h');
    await p.locator('[data-testid="logs-refresh"]').click();
    await p.waitForURL(/since=1h/);
    await expect(p.locator('[data-testid="runtime-row"]')).toHaveCount(1);
  });

  test('a workspace viewer sees every tab read-only; every mutation is 403', async ({ page, request }) => {
    skipUnlessLocal();
    const viewerEmail = uniqueEmail('owner-tabs-viewer');
    await loginViaEmail(page, request, viewerEmail);
    await addMembership(await userIdByEmail(viewerEmail), workspaceId, 'viewer');
    await seedDataCollections(dataApp.id, { notes: { schema: SCHEMA } });
    const [noteId] = await seedRecords(dataApp.id, 'notes', [{ title: 'n1', done: false }]);
    const [subId] = await withDb(async (c) =>
      (await c.query(`SELECT id FROM mod_forms_submissions WHERE app_id = $1 LIMIT 1`, [dataApp.id])).rows.map((r: { id: string }) => r.id)
    );
    const anaId = await withDb(async (c) =>
      ((await c.query(`SELECT id FROM mod_auth_users WHERE app_id = $1 AND email = $2`, [hostApp.app_id, ANA])).rows[0] as { id: string } | undefined)?.id
    );

    const dataBase = `/workspaces/${ws}/apps/${dataApp.slug}`;
    const hostBase = `/workspaces/${ws}/apps/${hostApp.slug}`;
    await page.goto(`${dataBase}/data/notes`);
    await expect(page.locator('[data-testid="data-row"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="owner-tools"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="record-edit"]')).toHaveCount(0);
    await page.goto(`${dataBase}/forms`);
    await expect(page.locator('[data-testid="submission-row"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="submission-delete"]')).toHaveCount(0);
    await page.goto(`${hostBase}/end-users`);
    await expect(page.locator('[data-testid="user-row"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="role-toggle"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="block-toggle"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="revoke-link"]')).toHaveCount(0);
    await page.goto(`${hostBase}/uploads`);
    await expect(page.locator('[data-testid="upload-row"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="upload-delete"]')).toHaveCount(0);
    await page.goto(`${hostBase}/logs`);
    await expect(page.locator('[data-testid="logs-refresh"]')).toBeVisible();

    const headers = { Origin: BASE_URL_WEB };
    const posts: [string, Record<string, string>][] = [
      [`${dataBase}/data/notes`, { intent: 'update', id: noteId, json: '{"title":"x","done":true}' }],
      [`${dataBase}/data/notes`, { intent: 'drop-collection', confirm_name: 'notes' }],
      [`${dataBase}/forms`, { intent: 'delete', id: subId }],
      [`${hostBase}/end-users`, { intent: 'role', id: anaId ?? 'eu_000000000000000000000000', role: 'admin' }],
      [`${hostBase}/end-users`, { intent: 'revoke-all' }],
      [`${hostBase}/uploads`, { intent: 'delete', id: 'aaaaaaaaaaaa' }],
    ];
    for (const [path, form] of posts) {
      const res = await page.request.post(path, { form, headers, maxRedirects: 0 });
      expect(res.status(), `${form.intent} on ${path} must be 403 for a viewer`).toBe(403);
    }
    expect(await countRecords(dataApp.id, 'notes')).toBe(1);
  });
});
