import { expect, test, type Page, type Request } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, prodHost, urlOf, versionHost } from './helpers/apps-host';
import { loginViaEmail, skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * Live reload of the preview end to end on the local stack.
 *
 *  - an open preview tab redraws itself with the new content a few seconds
 *    after a write_files over MCP that compiled, at the same scroll position;
 *  - a write that does not compile shows the notice and does not reload;
 *  - `"reload": false` in drobek.json drops the reload (the script stays for
 *    the error reports, without `data-reload`);
 *  - a version host carries the script without the reload, production never
 *    (both answer 404 for the event stream);
 *  - the preview framed as the dashboard's app-list thumbnail never connects.
 */

interface Created {
  app_id: string;
  slug: string;
}

const EVENTS_PATH = '/__drobek/preview/events';
const page = (title: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1 id="title">${title}</h1><div style="height:3000px"></div><p id="end">end</p></body></html>`;

/** Resolves once the page's event stream answered (its headers arrived). */
function streamOpened(p: Page): Promise<unknown> {
  return p.waitForResponse((r) => new URL(r.url()).pathname === EVENTS_PATH && r.status() === 200, { timeout: 15_000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('live reload of the preview @local', () => {
  let mcp: McpClient;
  let app: Created;
  let version = 0;

  test.afterAll(async () => {
    await mcp?.client.close();
  });

  test('an open preview redraws itself after a write that compiled, at the same scroll position', async ({ page: p, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(p, request, { tag: 'reload', scope: FULL_SCOPE });
    app = (await callTool(mcp.client, 'create_app', { name: 'Reload demo', template: 'html' })).json as unknown as Created;
    const w = await callTool(mcp.client, 'write_files', { app_id: app.app_id, files: [{ path: 'index.html', content: page('One') }], reasoning: 'First page' });
    expect(w.isError, JSON.stringify(w.json)).toBe(false);
    version = w.json.version as number;

    const html = await hostRequest(previewHost(app.slug), '/');
    expect(html.body).toContain(`<script src="/__drobek/preview.js" defer data-app="${app.slug}" data-version="${version}" data-reload data-errors data-screenshots></script>`);
    const script = await hostRequest(previewHost(app.slug), '/__drobek/preview.js');
    expect(script.status).toBe(200);
    expect(String(script.headers['content-type'])).toContain('javascript');
    expect(script.body).not.toMatch(/document\.cookie/);

    const opened = streamOpened(p);
    await p.goto(`${urlOf(previewHost(app.slug))}/`);
    await expect(p.getByRole('heading', { name: 'One' })).toBeVisible();
    await opened;
    await p.evaluate(() => window.scrollTo(0, 1200));

    const w2 = await callTool(mcp.client, 'write_files', { app_id: app.app_id, files: [{ path: 'index.html', content: page('Two') }], reasoning: 'Second page' });
    expect(w2.isError, JSON.stringify(w2.json)).toBe(false);
    version = w2.json.version as number;
    await expect(p.getByRole('heading', { name: 'Two' })).toBeAttached({ timeout: 10_000 });
    await expect.poll(() => p.evaluate(() => window.scrollY), { timeout: 5_000 }).toBeGreaterThan(1000);
  });

  test('a write that does not compile shows the notice and does not reload', async ({ page: p }) => {
    skipUnlessLocal();
    const opened = streamOpened(p);
    await p.goto(`${urlOf(previewHost(app.slug))}/`);
    await expect(p.getByRole('heading', { name: 'Two' })).toBeVisible();
    await opened;
    await p.evaluate(() => {
      (window as unknown as { __stayed: boolean }).__stayed = true;
    });

    const broken = await callTool(mcp.client, 'write_files', {
      app_id: app.app_id,
      files: [{ path: 'drobek.json', content: JSON.stringify({ reload: 'sometimes' }) }],
      reasoning: 'A drobek.json that does not compile',
    });
    expect(broken.isError, JSON.stringify(broken.json)).toBe(false);
    expect((broken.json.compile as { ok: boolean }).ok).toBe(false);
    const failed = broken.json.version as number;

    const notice = p.locator('[data-drobek-preview][data-notice="compile-failed"]');
    await expect(notice).toBeVisible({ timeout: 10_000 });
    expect(await p.evaluate(() => (window as unknown as { __stayed?: boolean }).__stayed)).toBe(true);
    await expect(p.getByRole('heading', { name: 'Two' })).toBeVisible();
    expect(failed).toBeGreaterThan(version);
  });

  test('"reload": false drops the reload; the version host has no reload and production no script', async () => {
    skipUnlessLocal();
    const off = await callTool(mcp.client, 'write_files', {
      app_id: app.app_id,
      files: [{ path: 'drobek.json', content: JSON.stringify({ reload: false }) }],
      reasoning: 'Reload off',
    });
    expect(off.isError, JSON.stringify(off.json)).toBe(false);
    expect((off.json.compile as { ok: boolean }).ok).toBe(true);
    const offHtml = await hostRequest(previewHost(app.slug), '/');
    expect(offHtml.body).toContain('Two');
    expect(offHtml.body).toContain('/__drobek/preview.js');
    expect(offHtml.body).not.toContain('data-reload');

    const pinned = await hostRequest(versionHost(app.slug, version), '/');
    expect(pinned.status).toBe(200);
    expect(pinned.body).toContain(`<script src="/__drobek/preview.js" defer data-app="${app.slug}" data-version="${version}" data-errors></script>`);
    expect((await hostRequest(versionHost(app.slug, version), EVENTS_PATH)).status).toBe(404);

    const pub = await callTool(mcp.client, 'publish', { app_id: app.app_id, version });
    expect(pub.isError, JSON.stringify(pub.json)).toBe(false);
    const prod = await hostRequest(prodHost(app.slug), '/');
    expect(prod.status).toBe(200);
    expect(prod.body).not.toContain('/__drobek/preview.js');
    expect((await hostRequest(prodHost(app.slug), EVENTS_PATH)).status).toBe(404);
    expect((await hostRequest(prodHost(app.slug), '/__drobek/preview.js')).status).toBe(404);
  });

  test('framed as the app-list thumbnail, the preview never opens the stream', async ({ page: p, request }) => {
    skipUnlessLocal();
    const framed = (await callTool(mcp.client, 'create_app', { name: 'Reload thumb', template: 'html' })).json as unknown as Created;
    const w = await callTool(mcp.client, 'write_files', { app_id: framed.app_id, files: [{ path: 'index.html', content: page('Thumb') }], reasoning: 'Thumbnail' });
    expect(w.isError, JSON.stringify(w.json)).toBe(false);
    expect((await hostRequest(previewHost(framed.slug), '/')).body).toContain('data-reload');

    await loginViaEmail(p, request, mcp.email);
    const streams: Request[] = [];
    p.on('request', (r) => {
      if (new URL(r.url()).pathname === EVENTS_PATH) streams.push(r);
    });
    await p.goto(`${BASE_URL_WEB}/workspaces/${mcp.workspace}/apps`);
    const frame = p.locator(`[data-testid="app-thumb-frame"][src*="${previewHost(framed.slug)}"]`);
    await expect(frame).toBeAttached();
    await expect
      .poll(() => p.frames().some((f) => f.url().includes(previewHost(framed.slug))), { timeout: 10_000 })
      .toBe(true);
    const thumb = p.frames().find((f) => f.url().includes(previewHost(framed.slug)))!;
    await expect(thumb.getByRole('heading', { name: 'Thumb' })).toBeAttached();
    await p.waitForTimeout(2_000);
    expect(streams).toHaveLength(0);
  });
});
