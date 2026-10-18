import { expect, test, type Request } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, prodHost, urlOf, versionHost } from './helpers/apps-host';
import { loginViaEmail, skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * Browser errors of the preview end to end on the local stack.
 *
 *  - a click that throws on the preview reaches `get_logs` kind `browser`
 *    within seconds, inside the untrusted envelope, with the stack mapped to
 *    the app's `src/main.tsx` line; `console.error(new Error())` arrives as
 *    type `console`;
 *  - `get_app` `preview_errors` counts it; the same error again raises the
 *    count, not the rows;
 *  - the next write returns `previous_version_browser_errors`;
 *  - a cross-origin report is answered 204 and not stored;
 *  - the production host never carries the reporter, sends nothing and
 *    answers 404 on the endpoint; `"browserErrors": false` drops it;
 *  - the app's Logs tab lists it.
 */

interface Created {
  app_id: string;
  slug: string;
}

interface BrowserEntry {
  at: string;
  first_seen: string;
  version: number;
  type: string;
  path: string;
  message: string;
  stack: string | null;
  source: string | null;
  count: number;
  ua: string;
}

const ERRORS_PATH = '/__drobek/preview/errors';
const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;

/** The throw is on line 5 of src/main.tsx. */
const MAIN = [
  "const root = document.getElementById('root')!;",
  "root.innerHTML = '<h1>Errors demo</h1><button id=\"boom\">Boom</button><button id=\"log\">Log</button>';",
  '',
  'function explode(): never {',
  `  throw new Error('kaboom ${STAMP}');`,
  '}',
  '',
  "document.getElementById('boom')!.addEventListener('click', () => explode());",
  `document.getElementById('log')!.addEventListener('click', () => console.error(new Error('logged ${STAMP}')));`,
  '',
].join('\n');

test.describe.configure({ mode: 'serial' });

test.describe('browser errors of the preview @local', () => {
  let mcp: McpClient;
  let app: Created;
  let version = 0;

  async function browserLogs(): Promise<{ entries: BrowserEntry[]; text: string }> {
    const r = await callTool(mcp.client, 'get_logs', { app_id: app.app_id, kind: 'browser' });
    expect(r.isError, JSON.stringify(r.json)).toBe(false);
    return { entries: r.json.entries as BrowserEntry[], text: r.text };
  }

  test.afterAll(async () => {
    await mcp?.client.close();
  });

  test('a click that throws on the preview reaches get_logs kind browser, mapped to src/main.tsx', async ({ page, request, browser }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'browser-errors', scope: FULL_SCOPE });
    app = (await callTool(mcp.client, 'create_app', { name: 'Errs demo', template: 'react-ts' })).json as unknown as Created;
    const w = await callTool(mcp.client, 'write_files', { app_id: app.app_id, files: [{ path: 'src/main.tsx', content: MAIN }], reasoning: 'A page that throws on click' });
    expect(w.isError, JSON.stringify(w.json)).toBe(false);
    expect((w.json.compile as { ok: boolean }).ok, JSON.stringify(w.json.compile)).toBe(true);
    version = w.json.version as number;

    const html = await hostRequest(previewHost(app.slug), '/');
    expect(html.body).toContain(`data-version="${version}" data-reload data-errors data-screenshots></script>`);

    const ctx = await browser.newContext();
    try {
      const tab = await ctx.newPage();
      await tab.goto(`${urlOf(previewHost(app.slug))}/?secret=${STAMP}`);
      await expect(tab.getByRole('heading', { name: 'Errors demo' })).toBeVisible();
      await tab.getByRole('button', { name: 'Boom' }).click();
      await tab.getByRole('button', { name: 'Log' }).click();

      let entries: BrowserEntry[] = [];
      let text = '';
      await expect
        .poll(
          async () => {
            ({ entries, text } = await browserLogs());
            return entries.some((e) => e.message.includes(`kaboom ${STAMP}`)) && entries.some((e) => e.message.includes(`logged ${STAMP}`));
          },
          { timeout: 10_000, intervals: [500] }
        )
        .toBe(true);

      const boom = entries.find((e) => e.message.includes(`kaboom ${STAMP}`))!;
      expect(boom.type).toBe('error');
      expect(boom.version).toBe(version);
      expect(boom.path).toBe('/');
      expect(boom.count).toBe(1);
      expect(['chrome', 'edge', 'firefox', 'safari', 'other']).toContain(boom.ua);
      expect(boom.stack ?? '').toMatch(/src\/main\.tsx:5:\d+/);
      expect(boom.source ?? '').toMatch(/^src\/main\.tsx:5:\d+$/);
      expect(entries.find((e) => e.message.includes(`logged ${STAMP}`))!.type).toBe('console');
      expect(text.startsWith('UNTRUSTED CONTENT:')).toBe(true);
      expect(text).toContain('<untrusted-app-logs');
      expect(text).not.toContain(`secret=${STAMP}`);

      const got = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
      const summary = got.json.preview_errors as { version: number; count: number; occurrences: number };
      expect(summary.version).toBe(version);
      expect(summary.count).toBe(2);

      // The same error again (within the page's one-minute window): counted, sent when the page goes away.
      await tab.getByRole('button', { name: 'Boom' }).click();
      await tab.reload();
      await expect(tab.getByRole('heading', { name: 'Errors demo' })).toBeVisible();
      await expect
        .poll(async () => (await browserLogs()).entries.find((e) => e.message.includes(`kaboom ${STAMP}`))?.count ?? 0, { timeout: 10_000, intervals: [500] })
        .toBe(2);
      expect((await browserLogs()).entries.filter((e) => e.message.includes(`kaboom ${STAMP}`))).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });

  test('a cross-origin report is not stored', async () => {
    skipUnlessLocal();
    const body = JSON.stringify({ version, ua: 'chrome', errors: [{ type: 'error', message: `forged ${STAMP}`, path: '/' }] });
    const res = await hostRequest(previewHost(app.slug), ERRORS_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
      body,
    });
    expect(res.status).toBe(204);
    expect((await browserLogs()).entries.some((e) => e.message.includes(`forged ${STAMP}`))).toBe(false);
  });

  test('the next write names the errors of the version it replaced', async () => {
    skipUnlessLocal();
    const w = await callTool(mcp.client, 'write_files', {
      app_id: app.app_id,
      files: [{ path: 'src/main.tsx', content: MAIN.replace('throw new Error', 'void new Error') }],
      reasoning: 'Fix the click',
    });
    expect(w.isError, JSON.stringify(w.json)).toBe(false);
    expect(w.json.previous_version_browser_errors).toBe(2);
    version = w.json.version as number;
    expect((await hostRequest(versionHost(app.slug, version), '/')).body).toContain(`data-version="${version}" data-errors></script>`);
  });

  test('production never carries the reporter; "browserErrors": false drops it on the preview', async ({ browser }) => {
    skipUnlessLocal();
    const pub = await callTool(mcp.client, 'publish', { app_id: app.app_id, version: version - 1 });
    expect(pub.isError, JSON.stringify(pub.json)).toBe(false);
    const prod = await hostRequest(prodHost(app.slug), '/');
    expect(prod.status).toBe(200);
    expect(prod.body).not.toContain('/__drobek/preview.js');
    expect((await hostRequest(prodHost(app.slug), ERRORS_PATH, { method: 'POST', body: '{}' })).status).toBe(404);

    const ctx = await browser.newContext();
    try {
      const tab = await ctx.newPage();
      const reports: Request[] = [];
      tab.on('request', (r) => {
        if (new URL(r.url()).pathname === ERRORS_PATH) reports.push(r);
      });
      await tab.goto(`${urlOf(prodHost(app.slug))}/`);
      await expect(tab.getByRole('heading', { name: 'Errors demo' })).toBeVisible();
      await tab.getByRole('button', { name: 'Boom' }).click();
      await tab.goto('about:blank');
      await tab.waitForTimeout(1_500);
      expect(reports).toHaveLength(0);
    } finally {
      await ctx.close();
    }

    const off = await callTool(mcp.client, 'write_files', {
      app_id: app.app_id,
      files: [{ path: 'drobek.json', content: JSON.stringify({ browserErrors: false }) }],
      reasoning: 'Browser errors off',
    });
    expect(off.isError, JSON.stringify(off.json)).toBe(false);
    expect((off.json.compile as { ok: boolean }).ok).toBe(true);
    const offHtml = await hostRequest(previewHost(app.slug), '/');
    expect(offHtml.body).toContain('data-reload data-screenshots></script>');
    expect(offHtml.body).not.toContain('data-errors');
  });

  test("the app's Logs tab lists the preview's browser errors", async ({ page, request }) => {
    skipUnlessLocal();
    await loginViaEmail(page, request, mcp.email);
    await page.goto(`${BASE_URL_WEB}/workspaces/${mcp.workspace}/apps/${app.slug}/logs`);
    const row = page.locator('[data-testid="browser-errors-row"]').filter({ hasText: `kaboom ${STAMP}` });
    await expect(row).toHaveCount(1);
    await expect(row.locator('[data-testid="browser-errors-count"]')).toHaveText('2');
    await expect(row.locator('[data-testid="browser-errors-source"]')).toContainText('src/main.tsx:5');
  });
});
